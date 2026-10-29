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

import { LoggerService } from '@backstage/backend-plugin-api';
import { ConflictError, InputError, NotFoundError } from '@backstage/errors';
import {
  OwnershipMatcherService,
  ScanEntityResult,
} from '../service/OwnershipMatcherService';
import {
  CandidateSourcesUnavailableError,
  ProposalGenerationService,
} from '../service/ProposalGenerationService';
import { EscalationConfig } from '../config/types';
import { OwnershipStore, TxStores } from '../service/DatabaseOwnershipStore';
import {
  CatalogServiceExtensions,
  DefaultActorResolver,
  GroupFilter,
  matchesGroupFilter,
  parseGroupFilter,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { Clock } from './Clock';
import type { PrCreationTrigger } from '../pr';
import {
  ArchiveResult,
  AssignResult,
  EscalationLevelRef,
  EscalationQueueEntryRow,
  RejectResult,
  RetriggerResult,
  RevalidateQueueResult,
  SuggestResult,
} from './types';
import {
  EntityStatus,
  OwnershipEntityRow,
  OwnershipProposalRow,
  toOwnershipEntity,
} from '../types';
import { EventsService } from '@backstage/plugin-events-node';
import {
  ArchivePendingEventPayload,
  EscalationAssignedEventPayload,
  NotificationsTopic,
} from '../service/notifications/topics';

const MS_PER_DAY = 86_400_000;

/** Statuses where {@link DefaultEscalationService.triggerEscalation} is a no-op. */
const TRIGGER_IDEMPOTENT_STATUSES: ReadonlySet<EntityStatus> = new Set([
  'escalated',
  'closed',
  'accepted',
  'to_archive',
  'unresolved',
]);

/** Statuses on which the terminal actions `escalationAssign` / `escalationArchive` may run. */
const RESOLVABLE_STATUSES: ReadonlySet<EntityStatus> = new Set([
  'escalated',
  'unresolved',
]);

/** Postgres SQLSTATE `23505` (typed `error.code`) and SQLite `SQLITE_CONSTRAINT_UNIQUE` (message-substring fallback) both surface here when a concurrent trigger tries to write the same queue row. */
function isUniqueViolation(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  ) {
    return true;
  }
  return String(error).includes('SQLITE_CONSTRAINT_UNIQUE');
}

/** Business-logic contract for the escalation feature. */
export interface EscalationService {
  /** Move an entity to its post-proposal state (escalated / unresolved). */
  triggerEscalation(entityId: string): Promise<void>;

  /** Compute the BFS-ordered group refs for an entity's escalation queue. */
  buildBfsQueue(
    entityId: string,
    excluded: ReadonlySet<string>,
  ): Promise<{ groupRef: string; level: number; position: number }[]>;

  /** Activate the next queued entry; returns null when the queue is exhausted. */
  activateNextEntry(entityId: string): Promise<EscalationLevelRef | null>;

  /** Tx-scoped {@link activateNextEntry}; honours `exhaustToUnresolved`. */
  advanceQueue(
    stores: TxStores,
    entityId: string,
    exhaustToUnresolved: boolean,
  ): Promise<EscalationLevelRef | null>;

  /** Re-validate the queue against the live catalog after a reorg. */
  revalidateQueue(entityId: string): Promise<RevalidateQueueResult>;

  /** Resolve the actor user-ref for a group at the given escalation level. */
  resolveActorForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string | undefined>;

  /**
   * Like {@link EscalationService.resolveActorForGroup} but returns ALL
   * title-matching members (deduped by userRef), not just the first. Shares
   * the compiled `titlePatterns` + manager-chain engine.
   */
  resolveAllActorsForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string[]>;

  /** Reject at escalation level; advances queue or exhausts to unresolved. */
  escalationReject(
    entityId: string,
    actorRef: string,
    reason: string,
  ): Promise<RejectResult>;

  /** Assign a team; arms grace deadlines and flips entity to accepted. */
  escalationAssign(
    entityId: string,
    ownerRef: string,
    actorRef: string,
  ): Promise<AssignResult>;

  /** Tag entity for archival; arms grace deadlines on the assignee team. */
  escalationArchive(
    entityId: string,
    assigneeRef: string,
    actorRef: string,
  ): Promise<ArchiveResult>;

  /** Create a new proposal for a suggested team; pauses escalation timeout. */
  escalationSuggest(
    entityId: string,
    suggestedOwnerRef: string,
    reason: string,
    actorRef: string,
  ): Promise<SuggestResult>;

  /** Restart an `unresolved` case from scratch. */
  escalationRetrigger(
    entityId: string,
    actorRef: string,
    scanResult?: ScanEntityResult,
  ): Promise<RetriggerResult>;
}

/** Concrete implementation of {@link EscalationService}. */
export class DefaultEscalationService implements EscalationService {
  /**
   * Actor-resolution engine (title-pattern / manager-chain matching). Extracted
   * to the shared node library and composed here; both `resolve*ForGroup`
   * methods delegate to it. Also owns the per-level compiled `titlePatterns`.
   */
  private readonly actorResolver: DefaultActorResolver;

  constructor(
    private readonly store: OwnershipStore,
    private readonly catalog: CatalogServiceExtensions,
    private readonly config: EscalationConfig,
    private readonly clock: Clock,
    _scanner: OwnershipMatcherService,
    /** generator is required (not duck-typed) so a missing dependency is a compile-time error rather than a silent violation. */
    private readonly proposalGenerator: ProposalGenerationService,
    private readonly logger: LoggerService,
    private readonly events?: EventsService,
    /**
     * When supplied, `escalationAssign` enqueues a `pr_creation` job so the
     * assigned owner lands in catalog-info.yaml, mirroring proposal acceptance.
     */
    private readonly prCreationTrigger?: PrCreationTrigger,
  ) {
    this.actorResolver = new DefaultActorResolver(catalog, config, logger);
  }

  /** Tx-scoped activation of the next BFS queue entry. */
  async advanceQueue(
    stores: TxStores,
    entityId: string,
    exhaustToUnresolved: boolean,
  ): Promise<EscalationLevelRef | null> {
    return this.activateNext(stores, entityId, exhaustToUnresolved);
  }

