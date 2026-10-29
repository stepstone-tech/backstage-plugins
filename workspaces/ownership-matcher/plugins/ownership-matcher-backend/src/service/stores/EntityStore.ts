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

import { ConflictError } from '@backstage/errors';
import { Knex } from 'knex';
import type { ScmRepoRef } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  OwnershipEntityRow,
  PrStatus,
  repoColumns,
  ResolutionType,
  PaginationOptions,
  PaginatedResult,
} from '../../types';
import { CreateEntityInput, EntityFilter } from '../DatabaseOwnershipStore';

/** Columns writable through {@link EntityStore.updatePrState}. */
export interface PrStatePatch {
  pr_status?: PrStatus;
  pr_url?: string | null;
  pr_branch?: string | null;
  pr_attempts?: number;
  pr_last_error?: string | null;
  pr_id?: string | null;
  pr_checked_at?: Date | null;
}

/** Persistence facade for `ownership_entities`. */
export class EntityStore {
  constructor(private readonly db: Knex) {}

  async createEntity(input: CreateEntityInput): Promise<string> {
    const [row] = await this.db('ownership_entities')
      .insert({
        entity_ref: input.entity_ref,
        entity_name: input.entity_name,
        entity_kind: input.entity_kind,
        entity_namespace: input.entity_namespace,
        current_owner: input.current_owner ?? null,
        current_status: 'open',
        current_check: input.current_check,
        check_details: input.check_details
          ? JSON.stringify(input.check_details)
          : null,
        ...(input.repo ? repoColumns(input.repo) : {}),
        first_detected_at: new Date(),
        last_scanned_at: new Date(),
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async updateEntityLastScanned(
    id: string,
    _scanId: string,
    repo?: ScmRepoRef,
  ): Promise<void> {
    await this.db('ownership_entities')
      .where({ id })
      .update({
        last_scanned_at: new Date(),
        ...(repo ? repoColumns(repo) : {}),
      });
  }

  private async assertRowsAffected(rows: number, id: string): Promise<void> {
    if (rows === 0) {
      throw new ConflictError(
        `Entity ${id} was modified concurrently (version mismatch)`,
      );
    }
  }

  async acceptEntity(
    id: string,
    acceptedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ): Promise<void> {
    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'accepted',
        resolved_by: acceptedBy,
        resolution_type: resolutionType,
        accepted_at: new Date(),
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  async updateAssignee(id: string, assignedTo: string | null): Promise<void> {
    // `assigned_to` is metadata only — no concurrency check (design
    // note: an assignee change cannot violate state-machine invariants on its
    // own; status-mutating methods carry the version guard).
    await this.db('ownership_entities')
      .where({ id })
      .update({ assigned_to: assignedTo });
  }

  /**
   * Update the catalog-info PR tracking columns. Deliberately
   * leaves `version` untouched: PR progress is metadata and must not race the
   * acceptance/grace state-machine transitions guarded by the version column.
   */
  async updatePrState(id: string, patch: PrStatePatch): Promise<void> {
    await this.db('ownership_entities').where({ id }).update(patch);
  }

  /**
   * {@link updatePrState}, but only while `pr_status` is still `expected` —
   * so reconciliation never overwrites a PR job that started in the meantime.
   * Returns whether the row was updated.
   */
  async updatePrStateIf(
    id: string,
    expected: PrStatus,
    patch: PrStatePatch,
  ): Promise<boolean> {
    const rows = await this.db('ownership_entities')
      .where({ id, pr_status: expected })
      .update(patch);
    return rows > 0;
  }

  /**
   * Cases whose catalog-info PR outcome is still open: accepted
   * ones not reconciled since `checkedBefore`, with no PR, a raised one, or
   * one that `failed` / was `declined` / hit `unsupported_scm` (the owner may
   * have been fixed by hand, or changed by someone else), plus cases the scan
   * closed as `ownership_changed` after acceptance in one of those PR states —
   * unless a newer case exists for the same entity, whose outcome today's
   * catalog owner belongs to. A closed case is reconciled once after it
   * closed (`pr_checked_at` before `resolved_at`): whatever that check found —
   * including an entity gone from the catalog — is final. The scan closes
   * pending/escalated/unresolved cases as `ownership_changed` too; never
   * accepted, they have no PR outcome. Only `pending` (a job is running) and
   * the terminal `completed`/`superseded` are left alone.
   */
  async listEntitiesForPrReconciliation(
    checkedBefore: Date,
  ): Promise<OwnershipEntityRow[]> {
    const unresolved: PrStatus[] = [
      'none',
      'raised',
      'failed',
      'declined',
      'unsupported_scm',
    ];
    const db = this.db;
    return db('ownership_entities as e')
      .select('e.*')
      .whereIn('e.pr_status', unresolved)
      .where(q =>
        q
          .where(a =>
            a
              .where('e.current_status', 'accepted')
              .where(c =>
                c
                  .whereNull('e.pr_checked_at')
                  .orWhere('e.pr_checked_at', '<', checkedBefore),
              ),
          )
          .orWhere(c =>
            c
              .where('e.current_status', 'closed')
              .where('e.resolution_type', 'ownership_changed')
              .whereNotNull('e.accepted_at')
              .whereNotExists(function newerCase() {
                this.select(db.raw('1'))
                  .from('ownership_entities as newer')
                  .whereRaw('newer.entity_ref = e.entity_ref')
                  .whereRaw('newer.first_detected_at > e.first_detected_at');
              })
              .where(d =>
                d
                  .whereNull('e.pr_checked_at')
                  .orWhere('e.pr_checked_at', '<', db.ref('e.resolved_at')),
              ),
          ),
      );
  }

  /**
   * `pr_status` counts over every case that reached acceptance — still
   * accepted, or closed as `ownership_changed` — for the "loop closed" KPI.
   */
  async countPrStatusesForAccepted(): Promise<
    Partial<Record<PrStatus, number>>
  > {
    const rows = await this.db('ownership_entities')
      .whereNotNull('accepted_at')
      .where(q =>
        q
          .where('current_status', 'accepted')
          .orWhere(c =>
            c
              .where('current_status', 'closed')
              .where('resolution_type', 'ownership_changed'),
          ),
      )
      .select('pr_status')
      .count<{ pr_status: PrStatus; count: string | number }[]>('id as count')
      .groupBy('pr_status');
    return Object.fromEntries(rows.map(r => [r.pr_status, Number(r.count)]));
  }

  async reopenEntity(id: string, expectedVersion: number): Promise<void> {
    const row = await this.db('ownership_entities')
      .where({ id })
      .first<{ entity_ref: string }>();
    if (!row) return;

    // A newer scan may have already created a fresh active row for the same
    // entity_ref. If one exists, closing the old row is correct — the issue
    // is already being tracked on the newer row.
    const conflict = await this.db('ownership_entities')
      .where('entity_ref', row.entity_ref)
      .whereNot({ id })
      .whereIn('current_status', ['open', 'escalated', 'to_archive'])
      .first<{ id: string }>();

    if (conflict) {
      const closedRows = await this.db('ownership_entities')
        .where({ id, version: expectedVersion })
        .update({
          current_status: 'closed',
          resolved_by: null,
          resolution_type: null,
          accepted_at: null,
          version: expectedVersion + 1,
        });
      await this.assertRowsAffected(closedRows, id);
      return;
    }

    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'open',
        resolved_by: null,
        resolution_type: null,
        accepted_at: null,
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  async markEntityToArchive(
    id: string,
    markedBy: string,
    assigneeRef: string,
    expectedVersion: number,
  ): Promise<void> {
    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'to_archive',
        resolved_by: markedBy,
        assigned_to: assigneeRef,
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  async closeEntity(
    id: string,
    closedBy: string,
    resolutionType: ResolutionType,
    expectedVersion: number,
  ): Promise<void> {
    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'closed',
        resolved_at: new Date(),
        resolved_by: closedBy,
        resolution_type: resolutionType,
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  async setEntityEscalated(id: string, expectedVersion: number): Promise<void> {
    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'escalated',
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  /** Transition an entity to `unresolved`. */
  async setEntityUnresolved(
    id: string,
    expectedVersion: number,
  ): Promise<void> {
    const rows = await this.db('ownership_entities')
      .where({ id, version: expectedVersion })
      .update({
        current_status: 'unresolved',
        version: expectedVersion + 1,
      });
    await this.assertRowsAffected(rows, id);
  }

  /** Returns the single active case for a given entity ref, if any. */
  async getActiveEntityByRef(
    entityRef: string,
  ): Promise<OwnershipEntityRow | undefined> {
    return this.db('ownership_entities')
      .where({ entity_ref: entityRef })
      .whereIn('current_status', [
        'open',
        'escalated',
        'accepted',
        'to_archive',
        'unresolved',
      ])
      .first();
  }

  /** Like {@link getEntityById} but row-locks the entity (FOR UPDATE) for the rest of the transaction. */
  async getEntityByIdForUpdate(
    id: string,
  ): Promise<OwnershipEntityRow | undefined> {
    return this.db('ownership_entities').where({ id }).forUpdate().first();
  }

  async getEntityById(id: string): Promise<OwnershipEntityRow | undefined> {
    return this.db('ownership_entities').where({ id }).first();
  }

  async getStats(): Promise<{
    totalOpen: number;
    perCheck: Record<string, number>;
  }> {
    const rows = await this.db('ownership_entities')
      .whereIn('current_status', ['open', 'escalated', 'to_archive'])
      .select('current_check')
      .count<{ current_check: string; count: string | number }[]>('id as count')
      .groupBy('current_check');

    const perCheck: Record<string, number> = {};
    let totalOpen = 0;
    for (const row of rows) {
      const count = Number(row.count);
      perCheck[row.current_check] = count;
      totalOpen += count;
    }
    return { totalOpen, perCheck };
  }

  async getStatsForOwners(
    owners: string[],
    escalationActorRef?: string,
  ): Promise<{ totalOpen: number; perCheck: Record<string, number> }> {
    if (owners.length === 0 && !escalationActorRef) {
      return { totalOpen: 0, perCheck: {} };
    }

    let query = this.db('ownership_entities').whereIn('current_status', [
      'open',
      'escalated',
      'unresolved',
    ]);
    query = escalationActorRef
      ? query.where(qb =>
          this.whereOwnedOrEscalatedTo(qb, owners, escalationActorRef),
        )
      : query.whereIn('current_owner', owners);

    const rows = await query
      .select('current_check')
      .count<{ current_check: string; count: string | number }[]>('id as count')
      .groupBy('current_check');

    const perCheck: Record<string, number> = {};
    let totalOpen = 0;
    for (const row of rows) {
      const count = Number(row.count);
      perCheck[row.current_check] = count;
      totalOpen += count;
    }
    return { totalOpen, perCheck };
  }

  async countActiveEscalationsForActor(actorRef: string): Promise<number> {
    const [{ count }] = await this.db('escalation_queue_entries')
      .where({ status: 'active', resolved_actor_ref: actorRef })
      .count('id as count');
    return Number(count);
  }

  /**
   * Leadership scoping: non-escalated entities match on `current_owner`,
   * escalated ones only when `actorRef` holds the active queue entry. EXISTS
   * (not a JOIN) so an entity with several active entries is returned once.
   */
  private whereOwnedOrEscalatedTo(
    qb: Knex.QueryBuilder,
    owners: string[],
    actorRef: string,
  ): void {
    if (owners.length > 0) {
      qb.where(q =>
        q
          .whereNot('current_status', 'escalated')
          .whereIn('current_owner', owners),
      );
    }
    qb.orWhere(q =>
      q
        .where('current_status', 'escalated')
        .whereExists(
          this.db('escalation_queue_entries as q')
            .select(this.db.raw('1'))
            .where('q.entity_id', this.db.ref('ownership_entities.id'))
            .where({ 'q.status': 'active', 'q.resolved_actor_ref': actorRef }),
        ),
    );
  }

  /**
   * Returns every entity row whose status is still actionable. Used by the
   * end-of-scan reconciliation pass to close cases that fell out of scope
   * (kind/namespace/owner exclusion, or a check that got disabled) — those
   * entities are no longer yielded by the catalog iterator, so the normal
   * auto-resolve path can't see them.
   *
   * `to_archive` is intentionally excluded: it's a deletion track with its own
   * grace window, and resurrecting it as `out_of_scope` would destroy work.
   * `accepted` is included so that reconciliation can detect when an accepted
   * entity has been removed from the catalog entirely and close the case.
   */
  async listActiveEntitiesForReconciliation(): Promise<OwnershipEntityRow[]> {
    return this.db('ownership_entities').whereIn('current_status', [
      'open',
      'escalated',
      'unresolved',
      'accepted',
    ]);
  }

  async listEntities(
    filter?: EntityFilter,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<OwnershipEntityRow>> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 50;
    const offset = (page - 1) * limit;

    let query = this.db('ownership_entities');

    if (filter?.status) {
      const statuses = Array.isArray(filter.status)
        ? filter.status
        : [filter.status];
      query = query.whereIn('current_status', statuses);
    }
    if (filter?.kind) {
      query = query.where({ entity_kind: filter.kind });
    }
    if (filter?.namespace) {
      query = query.where({ entity_namespace: filter.namespace });
    }
    if (filter?.check) {
      query = query.where({ current_check: filter.check });
    }
    if (filter?.assignedTo) {
      query = query.where({ assigned_to: filter.assignedTo });
    }
    if (filter?.escalationActorRef) {
      const actorRef = filter.escalationActorRef;
      query = query.where(qb =>
        this.whereOwnedOrEscalatedTo(qb, filter.owners ?? [], actorRef),
      );
    } else if (filter?.owners && filter.owners.length > 0) {
      query = query.whereIn('current_owner', filter.owners);
    }

    const [{ count }] = await query.clone().count('id as count');
    const total = Number(count);

    const items = await query
      .orderBy('first_detected_at', 'desc')
      .limit(limit)
      .offset(offset);

    return { items, total, page, limit };
  }
}
