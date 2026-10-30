/*
 * Copyright 2026 The Stepstone Group
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// @ts-check

/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  // ── ownership_scans ───────────────────────────────────────────────────────
  await knex.schema.createTable('ownership_scans', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at').nullable();
    table.integer('total_entities_scanned').notNullable().defaultTo(0);
    table.integer('new_issues_found').notNullable().defaultTo(0);
    table.integer('existing_issues_updated').notNullable().defaultTo(0);
    table.integer('issues_auto_resolved').notNullable().defaultTo(0);
    table
      .string('status')
      .notNullable()
      .defaultTo('running')
      .checkIn(
        ['running', 'completed', 'failed'],
        'ownership_scans_status_check',
      );
    table.text('error_message').nullable();
    table.integer('duration_ms').nullable();
  });

  // ── ownership_entities ────────────────────────────────────────────────────
  // One row per case. Multiple rows can exist for the same entity_ref
  // (one per historical ownership problem). Only one may be active at a time,
  // enforced by the partial unique index below.
  await knex.schema.createTable('ownership_entities', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table.string('entity_ref').notNullable();
    table.string('entity_name').notNullable();
    table.string('entity_kind').notNullable();
    table.string('entity_namespace').notNullable().defaultTo('default');
    // Populated for zombie cases — the dead group ref at detection time.
    table.string('current_owner').nullable();
    // Entity ref of whoever should act next on this case (proposed team while
    // pending, escalation actor while escalated, accepted team until owner
    // updated, null once closed).
    table.string('assigned_to').nullable();
    table.timestamp('first_detected_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('last_scanned_at').notNullable().defaultTo(knex.fn.now());
    table
      .string('current_status')
      .notNullable()
      .defaultTo('open')
      .checkIn(
        ['open', 'escalated', 'accepted', 'to_archive', 'closed', 'unresolved'],
        'ownership_entities_status_check',
      );
    // Highest-priority failing check driving proposals for this case.
    table.string('current_check').notNullable();
    table.json('check_details').nullable();
    // SCM-neutral repository identity, matching `ScmRepoRef`: `scm_type` is the
    // integration type (`bitbucketServer`, `gitlab`, ...), `repo_path` the
    // provider-native path (`PROJ/repo`, `group/sub/project`, ...). `repo_url`
    // is the repository's web URL shown in the UI.
    table.string('repo_url').nullable();
    table.string('scm_type').nullable();
    table.string('repo_host').nullable();
    table.string('repo_path').nullable();
    // Set when the case transitions to 'accepted'. Distinct from resolved_at,
    // which is only written on full close.
    table.timestamp('accepted_at').nullable();
    table.timestamp('resolved_at').nullable();
    table.string('resolved_by').nullable();
    table.string('resolution_type').nullable();
    // Optimistic concurrency counter.
    table.integer('version').notNullable().defaultTo(1);
    // catalog-info PR tracking. On proposal acceptance a `pr_creation` deadline
    // is enqueued; the worker that drains it opens a PR setting `spec.owner`
    // and records progress here. After the PR is raised a periodic
    // reconciliation pass compares the catalog's `spec.owner` with the accepted
    // owner, using `pr_id` to read the PR's state and `pr_checked_at` to
    // throttle itself.
    table
      .string('pr_status')
      .notNullable()
      .defaultTo('none')
      .checkIn(
        [
          'none',
          'pending',
          'raised',
          'failed',
          // No installed SCM provider can raise PRs for this repository host.
          'unsupported_scm',
          // Catalog owner matches the accepted team.
          'completed',
          // PR declined; retryable.
          'declined',
          // Someone else changed the owner.
          'superseded',
        ],
        'ownership_entities_pr_status_check',
      );
    table.text('pr_url').nullable();
    table.string('pr_branch').nullable();
    // Failed attempts since the last (re)enqueue.
    table.integer('pr_attempts').notNullable().defaultTo(0);
    // Human-readable reason of the last failure, for the UI.
    table.text('pr_last_error').nullable();
    // Provider-native PR id, so the PR's state can be read back.
    table.string('pr_id').nullable();
    table.timestamp('pr_checked_at').nullable();
  });

  // Partial unique index: only one active case per entity_ref at a time.
  // Raw SQL required because Knex does not support WHERE clauses on indexes.
  await knex.raw(`
    CREATE UNIQUE INDEX ownership_entities_active_case_idx
      ON ownership_entities (entity_ref)
      WHERE current_status IN ('open', 'escalated', 'to_archive', 'accepted', 'unresolved')
  `);

  // ── ownership_proposals ───────────────────────────────────────────────────
  await knex.schema.createTable('ownership_proposals', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table
      .uuid('entity_id')
      .notNullable()
      .references('id')
      .inTable('ownership_entities')
      .onDelete('CASCADE');
    table.string('proposed_owner_ref').notNullable();
    // 'team' for group: refs, 'user' for user: refs (derived from ref prefix).
    table
      .string('proposed_owner_type')
      .notNullable()
      .defaultTo('team')
      .checkIn(['team', 'user'], 'ownership_proposals_owner_type_check');
    // Human-readable reason: top_contributor, org_proximity, fallback
    table.string('confidence_reason').notNullable();
    table.float('confidence_score').nullable();
    table.integer('proposal_order').notNullable().defaultTo(1);
    table
      .string('status')
      .notNullable()
      .defaultTo('pending')
      .checkIn(
        [
          'queued',
          'pending',
          'accepted',
          'rejected',
          'expired',
          'cancelled',
          // Candidate below the configured notificationThreshold: offered for
          // voluntary claiming in the UI instead of being notified.
          'possible_owner',
        ],
        'ownership_proposals_status_check',
      );
    table.integer('escalation_level').notNullable().defaultTo(0);
    table.timestamp('notified_at').nullable();
    table.timestamp('responded_at').nullable();
    table.text('response_note').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  // Partial unique index: no duplicate active proposals for the same
  // entity + owner pair. The code no longer writes the `queued` proposal
  // status; it stays in this index and in the CHECK constraint above so
  // existing schemas need no migration.
  await knex.raw(`
    CREATE UNIQUE INDEX ownership_proposals_active_idx
      ON ownership_proposals (entity_id, proposed_owner_ref)
      WHERE status IN ('queued', 'pending')
  `);

  // ── ownership_history ─────────────────────────────────────────────────────
  // Immutable append-only audit log.
  await knex.schema.createTable('ownership_history', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table
      .uuid('entity_id')
      .notNullable()
      .references('id')
      .inTable('ownership_entities')
      .onDelete('CASCADE');
    table
      .uuid('proposal_id')
      .nullable()
      .references('id')
      .inTable('ownership_proposals')
      .onDelete('SET NULL');
    table
      .uuid('scan_id')
      .nullable()
      .references('id')
      .inTable('ownership_scans')
      .onDelete('SET NULL');
    table.string('action').notNullable();
    table.string('actor').nullable();
    table.json('details').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index('entity_id', 'ownership_history_entity_id_idx');
  });

  // ── pending_deadlines ──────────────────────────────────────────────────────
  // Hot read path:
  //   SELECT ... WHERE fire_at <= NOW() AND processed = false
  await knex.schema.createTable('pending_deadlines', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table
      .uuid('entity_id')
      .notNullable()
      .references('id')
      .inTable('ownership_entities')
      .onDelete('CASCADE');
    table
      .uuid('proposal_id')
      .nullable()
      .references('id')
      .inTable('ownership_proposals')
      .onDelete('SET NULL');
    table.string('deadline_type').notNullable();
    table.timestamp('fire_at').notNullable();
    table.string('actor_ref').nullable();
    table.integer('escalation_level').nullable();
    table.boolean('processed').notNullable().defaultTo(false);
    table.timestamp('processed_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    CREATE INDEX pending_deadlines_fire_at_idx
      ON pending_deadlines (fire_at)
      WHERE processed = false
  `);

  // ── escalation_queue_entries ───────────────────────────────────────────────
  // Composite (entity_id, status, position) index
  // covers the activateNextEntry hot path.
  await knex.schema.createTable('escalation_queue_entries', table => {
    table.uuid('id').notNullable().primary().defaultTo(knex.fn.uuid());
    table
      .uuid('entity_id')
      .notNullable()
      .references('id')
      .inTable('ownership_entities')
      .onDelete('CASCADE');
    table.string('group_ref').notNullable();
    table.integer('escalation_level').notNullable();
    table.integer('position').notNullable();
    table.string('status').notNullable().defaultTo('queued');
    table.string('resolved_actor_ref').nullable();
    table.text('skip_reason').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(
      ['entity_id', 'status', 'position'],
      'escalation_queue_entries_entity_status_position_idx',
    );
  });

  // Partial UNIQUE: only one active row per (entity, level, position) at a
  // time. Closed/skipped rows stay (audit trail). Postgres + SQLite both
  // support `CREATE UNIQUE INDEX ... WHERE` via raw SQL.
  await knex.raw(`
    CREATE UNIQUE INDEX escalation_queue_entries_active_position_uniq
    ON escalation_queue_entries (entity_id, escalation_level, position)
    WHERE status IN ('queued', 'active')
  `);

  // Backs the leadership Escalations lookup: "which entities is this user the
  // active escalation actor for?". The correlated side of that EXISTS is
  // already covered by the composite index above.
  await knex.raw(`
    CREATE INDEX escalation_queue_entries_active_actor_idx
      ON escalation_queue_entries (resolved_actor_ref)
      WHERE status = 'active'
  `);

  // ── ownership_email_sends ──────────────────────────────────────────────────
  // Idempotency ledger for the ownership email digest job. One row per
  // (team_ref, period_key) means re-running the job within the same period does
  // not resend. period_key is "YYYY-MM" for monthly schedules, "YYYY-WW" for
  // weekly/daily ones.
  await knex.schema.createTable('ownership_email_sends', table => {
    table.uuid('id').primary().defaultTo(knex.fn.uuid());
    table.string('team_ref').notNullable();
    table
      .string('period_key', 10)
      .notNullable()
      .comment('Format: YYYY-MM or YYYY-WW');
    table.timestamp('sent_at').notNullable();
    table.unique(['team_ref', 'period_key']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ownership_email_sends');
  await knex.schema.dropTableIfExists('escalation_queue_entries');
  await knex.schema.dropTableIfExists('pending_deadlines');
  await knex.schema.dropTableIfExists('ownership_history');
  await knex.schema.dropTableIfExists('ownership_proposals');
  await knex.schema.dropTableIfExists('ownership_entities');
  await knex.schema.dropTableIfExists('ownership_scans');
};
