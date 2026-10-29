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
import { EventsService } from '@backstage/plugin-events-node';
import { InputError } from '@backstage/errors';
import { OwnershipStore, TxStores } from '../service/DatabaseOwnershipStore';
import { OwnershipEntityRow } from '../types';
import { EscalationConfig } from '../config/types';
import { NotificationsTopic } from '../service/notifications/topics';
import { Clock } from './Clock';
import { EscalationService } from './EscalationService';
import { DeadlineType, PendingDeadlineRow } from './types';

const MS_PER_DAY = 86_400_000;

/** Post-tx follow-up after a proposal_expiry deadline fires. */
type ExpiryFollowUp =
  | {
      /** Team-level proposal on an `open` entity — caller must run triggerEscalation. */
      kind: 'open';
      proposalId: string;
      proposedOwnerRef: string;
    }
  | {
      /** Escalation-level suggestion on an `escalated` entity — BFS already advanced. */
      kind: 'escalated';
      proposalId: string;
      proposedOwnerRef: string;
    }
  | null;

/** Options for {@link DeadlineCheckerService.writeDeadline}, expressed as a discriminated union by `deadlineType`. */
export type WriteDeadlineOptions =
  | {
      deadlineType: 'proposal_expiry';
      proposalId: string;
      actorRef?: never;
      escalationLevel?: never;
    }
  | {
      deadlineType: 'escalation_timeout';
      actorRef: string;
      escalationLevel: number;
      proposalId?: never;
    }
  | {
      deadlineType: 'grace_warning';
      actorRef: string;
      proposalId?: string;
      escalationLevel?: number;
    }
  | {
      deadlineType: 'grace_expiry';
      proposalId?: string;
      actorRef?: string;
      escalationLevel?: number;
    }
  | {
      deadlineType: 'redecision_expiry';
      actorRef: string;
      escalationLevel: number;
      proposalId?: never;
    };

/** Public contract of the deadline checker. */
export interface DeadlineCheckerService {
  /** Process all `pending_deadlines` rows whose `fire_at <= clock.now`. */
  processExpiredDeadlines(): Promise<void>;

  /** Insert a deadline row OUTSIDE a transaction. */
  writeDeadline(
    entityId: string,
    fireAt: Date,
    opts: WriteDeadlineOptions,
  ): Promise<void>;

  /** Bulk-cancel unprocessed deadlines for an entity. */
  cancelDeadlinesForEntity(
    entityId: string,
    types?: DeadlineType[],
  ): Promise<void>;
}

/** Concrete implementation of {@link DeadlineCheckerService}. */
export class DefaultDeadlineCheckerService implements DeadlineCheckerService {
  constructor(
    private readonly store: OwnershipStore,
    private readonly escalationService: EscalationService,
    private readonly escalationConfig: EscalationConfig,
    private readonly clock: Clock,
    private readonly logger: LoggerService,
    private readonly events?: EventsService,
  ) {
    if (!escalationConfig) {
      throw new InputError('[deadline-checker] escalationConfig is required');
    }
  }