  /** {@inheritdoc EscalationService.triggerEscalation} */
  async triggerEscalation(entityId: string): Promise<void> {
    // Three branches:
    // - no proposals at all → entity → unresolved + `no_candidates_found`
    // - a pending proposal remains → no escalation yet
    // - all proposals exhausted → entity → escalated; build BFS queue;
    // activate next. An empty BFS plan → unresolved + `no_escalation_path`
    // instead, since an escalated case with no queue never moves again.
    //
    // The catalog HTTP for branch 3 happens **outside** the transaction so
    // the DB lock window stays tight (BLOCKER 1). Idempotency
    // pre-checks short-circuit work for entities already past `open` so a
    // double-trigger (scanner re-detection + proposal-reject racing) doesn't
    // double-write history rows or activate the queue twice (BLOCKER 2).
    if ((this.config.levels?.length ?? 0) === 0) {
      throw new InputError(
        `[escalation] triggerEscalation invoked with empty levels — config validation should have rejected this`,
      );
    }

    // Idempotency pre-check (cheap, no tx). Status is re-verified inside
    // the tx before any write — see branches below.
    const initial = await this.store.getEntityById(entityId);
    if (!initial) return;
    if (TRIGGER_IDEMPOTENT_STATUSES.has(initial.current_status)) {
      this.logger.debug(
        `[escalation] triggerEscalation no-op for ${entityId}: status=${initial.current_status}`,
      );
      return;
    }

    // Classify (no HTTP yet). Exclude `possible_owner` rows: they are
    // low-confidence candidates that were never notified and must not count as
    // live proposals for the escalation decision (broadcast persists
    // them on every scan, so they are almost always present).
    const allRows = await this.store.listProposalsByEntity(entityId);
    const proposals = allRows.filter(p => p.status !== 'possible_owner');

    // Branch 1: no (non-possible_owner) proposals → unresolved +
    // `no_candidates_found`.
    if (proposals.length === 0) {
      await this.store.withTransaction(async stores => {
        const entity = await stores.entityStore.getEntityById(entityId);
        if (!entity) return;
        if (entity.current_status === 'unresolved') return;
        await stores.entityStore.setEntityUnresolved(entity.id, entity.version);
        await stores.entityStore.updateAssignee(entity.id, null);
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'no_candidates_found',
          actor: 'system',
          details: {
            reason: allRows.some(p => p.status === 'possible_owner')
              ? 'only_possible_owners'
              : 'no_proposals_generated',
          },
        });
      });
      return;
    }

    // Branch 2: a pending proposal still exists, escalation hasn't fired yet.
    if (proposals.some(p => p.status === 'pending')) return;

    // Branch 3: all proposals exhausted → escalate.
    // Compute the BFS plan **outside** the tx so catalog HTTP latency does
    // not hold a row lock open. HTTP errors propagate; the next trigger
    // (next scan, or operator retrigger) re-runs.
    const queuePlan = await this.computeQueuePlan(
      entityId,
      proposals,
      new Set(),
    );

    await this.store.withTransaction(async stores => {
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) return;

      // Empty BFS plan: no escalation actor exists. Park the case in the
      // Unresolved tab, where a later scan can self-heal it. Only from `open`,
      // so a concurrent caller's non-`open` status is left alone.
      if (entity.current_status === 'open' && queuePlan.length === 0) {
        await this.markEntityUnresolved(stores, entityId, 'no_escalation_path');
        this.logger.info(
          `[escalation] entity ${entityId} unresolved — empty BFS queue, no live ancestors found`,
        );
        return;
      }

      if (entity.current_status === 'escalated') {
        // Another caller already wrote the flip + history. Still attempt
        // the queue insert + activate so the second caller can no-op via
        // the partial UNIQUE collision rather than losing the activation.
        // (The activate guard handles already-active queue heads.)
      } else if (entity.current_status === 'open') {
        try {
          await stores.entityStore.setEntityEscalated(
            entity.id,
            entity.version,
          );
          await stores.historyStore.appendHistory({
            entity_id: entityId,
            action: 'escalation_triggered',
            actor: 'system',
            details: { reason: 'candidates_exhausted' },
          });
        } catch (error) {
          // flipped this entity to `escalated`. Fall through to the queue
          // insert; the partial UNIQUE catches duplicate rows.
          if (!(error instanceof ConflictError)) throw error;
          this.logger.debug(
            `[escalation] version conflict on ${entityId} — already escalated by concurrent caller`,
          );
        }
      } else {
        this.logger.debug(
          `[escalation] skipping flip-to-escalated for ${entityId}: status=${entity.current_status}`,
        );
        return;
      }

      if (queuePlan.length === 0) return;

      // Insert queue rows. Partial UNIQUE on
      // `(entity_id, escalation_level, position) WHERE status IN ('queued','active')`
      // catches concurrent dup inserts from a racing caller.
      try {
        await this.insertQueuePlan(stores, entityId, queuePlan);
      } catch (error) {
        if (isUniqueViolation(error)) {
          this.logger.info(
            `[escalation] BFS queue already populated for ${entityId} by concurrent trigger`,
          );
          return;
        }
        throw error;
      }
      await this.activateNext(stores, entityId);
    });
  }

  /** {@inheritdoc EscalationService.buildBfsQueue} */
  async buildBfsQueue(
    entityId: string,
    excluded: ReadonlySet<string>,
  ): Promise<{ groupRef: string; level: number; position: number }[]> {
    // Catalog HTTP runs first so the tx only owns the writes (
    // BLOCKER 1). Public callers (retrigger flow at line 1488) get the same
    // contract: the returned rows are exactly the rows we inserted.
    const proposals = await this.store.listProposalsByEntity(entityId);
    const plan = await this.computeQueuePlan(entityId, proposals, excluded);
    if (plan.length === 0) return [];
    await this.store.withTransaction(async stores =>
      this.insertQueuePlan(stores, entityId, plan),
    );
    return plan;
  }

  private async computeQueuePlan(
    _entityId: string,
    proposals: OwnershipProposalRow[],
    excluded: ReadonlySet<string>,
  ): Promise<{ groupRef: string; level: number; position: number }[]> {
    const levels = this.config.levels ?? [];
    if (levels.length === 0) return [];

    const filters: (GroupFilter | null)[] = levels.map(l =>
      parseGroupFilter(l.groupFilter),
    );

    const perLevel: Map<string, number>[] = levels.map(
      () => new Map<string, number>(),
    );

    // `possible_owner` rows are low-confidence candidates that were never
    // notified (broadcast persists them on every scan). They must not
    // seed the BFS escalation queue — escalation is built from the teams that
    // actually received and exhausted a proposal, not from voluntary-claim
    // candidates.
    const escalatable = proposals.filter(p => p.status !== 'possible_owner');

    for (const proposal of escalatable) {
      const teamRef = proposal.proposed_owner_ref;
      const score = proposal.confidence_score ?? 0;
      const ancestors = await this.catalog.walkGroupHierarchy(teamRef, 'up');
      for (let i = 0; i < levels.length; i++) {
        const filter = filters[i];
        if (!filter) continue;
        const match = ancestors.find(a => matchesGroupFilter(a, filter));
        if (!match) continue;
        const prev = perLevel[i].get(match.ref);
        if (prev === undefined || score > prev) {
          perLevel[i].set(match.ref, score);
        }
      }
    }

    const rows: { groupRef: string; level: number; position: number }[] = [];
    let position = 1;
    for (let i = 0; i < levels.length; i++) {
      const ordered = [...perLevel[i].entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
      });
      for (const [groupRef] of ordered) {
        if (excluded.has(groupRef)) continue;
        rows.push({ groupRef, level: i + 1, position });
        position++;
      }
    }
    return rows;
  }

  private async insertQueuePlan(
    stores: TxStores,
    entityId: string,
    plan: { groupRef: string; level: number; position: number }[],
  ): Promise<void> {
    for (const row of plan) {
      await stores.escalationQueueStore.insertEntry({
        entity_id: entityId,
        group_ref: row.groupRef,
        escalation_level: row.level,
        position: row.position,
      });
    }
  }

  /** {@inheritdoc EscalationService.activateNextEntry} */
  async activateNextEntry(
    entityId: string,
  ): Promise<EscalationLevelRef | null> {
    return this.store.withTransaction(async stores =>
      this.activateNext(stores, entityId),
    );
  }

  private async activateNext(
    stores: TxStores,
    entityId: string,
    exhaustToUnresolved = true,
  ): Promise<EscalationLevelRef | null> {
    //
    // Loop bound is the queue depth — the recursion the prompt describes is
    // unrolled here for clarity.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const queued = await stores.escalationQueueStore.listQueuedEntries(
        entityId,
      );
      if (queued.length === 0) {
        if (exhaustToUnresolved) {
          await this.markEntityUnresolved(
            stores,
            entityId,
            'all_escalation_paths',
          );
        }
        return null;
      }

      const next = queued[0];
      const nextLevelConfig = this.config.levels?.[next.escalation_level - 1];
      const nextTeamRefs = nextLevelConfig?.managerChain
        ? await this.getEscalatableTeamRefs(entityId)
        : undefined;
      const actorRef = await this.resolveActorForGroup(
        next.group_ref,
        next.escalation_level,
        nextTeamRefs,
      );

      if (!actorRef) {
        await this.skipUnresolvableEntry(stores, entityId, next);
        continue;
      }

      // Promote queue entry to `active` and snapshot the actor ref.
      const activated = await stores.escalationQueueStore.activateNextEntry(
        entityId,
        actorRef,
      );
      if (!activated) {
        // Race-shouldn't-happen: listQueuedEntries returned a row but
        // activateNextEntry could not locate one. Treat as exhausted.
        await this.markEntityUnresolved(
          stores,
          entityId,
          'all_escalation_paths',
        );
        return null;
      }

      const entity = await this.recordActivation(
        stores,
        entityId,
        activated,
        actorRef,
      );
      await this.publishEscalationAssigned(
        entityId,
        entity,
        activated,
        actorRef,
      );

      return {
        groupRef: activated.group_ref,
        actorRef,
        level: activated.escalation_level,
      };
    }
  }

  /** No actor resolves for the next queued group: skip it and record why. */
  private async skipUnresolvableEntry(
    stores: TxStores,
    entityId: string,
    next: EscalationQueueEntryRow,
  ): Promise<void> {
    await stores.escalationQueueStore.markEntrySkipped(
      next.id,
      'no_actor_resolvable',
    );
    await stores.historyStore.appendHistory({
      entity_id: entityId,
      action: 'escalation_queue_entry_skipped',
      actor: 'system',
      details: {
        groupRef: next.group_ref,
        level: next.escalation_level,
        reason: 'no_actor_resolvable',
      },
    });
    // `skipped: true` so consumers reading the notification stream
    // (audit, expects a notification stream entry per skip)
    // see every level's outcome including no-actor skips.
    await stores.historyStore.appendHistory({
      entity_id: entityId,
      action: 'escalation_notified',
      actor: 'system',
      details: {
        groupRef: next.group_ref,
        level: next.escalation_level,
        skipped: true,
        reason: 'no_matching_actor',
      },
    });
  }

  /**
   * Persist an activated queue entry: ensure the entity is `escalated`, write
   * the timeout deadline (so the deadline checker can auto-advance), and
   * record the resolution in history. Returns the entity for notification.
   */
  private async recordActivation(
    stores: TxStores,
    entityId: string,
    activated: EscalationQueueEntryRow,
    actorRef: string,
  ): Promise<OwnershipEntityRow | undefined> {
    const entity = await stores.entityStore.getEntityById(entityId);
    if (entity && entity.current_status !== 'escalated') {
      await stores.entityStore.setEntityEscalated(entity.id, entity.version);
    }
    // assigned_to tracks whoever acts next: the escalation actor (types.ts).
    await stores.entityStore.updateAssignee(entityId, actorRef);

    const levelConfig = this.config.levels[activated.escalation_level - 1];
    const timeoutDays = levelConfig?.timeoutDays ?? 0;
    await stores.pendingDeadlineStore.writeDeadline({
      entity_id: entityId,
      deadline_type: 'escalation_timeout',
      fire_at: new Date(this.clock.now().getTime() + timeoutDays * MS_PER_DAY),
      actor_ref: actorRef,
      escalation_level: activated.escalation_level,
    });

    const details = {
      actorRef,
      groupRef: activated.group_ref,
      level: activated.escalation_level,
    };
    await stores.historyStore.appendHistory({
      entity_id: entityId,
      action: 'escalation_actor_resolved',
      actor: 'system',
      details,
    });
    await stores.historyStore.appendHistory({
      entity_id: entityId,
      action: 'escalation_notified',
      actor: 'system',
      details,
    });
    return entity;
  }

  /**
   * Notify the newly assigned actor. Best-effort: a publish failure must never
   * roll back the escalation transaction.
   */
  private async publishEscalationAssigned(
    entityId: string,
    entity: OwnershipEntityRow | undefined,
    activated: EscalationQueueEntryRow,
    actorRef: string,
  ): Promise<void> {
    if (!this.events || !entity) return;
    try {
      await this.events.publish({
        topic: NotificationsTopic.EscalationAssigned,
        eventPayload: {
          entityId,
          entityName: entity.entity_name,
          entityRef: entity.entity_ref,
          actorRef,
          groupRef: activated.group_ref,
          level: activated.escalation_level,
        } satisfies EscalationAssignedEventPayload,
      });
    } catch (err) {
      this.logger.warn(
        `activateNext: failed to publish EscalationAssigned for ${entityId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Cancels every still-live proposal (pending/accepted/possible_owner)
   * and their `proposal_expiry` deadlines when an escalation actor or admin
   * resolves the case directly. Mirrors the sibling cancellation in
   * `ProposalLifecycleService.acceptProposal`.
   *
   * Without this, a scanner-generated proposal left on an `unresolved` entity
   * would stay actionable after the case was resolved. For assign it also
   * collides with the `ownership_proposals_active_idx` unique index when the
   * assigned team already has a pending proposal.
   */
  private async cancelLiveProposals(
    stores: TxStores,
    entityId: string,
    reason: 'escalation_assigned' | 'escalation_archived',
  ): Promise<void> {
    const now = this.clock.now();
    const live = await stores.proposalStore.listCancellableProposalsByEntity(
      entityId,
    );
    for (const p of live) {
      await stores.proposalStore.updateProposalStatus(p.id, 'cancelled', {
        respondedAt: now,
      });
      await stores.historyStore.appendHistory({
        entity_id: entityId,
        proposal_id: p.id,
        action: 'proposal_cancelled',
        actor: 'system',
        details: {
          reason,
          ownerRef: p.proposed_owner_ref,
          siblingStatus: p.status,
        },
      });
    }
    await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
      'proposal_expiry',
    ]);
  }

  /**
   * Flips the entity to `unresolved` and records why.
   *
   * - `all_escalation_paths` (BFS queue drained) is idempotent: an entity
   *   that is already unresolved gets no duplicate `escalation_exhausted` row.
   * - `no_escalation_path` (empty BFS plan at trigger time) is recorded as
   *   `escalation_exhausted` too, so the Unresolved tab and self-heal pick it
   *   up; `details.reason` tells the two apart. Idempotent like the above.
   * - `no_candidates_after_retrigger` is always recorded. Retrigger only runs
   *   on entities that are already `unresolved`, so the status doesn't change,
   *   but the failed attempt must still reach the audit trail and replace the
   *   reason shown on the Unresolved tab.
   */
  private async markEntityUnresolved(
    stores: TxStores,
    entityId: string,
    reason:
      | 'all_escalation_paths'
      | 'no_escalation_path'
      | 'no_candidates_after_retrigger',
  ): Promise<void> {
    const entity = await stores.entityStore.getEntityById(entityId);
    if (!entity) return;
    const alreadyUnresolved = entity.current_status === 'unresolved';
    if (alreadyUnresolved && reason !== 'no_candidates_after_retrigger') return;
    if (!alreadyUnresolved) {
      await stores.entityStore.setEntityUnresolved(entity.id, entity.version);
    }
    await stores.entityStore.updateAssignee(entityId, null);
    await stores.historyStore.appendHistory({
      entity_id: entityId,
      action:
        reason === 'no_candidates_after_retrigger'
          ? 'no_candidates_after_retrigger'
          : 'escalation_exhausted',
      actor: 'system',
      details: { reason },
    });
  }

  /** {@inheritdoc EscalationService.revalidateQueue} */
  async revalidateQueue(entityId: string): Promise<RevalidateQueueResult> {
    // Pre-fetch catalog snapshots OUTSIDE the transaction so HTTP round-trips
    // don't extend the DB lock window. Trade-off: catalog state observed
    // before tx commit; eventual consistency on the next scheduled revalidate.
    const live = await this.catalog.getLiveGroupRegistry();
    const configuredLevels = this.config.levels ?? [];
    const levelGroupSnapshots = await Promise.all(
      configuredLevels.map(async level => {
        const filter = parseGroupFilter(level.groupFilter);
        return filter ? this.catalog.getGroupsByFilter(filter) : [];
      }),
    );

    // full / / implementation.
    //
    // Algorithm (all inside one transaction for atomicity):
    // 1-3. Prune queued entries whose group is no longer live → cancelled +
    // `escalation_queue_entry_removed` history.
    // 4. BFS rebuild — for each level filter, enumerate live matching groups
    // via `getGroupsByFilter` and add any not already represented by an
    // in-flight (queued/active/completed) entry. We use the broad scan
    // (rather than the proposal-rooted walk used by `buildBfsQueue` at
    // initial trigger) because reorgs introduce sibling groups that
    // proposal-rooted walk-up cannot reach.
    // 5. Skipped retry — for each `skipped` entry whose group now resolves
    // an actor, INSERT a fresh `queued` row (don't mutate the historic
    // `skipped` row, to keep the audit trail) and emit
    // `escalation_queue_entry_retried`.
    // 6. Soft circuit breaker — when pruning removed >50 % of the
    // queued entries, append `escalation_circuit_breaker_tripped`. We do
    // NOT early-return: even when 75 % or 100 % of entries are removed, the
    // rebuild + activation still run so escalation can recover
    // automatically. The history row is the operator-visible signal.
    // 7. Activation — when anything changed and no entry is currently
    // active, advance the queue. Empty-queue exhaustion still flips the
    // entity to `unresolved` via `activateNext`.
    return this.store.withTransaction(async stores => {
      // --- 3: prune dead queued entries -------------------------
      const queued = await stores.escalationQueueStore.listQueuedEntries(
        entityId,
      );
      const remainingBefore = queued.length;

      let removed = 0;
      for (const entry of queued) {
        if (live.has(entry.group_ref)) continue;
        await stores.escalationQueueStore.markEntryCancelled(
          entry.id,
          'group_no_longer_live',
        );
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'escalation_queue_entry_removed',
          actor: 'system',
          details: {
            groupRef: entry.group_ref,
            reason: 'group_no_longer_live',
          },
        });
        removed++;
      }

      // --- soft circuit breaker -----------------------
      // Strict majority — `>50 %` not `>=50 %`. We log but continue so live
      // entries can still advance; operator may retrigger if the pattern
      // recurs.
      const circuitBreakerTripped =
        remainingBefore > 0 && removed * 2 > remainingBefore;
      if (circuitBreakerTripped) {
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'escalation_circuit_breaker_tripped',
          actor: 'system',
          details: { removed, remainingBefore, threshold: 0.5 },
        });
      }

      // --- BFS rebuild ------------------------------------------
      // Exclusion set: groups that already have an in-flight entry
      // (`queued` / `active` / `completed`). `cancelled` and `skipped` rows
      // do NOT block re-insertion — re-discovering a previously-dead group
      // (e.g. after a rename) and re-trying a previously-skipped group are
      // both legal outcomes of revalidation.
      const allEntries = await stores.escalationQueueStore.listAllEntries(
        entityId,
      );
      const inFlightRefs = new Set<string>();
      for (const e of allEntries) {
        if (
          e.status === 'queued' ||
          e.status === 'active' ||
          e.status === 'completed'
        ) {
          inFlightRefs.add(e.group_ref);
        }
      }
      let nextPosition =
        allEntries.reduce((m, e) => Math.max(m, e.position), 0) + 1;

      let addedCount = 0;
      for (let i = 0; i < configuredLevels.length; i++) {
        const matching = levelGroupSnapshots[i];
        if (matching.length === 0) continue;
        // Deterministic ordering — `getGroupsByFilter` makes no ordering
        // promise so we sort by ref.
        const sorted = [...matching].sort((a, b) => a.ref.localeCompare(b.ref));
        for (const group of sorted) {
          if (inFlightRefs.has(group.ref)) continue;
          await stores.escalationQueueStore.insertEntry({
            entity_id: entityId,
            group_ref: group.ref,
            escalation_level: i + 1,
            position: nextPosition++,
          });
          await stores.historyStore.appendHistory({
            entity_id: entityId,
            action: 'escalation_queue_entry_added',
            actor: 'system',
            details: {
              groupRef: group.ref,
              level: i + 1,
              source: 'bfs_revalidation',
            },
          });
          inFlightRefs.add(group.ref);
          addedCount++;
        }
      }

      // --- skipped retry ----------------------------------------
      // Walk the original `skipped` rows; if BFS rebuild already inserted a
      // fresh entry for the same group_ref the in-flight set blocks the
      // retry — that's the same outcome from the entity's point of view, so
      // we leave `skippedRetried` untouched in that case.
      //
      // Known issue: `resolveActorForGroup` below hits the catalog
      // (`getGroupMembersWithTitles`) inside this transaction. Bounded to
      // the small set of skipped entries (typically 0-3 per entity).
      // Wider-scope fix would pre-fetch member lists outside the tx and
      // expose a pure `resolveActorFromMembers` helper.
      let skippedRetried = 0;
      for (const entry of allEntries) {
        if (entry.status !== 'skipped') continue;
        if (inFlightRefs.has(entry.group_ref)) continue;
        const skippedLevelConfig =
          this.config.levels?.[entry.escalation_level - 1];
        const skippedTeamRefs = skippedLevelConfig?.managerChain
          ? await this.getEscalatableTeamRefs(entityId)
          : undefined;
        const actor = await this.resolveActorForGroup(
          entry.group_ref,
          entry.escalation_level,
          skippedTeamRefs,
        );
        if (!actor) continue;
        await stores.escalationQueueStore.insertEntry({
          entity_id: entityId,
          group_ref: entry.group_ref,
          escalation_level: entry.escalation_level,
          position: nextPosition++,
        });
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'escalation_queue_entry_retried',
          actor: 'system',
          details: {
            groupRef: entry.group_ref,
            level: entry.escalation_level,
          },
        });
        inFlightRefs.add(entry.group_ref);
        skippedRetried++;
      }

      // --- activate next (only when something actually changed)
      let advancedTo: EscalationLevelRef | null = null;
      if (removed > 0 || addedCount > 0 || skippedRetried > 0) {
        const active = await stores.escalationQueueStore.findActiveEntry(
          entityId,
        );
        if (!active) {
          advancedTo = await this.activateNext(
            stores,
            entityId,
            /* exhaustToUnresolved */ true,
          );
        }
      }

      return {
        removed,
        canceledCount: removed,
        addedCount,
        skippedRetried,
        remainingBefore,
        circuitBreakerTripped,
        advancedTo,
      };
    });
  }

  /** {@inheritdoc EscalationService.resolveActorForGroup} */
  async resolveActorForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string | undefined> {
    return this.actorResolver.resolveActorForGroup(groupRef, level, teamRefs);
  }

  /** {@inheritdoc EscalationService.resolveAllActorsForGroup} */
  async resolveAllActorsForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string[]> {
    return this.actorResolver.resolveAllActorsForGroup(
      groupRef,
      level,
      teamRefs,
    );
  }

  private async getEscalatableTeamRefs(entityId: string): Promise<string[]> {
    const proposals = await this.store.listProposalsByEntity(entityId);
    return proposals
      .filter(p => p.status !== 'possible_owner')
      .map(p => p.proposed_owner_ref);
  }

  /** {@inheritdoc EscalationService.escalationReject} */
  async escalationReject(
    entityId: string,
    actorRef: string,
    reason: string,
  ): Promise<RejectResult> {
    return this.store.withTransaction(async stores => {
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) {
        throw new NotFoundError(`Entity ${entityId} not found`);
      }
      if (entity.current_status !== 'escalated') {
        throw new ConflictError(
          `Entity ${entityId} is not escalated (current=${entity.current_status})`,
        );
      }

      const active = await stores.escalationQueueStore.findActiveEntry(
        entityId,
      );
      // and compare against the actorRef the auth helper authorised against.
      // Closes the TOCTOU window where a concurrent advance flipped the
      // active entry between the router-side auth check and the service tx.
      if (
        active &&
        active.resolved_actor_ref !== null &&
        active.resolved_actor_ref !== actorRef
      ) {
        throw new ConflictError(
          `Active escalation actor changed mid-request for entity ${entityId}`,
        );
      }
      if (active) {
        await stores.escalationQueueStore.markEntryCompleted(active.id);
      }

      await stores.historyStore.appendHistory({
        entity_id: entityId,
        action: 'escalation_rejected',
        actor: actorRef,
        details: {
          reason,
          ...(active && {
            groupRef: active.group_ref,
            level: active.escalation_level,
          }),
        },
      });

      // Cancel the current escalation_timeout — first-action stops the clock.
      await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
        'escalation_timeout',
      ]);

      // Bump version atomically (first-writer-wins).
      await stores.entityStore.setEntityEscalated(entity.id, entity.version);

      // Advance to next BFS entry inside the same transaction. Reject
      // never auto-flips to `unresolved` — leaving the entity escalated
      // is intended; the deadline checker / fallback
      // path is responsible for the eventual exhaustion transition.
      const nextActor = await this.activateNext(
        stores,
        entityId,
        /* exhaustToUnresolved */ false,
      );

      const updated = await stores.entityStore.getEntityById(entityId);
      return {
        entity: toOwnershipEntity(updated!),
        nextActor,
      };
    });
  }

  /** {@inheritdoc EscalationService.escalationAssign} */
  async escalationAssign(
    entityId: string,
    ownerRef: string,
    actorRef: string,
  ): Promise<AssignResult> {
    let prDeadlineId: string | undefined;
    const result = await this.store.withTransaction(async stores => {
      if (this.prCreationTrigger) {
        // Take PR deadline locks before the entity row (the PR worker's lock
        // order, same as acceptProposal) so cancelling a running job below
        // can't deadlock with it.
        await stores.pendingDeadlineStore.lockUnprocessedForEntity(entityId, [
          'pr_creation',
        ]);
      }
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) {
        throw new NotFoundError(`Entity ${entityId} not found`);
      }
      if (!RESOLVABLE_STATUSES.has(entity.current_status)) {
        throw new ConflictError(
          `Entity ${entityId} is not escalated or unresolved (current=${entity.current_status})`,
        );
      }

      const active = await stores.escalationQueueStore.findActiveEntry(
        entityId,
      );
      // and compare against the actorRef the auth helper authorised against.
      // Closes the TOCTOU window where a concurrent advance flipped the
      // active entry between the router-side auth check and the service tx.
      if (
        active &&
        active.resolved_actor_ref !== null &&
        active.resolved_actor_ref !== actorRef
      ) {
        throw new ConflictError(
          `Active escalation actor changed mid-request for entity ${entityId}`,
        );
      }
      if (active) {
        await stores.escalationQueueStore.markEntryCompleted(active.id);
      }

      // Cancel current escalation_timeout — first-action stops the clock.
      await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
        'escalation_timeout',
      ]);

      // Transition to accepted (first-writer-wins via expectedVersion).
      await stores.entityStore.acceptEntity(
        entity.id,
        actorRef,
        'ownership_changed',
        entity.version,
      );
      await stores.entityStore.updateAssignee(entity.id, ownerRef);

      await stores.historyStore.appendHistory({
        entity_id: entityId,
        action: 'escalation_reassigned',
        actor: actorRef,
        details: {
          ownerRef,
          ...(active && { level: active.escalation_level }),
        },
      });

      await this.cancelLiveProposals(stores, entityId, 'escalation_assigned');

      const existingProposals =
        await stores.proposalStore.listProposalsByEntity(entityId);
      const maxOrder = existingProposals.reduce(
        (m, p) => Math.max(m, p.proposal_order),
        0,
      );
      // An `escalated` entity always has an active queue entry; an
      // `unresolved` one (admin action) has none. Fall back to level 1
      // (domain) rather than 0, which would lie about the proposal being
      // team-level.
      const assignmentProposalId = await stores.proposalStore.createProposal({
        entity_id: entityId,
        proposed_owner_ref: ownerRef,
        confidence_reason: 'escalation_assigned',
        proposal_order: maxOrder + 1,
        escalation_level: active?.escalation_level ?? 1,
      });
      await stores.proposalStore.updateProposalStatus(
        assignmentProposalId,
        'accepted',
        { respondedAt: this.clock.now() },
      );

      const grace = this.config.gracePeriodDays ?? 14;
      const warning = this.config.warningDays ?? 4;
      const now = this.clock.now();
      await stores.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        deadline_type: 'grace_warning',
        fire_at: new Date(now.getTime() + (grace - warning) * MS_PER_DAY),
        actor_ref: ownerRef,
        escalation_level: active?.escalation_level ?? null,
      });
      await stores.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        deadline_type: 'grace_expiry',
        fire_at: new Date(now.getTime() + grace * MS_PER_DAY),
        actor_ref: ownerRef,
        escalation_level: active?.escalation_level ?? null,
      });

      // Enqueue the catalog-info PR in the same tx, exactly
      // as ProposalLifecycleService.acceptProposal does, so spec.owner is
      // updated for admin/escalation assignments too.
      if (this.prCreationTrigger) {
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
          'pr_creation',
        ]);
        prDeadlineId = await stores.pendingDeadlineStore.writeDeadline({
          entity_id: entityId,
          proposal_id: assignmentProposalId,
          deadline_type: 'pr_creation',
          fire_at: now,
          // The assigning user — requested as the PR reviewer.
          actor_ref: actorRef,
        });
        await stores.entityStore.updatePrState(entityId, {
          pr_status: 'pending',
          pr_attempts: 0,
          pr_last_error: null,
        });
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          proposal_id: assignmentProposalId,
          action: 'pr_creation_enqueued',
          actor: actorRef,
          details: { ownerRef },
        });
      }

      const updated = await stores.entityStore.getEntityById(entityId);
      return { entity: toOwnershipEntity(updated!) };
    });

    if (prDeadlineId && this.prCreationTrigger) {
      // Fire-and-forget after commit; the deadline-checker retries on failure.
      void this.prCreationTrigger
        .trigger(prDeadlineId)
        .catch(err =>
          this.logger.error(
            `PR creation kick for entity ${entityId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    }

    return result;
  }

  /** {@inheritdoc EscalationService.escalationArchive} */
  async escalationArchive(
    entityId: string,
    assigneeRef: string,
    actorRef: string,
  ): Promise<ArchiveResult> {
    return this.store.withTransaction(async stores => {
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) {
        throw new NotFoundError(`Entity ${entityId} not found`);
      }
      if (!RESOLVABLE_STATUSES.has(entity.current_status)) {
        throw new ConflictError(
          `Entity ${entityId} is not escalated or unresolved (current=${entity.current_status})`,
        );
      }

      const active = await stores.escalationQueueStore.findActiveEntry(
        entityId,
      );
      // and compare against the actorRef the auth helper authorised against.
      if (
        active &&
        active.resolved_actor_ref !== null &&
        active.resolved_actor_ref !== actorRef
      ) {
        throw new ConflictError(
          `Active escalation actor changed mid-request for entity ${entityId}`,
        );
      }
      if (active) {
        await stores.escalationQueueStore.markEntryCompleted(active.id);
      }

      await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
        'escalation_timeout',
      ]);

      await this.cancelLiveProposals(stores, entityId, 'escalation_archived');

      // Transition to to_archive (first-writer-wins).
      await stores.entityStore.markEntityToArchive(
        entity.id,
        actorRef,
        assigneeRef,
        entity.version,
      );

      await stores.historyStore.appendHistory({
        entity_id: entityId,
        action: 'entity_to_archive',
        actor: actorRef,
        details: {
          assigneeRef,
          ...(active && { level: active.escalation_level }),
        },
      });

      if (this.events) {
        await this.events
          .publish({
            topic: NotificationsTopic.ArchivePending,
            eventPayload: {
              entityId,
              entityName: entity.entity_name,
              entityRef: entity.entity_ref,
              assigneeRef,
            } satisfies ArchivePendingEventPayload,
          })
          .catch(err => {
            this.logger.warn(
              `escalationArchive: failed to publish ArchivePending for ${entityId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      const grace = this.config.gracePeriodDays ?? 14;
      const warning = this.config.warningDays ?? 4;
      const now = this.clock.now();
      await stores.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        deadline_type: 'grace_warning',
        fire_at: new Date(now.getTime() + (grace - warning) * MS_PER_DAY),
        actor_ref: assigneeRef,
        escalation_level: active?.escalation_level ?? null,
      });
      await stores.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        deadline_type: 'grace_expiry',
        fire_at: new Date(now.getTime() + grace * MS_PER_DAY),
        actor_ref: assigneeRef,
        escalation_level: active?.escalation_level ?? null,
      });

      const updated = await stores.entityStore.getEntityById(entityId);
      return { entity: toOwnershipEntity(updated!) };
    });
  }

  /** {@inheritdoc EscalationService.escalationSuggest} */
  async escalationSuggest(
    entityId: string,
    suggestedOwnerRef: string,
    reason: string,
    actorRef: string,
  ): Promise<SuggestResult> {
    return this.store.withTransaction(async stores => {
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) {
        throw new NotFoundError(`Entity ${entityId} not found`);
      }
      if (entity.current_status !== 'escalated') {
        throw new ConflictError(
          `Entity ${entityId} is not escalated (current=${entity.current_status})`,
        );
      }

      const active = await stores.escalationQueueStore.findActiveEntry(
        entityId,
      );
      // and compare against the actorRef the auth helper authorised against.
      if (
        active &&
        active.resolved_actor_ref !== null &&
        active.resolved_actor_ref !== actorRef
      ) {
        throw new ConflictError(
          `Active escalation actor changed mid-request for entity ${entityId}`,
        );
      }
      const level = active?.escalation_level ?? 1;

      // Suggest pauses the escalation timeout — the active actor stays
      // authoritative so they can suggest again, accept, or reject. The
      // next lifecycle action (assign/archive/reject) closes the entry.

      // Cancel current escalation_timeout (suggest pauses escalation).
      await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
        'escalation_timeout',
      ]);

      const existing = await stores.proposalStore.listProposalsByEntity(
        entityId,
      );
      // The schema validates the shape of `suggestedOwnerRef`. A runtime
      // `liveGroups.has(suggestedOwnerRef)` check would 404 legitimate fresh
      // teams that haven't propagated to the live group registry yet, so
      // trust the schema and reconcile downstream.
      const maxOrder = existing.reduce(
        (m, p) => Math.max(m, p.proposal_order),
        0,
      );
      const proposalId = await stores.proposalStore.createProposal({
        entity_id: entityId,
        proposed_owner_ref: suggestedOwnerRef,
        confidence_reason: 'escalation_suggested',
        confidence_score: 1.0,
        proposal_order: maxOrder + 1,
        escalation_level: level,
      });
      await stores.proposalStore.updateProposalStatus(proposalId, 'pending', {
        notifiedAt: this.clock.now(),
      });

      // Write a `proposal_expiry` deadline so the deadline checker can drive
      // expiry if the actor doesn't act on the suggestion.
      const fireAt = new Date(
        this.clock.now().getTime() +
          (this.config.gracePeriodDays ?? 14) * MS_PER_DAY,
      );
      await stores.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        proposal_id: proposalId,
        deadline_type: 'proposal_expiry',
        fire_at: fireAt,
      });

      // Bump entity.version for first-writer-wins concurrency (entity stays
      // escalated but the version increment locks out competing actions).
      await stores.entityStore.setEntityEscalated(entity.id, entity.version);

      await stores.historyStore.appendHistory({
        entity_id: entityId,
        proposal_id: proposalId,
        action: 'escalation_suggested_created',
        actor: actorRef,
        details: { reason, suggestedOwnerRef, level },
      });

      const proposal = await stores.proposalStore.getProposal(proposalId);
      const updatedEntity = await stores.entityStore.getEntityById(entity.id);
      return {
        entity: toOwnershipEntity(updatedEntity!),
        proposal: proposal!,
      };
    });
  }

  /** {@inheritdoc EscalationService.escalationRetrigger} */
  async escalationRetrigger(
    entityId: string,
    actorRef: string,
    scanResult?: ScanEntityResult,
  ): Promise<RetriggerResult> {
    // `scannerService.scanEntity(entity_ref)`) and passed in. The legacy
    // duck-type cast is gone. When `scanResult` is `undefined` we fall back
    // to the cancel + regenerate + BFS rebuild path.

    if (scanResult?.passes === true) {
      const finalStatus = await this.store.withTransaction(async stores => {
        const entity = await stores.entityStore.getEntityById(entityId);
        if (!entity) return 'unresolved' as const;

        const proposals =
          await stores.proposalStore.listCancellableProposalsByEntity(entityId);
        for (const p of proposals) {
          await stores.proposalStore.updateProposalStatus(p.id, 'cancelled');
        }
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId);
        await stores.entityStore.closeEntity(
          entity.id,
          actorRef,
          'ownership_changed',
          entity.version,
        );
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'escalation_retrigger',
          actor: actorRef,
          details: { outcome: 'closed', reason: 'ownership_fixed' },
        });
        return 'closed' as const;
      });
      return {
        action: 'retriggered',
        entityStatus: finalStatus,
        proposalsCreated: 0,
      };
    }

    if (scanResult && scanResult.isCatalogPresent === false) {
      // `archived` rather than the default `ownership_changed`.
      const finalStatus = await this.store.withTransaction(async stores => {
        const entity = await stores.entityStore.getEntityById(entityId);
        if (!entity) return 'unresolved' as const;

        const proposals =
          await stores.proposalStore.listCancellableProposalsByEntity(entityId);
        for (const p of proposals) {
          if (p.status === 'accepted') {
            // Team committed but the entity was removed before they could act —
            // same semantics as a grace-expired acceptance: expire, not cancel.
            await stores.proposalStore.updateProposalStatus(p.id, 'expired');
            await stores.historyStore.appendHistory({
              entity_id: entityId,
              proposal_id: p.id,
              action: 'proposal_acceptance_reverted',
              actor: actorRef,
              details: { reason: 'catalog_removed' },
            });
          } else {
            await stores.proposalStore.updateProposalStatus(p.id, 'cancelled');
          }
        }
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId);
        await stores.entityStore.closeEntity(
          entity.id,
          actorRef,
          'archived',
          entity.version,
        );
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          action: 'escalation_retrigger',
          actor: actorRef,
          details: { outcome: 'closed', reason: 'catalog_removed' },
        });
        return 'closed' as const;
      });
      return {
        action: 'retriggered',
        entityStatus: finalStatus,
        proposalsCreated: 0,
      };
    }

    await this.store.withTransaction(async stores => {
      // Rebuild path: clear every live proposal (pending/accepted) so the
      // regenerated set starts clean — an accepted proposal must not survive a
      // rebuild and dangle on the new lifecycle.
      const proposals =
        await stores.proposalStore.listCancellableProposalsByEntity(entityId);
      for (const p of proposals) {
        await stores.proposalStore.updateProposalStatus(p.id, 'cancelled');
      }
      await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId);
      await stores.historyStore.appendHistory({
        entity_id: entityId,
        action: 'escalation_retrigger',
        actor: actorRef,
        details: { outcome: 'rebuilding' },
      });
    });

    // jumping to the BFS rebuild. If the regenerator finds candidates we
    // reopen the entity so the new proposals enter the standard
    // pending lifecycle. If it returns 0 we fall through to the BFS path.
    let proposalsCreated = 0;
    if (scanResult?.entity && scanResult.failingCheck) {
      try {
        proposalsCreated =
          await this.proposalGenerator.generateProposalsForEntity(
            entityId,
            scanResult.entity,
            scanResult.failingCheck,
            scanResult.entity.spec?.owner,
            undefined,
          );
      } catch (err) {
        // The original broad catch hid InputError / NotFoundError /
        // NotAllowedError / catalog-down conditions and silently fell
        // through to a BFS rebuild that *also* depends on a healthy
        // catalog — producing an empty queue + `unresolved` status with
        // the audit trail wrongly recording `no_candidates_after_retrigger`
        // instead of the real failure. Re-throw anything that's a
        // recognisable domain error or that mentions the catalog; keep the
        // catch only for transient generator errors (timeouts, races) so
        // the BFS fallback can still help when proposal generation is
        // genuinely flaky but the queue rebuild can succeed.
        // CandidateSourcesUnavailableError: the candidate list is "unknown",
        // not empty — a BFS rebuild would record a false
        // `no_candidates_after_retrigger`.
        if (
          err instanceof InputError ||
          err instanceof NotFoundError ||
          err instanceof ConflictError ||
          err instanceof CandidateSourcesUnavailableError
        ) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/catalog/i.test(msg)) {
          throw err;
        }
        this.logger.warn(
          `[escalation] retrigger proposal regen failed for ${entityId}: ${msg} — falling back to BFS rebuild`,
        );
      }
    }

    if (proposalsCreated > 0) {
      // Activate the first new proposal: reopen → set first proposal pending.
      await this.store.withTransaction(async stores => {
        const entity = await stores.entityStore.getEntityById(entityId);
        if (!entity) return;
        // `reopenEntity` is idempotent for entities already in `open`.
        if (entity.current_status !== 'open') {
          await stores.entityStore.reopenEntity(entity.id, entity.version);
        }
      });
      const final = await this.store.getEntityById(entityId);
      return {
        action: 'retriggered',
        entityStatus: final?.current_status ?? 'open',
        proposalsCreated,
      };
    }

    // Rebuild the BFS queue from level 1 (own tx).
    const inserted = await this.buildBfsQueue(entityId, new Set());

    // Re-activate the first eligible entry. activateNextEntry transitions
    // the entity to `escalated` when it activates a new entry, or to
    // `unresolved` when the queue is empty.
    if (inserted.length > 0) {
      await this.activateNextEntry(entityId);
    } else {
      // Queue empty — entity stays unresolved (own tx); markEntityUnresolved
      // records the failed retrigger in history.
      await this.store.withTransaction(async stores => {
        await this.markEntityUnresolved(
          stores,
          entityId,
          'no_candidates_after_retrigger',
        );
      });
    }

    const final = await this.store.getEntityById(entityId);
    return {
      action: 'retriggered',
      entityStatus: final?.current_status ?? 'unresolved',
      proposalsCreated: 0,
    };
  }
}

// `EscalationLevelRef` is re-exported so the router can build the response.
export type { EscalationLevelRef };