  /** {@inheritdoc DeadlineCheckerService.processExpiredDeadlines} */
  async processExpiredDeadlines(): Promise<void> {
    const now = this.clock.now();

    // transaction. Wrapping it in `withTransaction` previously held a
    // BEGIN..COMMIT around what is just a SELECT, blocking other workers'
    // claim attempts. Use the non-tx store accessor.
    // `pr_creation` rows are drained by PrCreationService (they need Bitbucket
    // calls outside any tx, and must run even when escalation is disabled).
    const candidates = await this.store.findExpiredDeadlines(now, {
      excludeTypes: ['pr_creation'],
    });

    // Per-row independent transactions so a failure in one row does not
    // poison the others.
    for (const candidate of candidates) {
      try {
        await this.processOne(candidate.id, now);
      } catch (err) {
        this.logger.error(
          `[deadline-checker] failed to process deadline ${candidate.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  private async processOne(id: string, now: Date): Promise<void> {
    // proposal_expiry needs follow-up actions OUTSIDE the per-row tx
    // (triggerEscalation opens its own tx + runs catalog HTTP). The tx
    // callback returns the descriptor so the post-commit block can act on it.
    const pending = await this.store.withTransaction<{
      followUp: NonNullable<ExpiryFollowUp>;
      entityId: string;
    } | null>(async tx => {
      const row = await tx.pendingDeadlineStore.claimDeadline(id, now);
      if (!row) {
        // Lost the race or already processed — idempotent no-op.
        return null;
      }

      const entity = await tx.entityStore.getEntityById(row.entity_id);
      if (!entity) {
        this.logger.warn(
          `[deadline-checker] deadline ${row.id} references missing entity ${row.entity_id}; marked processed`,
        );
        return null;
      }

      // Stale-deadline lazy skip.
      if (this.isStale(row, entity)) {
        this.logger.debug(
          `[deadline-checker] stale ${row.deadline_type} on entity ${entity.id} (status=${entity.current_status}) — marked processed, no action`,
        );
        return null;
      }

      switch (row.deadline_type) {
        case 'escalation_timeout':
          await this.handleEscalationTimeout(tx, row, entity);
          return null;
        case 'proposal_expiry': {
          const result = await this.handleProposalExpiry(tx, row, entity);
          return result ? { followUp: result, entityId: row.entity_id } : null;
        }
        case 'grace_warning':
          await this.handleGraceWarning(tx, row, entity);
          return null;
        case 'grace_expiry':
          await this.handleGraceExpiry(tx, row, entity);
          return null;
        case 'redecision_expiry':
          await this.handleRedecisionExpiry(tx, row, entity);
          return null;
        default:
          this.logger.warn(
            `[deadline-checker] unknown deadline_type=${row.deadline_type} on ${row.id}; marked processed`,
          );
          return null;
      }
    });

    if (pending) {
      // Publish the durable fact (proposal is expired in DB) BEFORE invoking
      // triggerEscalation. If trigger throws, the next scan re-triggers via
      // handleRedetection — but the event would otherwise be lost forever.
      await this.publishProposalExpiredEvent(
        pending.entityId,
        pending.followUp.proposalId,
        pending.followUp.proposedOwnerRef,
      );
      if (pending.followUp.kind === 'open') {
        await this.escalationService.triggerEscalation(pending.entityId);
      }
      // 'escalated' kind: BFS advance already happened inside the tx via
      // advanceQueue — no further dispatch needed.
    }
  }

  private isStale(
    row: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): boolean {
    const status = entity.current_status;
    switch (row.deadline_type) {
      case 'escalation_timeout':
      case 'redecision_expiry':
        // Only valid on entities currently in escalation.
        return status !== 'escalated';
      case 'proposal_expiry':
        // Valid on open or escalated; anything else means resolved.
        return status !== 'escalated' && status !== 'open';
      case 'grace_warning':
      case 'grace_expiry':
        // Grace applies to entities that were assigned/marked-archive.
        return status !== 'accepted' && status !== 'to_archive';
      default:
        return true;
    }
  }

  // ── Per-type handlers ────────────────────────────────────────────────────

  private async handleEscalationTimeout(
    tx: TxStores,
    row: PendingDeadlineRow,
    _entity: OwnershipEntityRow,
  ): Promise<void> {
    const active = await tx.escalationQueueStore.findActiveEntry(row.entity_id);
    if (active) {
      // Re-resolve the actor for this group/level against the current catalog.
      const liveActor = await this.escalationService.resolveActorForGroup(
        active.group_ref,
        active.escalation_level,
      );
      const snapshotActor = active.resolved_actor_ref;

      if (liveActor && liveActor === snapshotActor) {
        // Actor still in role — straight timeout, complete and advance.
        await tx.escalationQueueStore.markEntryCompleted(active.id);
      } else {
        // Actor left or changed — mark the entry skipped.
        await tx.escalationQueueStore.markEntrySkipped(
          active.id,
          'actor_no_longer_resolvable',
        );
        await tx.historyStore.appendHistory({
          entity_id: row.entity_id,
          action: 'escalation_queue_entry_skipped',
          actor: 'system',
          details: {
            groupRef: active.group_ref,
            level: active.escalation_level,
            reason: 'actor_no_longer_resolvable',
            previousActor: snapshotActor,
            currentActor: liveActor ?? null,
          },
        });
        // reflects the live catalog before we activate the next entry.
        // Note: revalidateQueue opens its own tx; do not call from inside
        // the per-row tx. Defer to the standard advance path which the
        // escalation service already drives via advanceQueue.
      }
    }
    // dead-group skipping, actor resolution and history actions match the
    // escalationReject path. After advancement, write the
    // auto-advanced breadcrumb.
    await this.escalationService.advanceQueue(tx, row.entity_id, true);
    await tx.historyStore.appendHistory({
      entity_id: row.entity_id,
      action: 'escalation_auto_advanced',
      actor: 'system',
      details: { reason: 'escalation_timeout' },
    });
  }

  private async handleProposalExpiry(
    tx: TxStores,
    row: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): Promise<ExpiryFollowUp> {
    let expiredProposalId: string | null = null;
    let expiredOwnerRef: string | null = null;

    if (row.proposal_id) {
      const proposal = await tx.proposalStore.getProposal(row.proposal_id);
      if (proposal?.status === 'pending') {
        await tx.proposalStore.updateProposalStatus(
          row.proposal_id,
          'expired',
          {
            respondedAt: this.clock.now(),
          },
        );
        await tx.historyStore.appendHistory({
          entity_id: row.entity_id,
          proposal_id: row.proposal_id,
          action: 'proposal_expired',
          actor: 'system',
          details: { ownerRef: proposal.proposed_owner_ref },
        });
        expiredProposalId = row.proposal_id;
        expiredOwnerRef = proposal.proposed_owner_ref;
      }
    }

    if (entity.current_status === 'escalated') {
      // Escalation-level suggestion expired → resume BFS.
      // exhaustToUnresolved=false: suggestion expiry doesn't mean BFS exhaustion;
      // the next escalation_timeout cycle handles its own exhaustion.
      await this.escalationService.advanceQueue(tx, row.entity_id, false);
      if (expiredProposalId && expiredOwnerRef) {
        return {
          kind: 'escalated',
          proposalId: expiredProposalId,
          proposedOwnerRef: expiredOwnerRef,
        };
      }
      return null;
    }

    // Open entity: triggerEscalation runs post-commit (see processOne).
    if (expiredProposalId && expiredOwnerRef) {
      return {
        kind: 'open',
        proposalId: expiredProposalId,
        proposedOwnerRef: expiredOwnerRef,
      };
    }
    return null;
  }

  private async publishProposalExpiredEvent(
    entityId: string,
    proposalId: string,
    proposedOwnerRef: string,
  ): Promise<void> {
    if (!this.events) return;
    try {
      const entity = await this.store.getEntityById(entityId);
      if (!entity) return;
      await this.events.publish({
        topic: NotificationsTopic.ProposalExpired,
        eventPayload: {
          proposalId,
          entityId,
          entityName: entity.entity_name,
          proposedOwnerRef,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to publish ${
          NotificationsTopic.ProposalExpired
        } for proposal ${proposalId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async handleGraceWarning(
    _tx: TxStores,
    row: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): Promise<void> {
    this.logger.info(
      `[deadline-checker] grace_warning fired entity=${row.entity_id} actor=${
        row.actor_ref ?? '<unset>'
      }`,
    );

    if (!this.events || !row.actor_ref) return;

    // `fire_at` IS the warning's fire time; grace_expiry fires `warningDays`
    // later. Compute the absolute expiry timestamp for the recipient-facing
    // message and the dedup key.
    const warningDays = this.escalationConfig.warningDays ?? 4;
    const expiresAt = new Date(
      row.fire_at.getTime() + warningDays * MS_PER_DAY,
    );
    try {
      await this.events.publish({
        topic: NotificationsTopic.GraceWarning,
        eventPayload: {
          entityId: entity.id,
          entityName: entity.entity_name,
          recipientRef: row.actor_ref,
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiry: warningDays,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to publish ${NotificationsTopic.GraceWarning} for entity ${
          entity.id
        }: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleGraceExpiry(
    tx: TxStores,
    row: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): Promise<void> {
    const isProposalLevel =
      row.escalation_level === null || row.escalation_level === 0;

    if (isProposalLevel) {
      if (entity.current_status === 'accepted') {
        // Accepted owner ignored grace → reopen the case.
        await tx.entityStore.reopenEntity(entity.id, entity.version);

        // Cancel sibling deadlines (e.g. the paired grace_warning) so a stale
        // unprocessed deadline can't later fire against the reopened/re-accepted
        // entity with an outdated expiry. The current grace_expiry row is already
        // claimed (processed) by processOne, so this only clears the leftovers.
        await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entity.id);

        const proposals = await tx.proposalStore.listProposalsByEntity(
          row.entity_id,
        );

        // Demote the stale accepted proposal — the owner committed but never
        // updated the YAML within the grace window. Leaving it `accepted` while
        // the entity is reopened to `open` produces an inconsistent
        // open + accepted state. Expire it so the case has no live
        // accepted proposal hanging off a reopened entity.
        for (const p of proposals) {
          if (p.status === 'accepted') {
            await tx.proposalStore.updateProposalStatus(p.id, 'expired', {
              respondedAt: this.clock.now(),
            });
            await tx.historyStore.appendHistory({
              entity_id: entity.id,
              proposal_id: p.id,
              action: 'proposal_acceptance_reverted',
              actor: 'system',
              details: { reason: 'acceptance_grace_expired' },
            });
          }
        }
      } else if (entity.current_status === 'to_archive') {
        // `to_archive` as a *decision* (the original actor opted to archive
        // rather than fix). When the to-archive owner ignores the warning,
        // the previous-level escalation actor still has a re-decision
        // window — flip back to `escalated`, keep the existing active
        // queue entry, and arm a `redecision_expiry` so the actor must
        // re-engage before the case drops to `unresolved`.
        await tx.entityStore.setEntityEscalated(entity.id, entity.version);
        await tx.historyStore.appendHistory({
          entity_id: entity.id,
          action: 'escalation_grace_expired_archival',
          actor: 'system',
          details: { reason: 'archive_grace_expired' },
        });
        const fireAt = new Date(
          this.clock.now().getTime() +
            (this.escalationConfig.reDecisionDays ?? 3) * MS_PER_DAY,
        );
        await tx.pendingDeadlineStore.writeDeadline({
          entity_id: entity.id,
          deadline_type: 'redecision_expiry',
          fire_at: fireAt,
          actor_ref: row.actor_ref,
          escalation_level: row.escalation_level,
        });
      }
      return;
    }

    // Escalation-level grace.
    if (
      entity.current_status === 'accepted' ||
      entity.current_status === 'to_archive'
    ) {
      await tx.entityStore.setEntityEscalated(entity.id, entity.version);
    }

    // The redecision window only applies when the queue is empty (no further
    // escalation candidates). When more queue entries exist, advance to the
    // next BFS level instead — writing a redecision deadline in that case
    // would cause a second auto-advance against the next director.
    const queued = await tx.escalationQueueStore.listQueuedEntries(
      row.entity_id,
    );
    if (queued.length > 0) {
      // Advance via the escalation service (dead-group skipping etc.).
      // trail distinguishes deadline-driven advancement from user-driven.
      await this.escalationService.advanceQueue(tx, row.entity_id, false);
      await tx.historyStore.appendHistory({
        entity_id: row.entity_id,
        action: 'escalation_auto_advanced',
        actor: 'system',
        details: { reason: 'grace_expiry' },
      });
      return;
    }

    // Queue is empty — give the original actor a redecision window.
    // Window length flows from config.
    const fireAt = new Date(
      this.clock.now().getTime() +
        (this.escalationConfig.reDecisionDays ?? 3) * MS_PER_DAY,
    );
    await tx.pendingDeadlineStore.writeDeadline({
      entity_id: row.entity_id,
      deadline_type: 'redecision_expiry',
      fire_at: fireAt,
      actor_ref: row.actor_ref,
      escalation_level: row.escalation_level,
    });
  }

  private async handleRedecisionExpiry(
    tx: TxStores,
    row: PendingDeadlineRow,
    _entity: OwnershipEntityRow,
  ): Promise<void> {
    await this.escalationService.advanceQueue(tx, row.entity_id, true);
    await tx.historyStore.appendHistory({
      entity_id: row.entity_id,
      action: 'escalation_auto_advanced',
      actor: 'system',
      details: { reason: 'redecision_expiry' },
    });
  }

  /** {@inheritdoc DeadlineCheckerService.writeDeadline} */
  async writeDeadline(
    entityId: string,
    fireAt: Date,
    opts: WriteDeadlineOptions,
  ): Promise<void> {
    await this.store.withTransaction(async tx => {
      await tx.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        deadline_type: opts.deadlineType,
        fire_at: fireAt,
        proposal_id:
          opts.deadlineType === 'proposal_expiry' ? opts.proposalId : null,
        actor_ref: 'actorRef' in opts ? opts.actorRef ?? null : null,
        escalation_level:
          'escalationLevel' in opts ? opts.escalationLevel ?? null : null,
      });
    });
  }

  /** {@inheritdoc DeadlineCheckerService.cancelDeadlinesForEntity} */
  async cancelDeadlinesForEntity(
    entityId: string,
    types?: DeadlineType[],
  ): Promise<void> {
    await this.store.withTransaction(async tx => {
      await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, types);
    });
  }
}
