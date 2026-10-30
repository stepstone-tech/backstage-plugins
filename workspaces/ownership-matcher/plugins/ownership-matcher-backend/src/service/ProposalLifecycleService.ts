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
import { NotFoundError, ConflictError } from '@backstage/errors';
import { OwnershipStore } from './DatabaseOwnershipStore';
import { OwnershipProposalRow, OwnershipEntityRow } from '../types';
import { EscalationConfig } from '../config/types';
import { EscalationTrigger } from '../escalation/EscalationTrigger';
import type { PrCreationTrigger } from '../pr';

const MS_PER_DAY = 86_400_000;

/** defaults — used when {@link ProposalLifecycleService} is constructed without an explicit {@link EscalationConfig} (test paths that don't care about deadline timing). */
const DEFAULT_GRACE_PERIOD_DAYS = 14;
const DEFAULT_WARNING_DAYS = 4;

/** Result returned by every successful proposal-level action. */
export interface ProposalActionResult {
  proposal: OwnershipProposalRow;
  entity: OwnershipEntityRow;
}

/** Proposal-level lifecycle actions. */
export class ProposalLifecycleService {
  constructor(
    private readonly store: OwnershipStore,
    private readonly logger: LoggerService,
    /** accepted for API stability; this service no longer publishes events directly. */
    _events: EventsService | undefined,
    /** can write `grace_warning` and `grace_expiry` deadlines. */
    private readonly escalationConfig: EscalationConfig | undefined,
    /** triggers escalation after a reject exhausts the pending proposals. */
    private readonly escalationTrigger: EscalationTrigger,
    /**
     * When supplied, acceptance enqueues a `pr_creation` job and
     * kicks it after commit. Omitted = PR automation disabled.
     */
    private readonly prCreationTrigger?: PrCreationTrigger,
  ) {}

  /** Accept a proposal. */
  async acceptProposal(
    proposalId: string,
    actorRef: string,
  ): Promise<ProposalActionResult> {
    const now = new Date();
    const gracePeriodDays =
      this.escalationConfig?.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS;
    const warningDays =
      this.escalationConfig?.warningDays ?? DEFAULT_WARNING_DAYS;
    const baseTime = now.getTime();

    const { entityId, ownerRef, prDeadlineId } =
      await this.store.withTransaction(async tx => {
        const proposal = await tx.proposalStore.getProposal(proposalId);
        if (!proposal) {
          throw new NotFoundError(`Proposal ${proposalId} not found`);
        }
        if (this.prCreationTrigger) {
          // Take PR deadline locks before the entity row (the PR worker's lock
          // order) so cancelling a running job below can't deadlock with it.
          await tx.pendingDeadlineStore.lockUnprocessedForEntity(
            proposal.entity_id,
            ['pr_creation'],
          );
        }
        // Acceptable source states: `pending` (a notified, active proposal the
        // team is responding to) and `possible_owner` (a sub-threshold candidate
        // a team voluntarily claims from the Possible Owners list). All other
        // states are already resolved/terminal and cannot be accepted.
        if (
          proposal.status !== 'pending' &&
          proposal.status !== 'possible_owner'
        ) {
          throw new ConflictError(
            `Proposal ${proposalId} is already ${proposal.status}`,
          );
        }

        await tx.proposalStore.updateProposalStatus(proposalId, 'accepted', {
          respondedAt: now,
        });
        await tx.historyStore.appendHistory({
          entity_id: proposal.entity_id,
          proposal_id: proposalId,
          action: 'proposal_accepted',
          actor: actorRef,
          details: { ownerRef: proposal.proposed_owner_ref },
        });

        const entityForAccept = await tx.entityStore.getEntityById(
          proposal.entity_id,
        );
        if (!entityForAccept) {
          throw new NotFoundError(`Entity ${proposal.entity_id} not found`);
        }
        await tx.entityStore.acceptEntity(
          proposal.entity_id,
          actorRef,
          'ownership_changed',
          entityForAccept.version,
        );
        await tx.entityStore.updateAssignee(
          proposal.entity_id,
          proposal.proposed_owner_ref,
        );
        await tx.historyStore.appendHistory({
          entity_id: proposal.entity_id,
          proposal_id: proposalId,
          action: 'entity_accepted',
          actor: actorRef,
          details: {
            ownerRef: proposal.proposed_owner_ref,
            via: 'proposal',
          },
        });

        await tx.pendingDeadlineStore.writeDeadline({
          entity_id: proposal.entity_id,
          proposal_id: proposalId,
          deadline_type: 'grace_warning',
          fire_at: new Date(
            baseTime + (gracePeriodDays - warningDays) * MS_PER_DAY,
          ),
          actor_ref: proposal.proposed_owner_ref,
          escalation_level: proposal.escalation_level ?? 0,
        });
        await tx.pendingDeadlineStore.writeDeadline({
          entity_id: proposal.entity_id,
          proposal_id: proposalId,
          deadline_type: 'grace_expiry',
          fire_at: new Date(baseTime + gracePeriodDays * MS_PER_DAY),
          actor_ref: proposal.proposed_owner_ref,
          escalation_level: proposal.escalation_level ?? 0,
        });

        // Broadcast cleanup: with all above-threshold candidates
        // notified simultaneously, accepting one leaves the others live. The
        // entity is now owned (status → accepted), so every other live proposal
        // for it is moot and must be terminated. We trust the whitelist of
        // `listCancellableProposalsByEntity` (pending/accepted/possible_owner
        // — exactly the statuses that must be terminated when a case resolves) and
        // cancel every row it returns except the one we just accepted, rather than
        // re-filtering by status here. That avoids silently abandoning unexpected
        // siblings (e.g. a second `accepted` row from a
        // racing accept) as zombies — they would otherwise keep showing as live in
        // listAllProposals/getStats. This mirrors the case-closing convention in
        // EntityProcessingService.
        const siblings =
          await tx.proposalStore.listCancellableProposalsByEntity(
            proposal.entity_id,
          );
        for (const sibling of siblings) {
          if (sibling.id === proposalId) continue;
          if (sibling.status === 'accepted') {
            this.logger.warn(
              `Cancelling unexpected second accepted proposal ${sibling.id} for entity ${proposal.entity_id} while accepting ${proposalId}`,
            );
          }
          await tx.proposalStore.updateProposalStatus(sibling.id, 'cancelled', {
            respondedAt: now,
          });
          await tx.historyStore.appendHistory({
            entity_id: proposal.entity_id,
            proposal_id: sibling.id,
            action: 'proposal_cancelled',
            actor: 'system',
            details: {
              reason: 'sibling_accepted',
              ownerRef: sibling.proposed_owner_ref,
              acceptedProposalId: proposalId,
              siblingStatus: sibling.status,
            },
          });
        }
        // Cancel outstanding `proposal_expiry` deadlines for the entity — covers
        // both the now-accepted proposal (it lives under grace deadlines instead)
        // and every cancelled sibling.
        await tx.pendingDeadlineStore.cancelDeadlinesForEntity(
          proposal.entity_id,
          ['proposal_expiry'],
        );

        // Enqueue the catalog-info PR in the same tx so acceptance
        // and the job are atomic. Bitbucket is never called here — the job is
        // kicked after commit and retried by the deadline-checker task.
        let deadlineId: string | undefined;
        if (this.prCreationTrigger) {
          // Supersede any still-queued job from an earlier acceptance/retry.
          await tx.pendingDeadlineStore.cancelDeadlinesForEntity(
            proposal.entity_id,
            ['pr_creation'],
          );
          deadlineId = await tx.pendingDeadlineStore.writeDeadline({
            entity_id: proposal.entity_id,
            proposal_id: proposalId,
            deadline_type: 'pr_creation',
            fire_at: now,
            // The accepting user — requested as the PR reviewer.
            actor_ref: actorRef,
          });
          await tx.entityStore.updatePrState(proposal.entity_id, {
            pr_status: 'pending',
            pr_attempts: 0,
            pr_last_error: null,
          });
          await tx.historyStore.appendHistory({
            entity_id: proposal.entity_id,
            proposal_id: proposalId,
            action: 'pr_creation_enqueued',
            actor: actorRef,
            details: { ownerRef: proposal.proposed_owner_ref },
          });
        }

        return {
          entityId: proposal.entity_id,
          ownerRef: proposal.proposed_owner_ref,
          prDeadlineId: deadlineId,
        };
      });

    this.logger.info(
      `Proposal ${proposalId} accepted by ${actorRef} for entity ${entityId} (owner=${ownerRef})`,
    );

    if (prDeadlineId && this.prCreationTrigger) {
      // Fire-and-forget: the HTTP response must not wait on Bitbucket. If the
      // kick fails or the process dies — before or during the job — the
      // deadline stays unprocessed (the job only leases it) and the
      // deadline-checker task picks it up once due / once the lease expires.
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

    const [updatedProposal, updatedEntity] = await Promise.all([
      this.store.getProposal(proposalId),
      this.store.getEntityById(entityId),
    ]);

    return {
      proposal: updatedProposal!,
      entity: updatedEntity!,
    };
  }

  /** Reject a proposal. */
  async rejectProposal(
    proposalId: string,
    actorRef: string,
    reason: string,
  ): Promise<ProposalActionResult> {
    const entityId = await this.store.withTransaction(async tx => {
      const proposal = await tx.proposalStore.getProposal(proposalId);
      if (!proposal) {
        throw new NotFoundError(`Proposal ${proposalId} not found`);
      }
      if (proposal.status !== 'pending') {
        throw new ConflictError(
          `Proposal ${proposalId} is already ${proposal.status}`,
        );
      }

      await tx.proposalStore.updateProposalStatus(proposalId, 'rejected', {
        respondedAt: new Date(),
        responseNote: reason,
      });
      await tx.historyStore.appendHistory({
        entity_id: proposal.entity_id,
        proposal_id: proposalId,
        action: 'proposal_rejected',
        actor: actorRef,
        details: { reason, ownerRef: proposal.proposed_owner_ref },
      });

      // Deliberately do NOT cancel sibling pending proposals here (contrast
      // with acceptProposal, which does). Under broadcast, every
      // above-threshold candidate is notified simultaneously and each tracks
      // its response independently — one team declining says nothing about
      // whether the others own the entity, so their proposals must stay live
      // and independently claimable. Siblings are not zombies: when every
      // sibling has responded (rejected/expired), the triggerEscalation call
      // below advances the case to escalation (Branch 3). While any sibling is
      // still pending, that call is a no-op (it returns early on the remaining
      // pending row). Accept resolves the whole entity, so it cancels siblings;
      // reject resolves only the one proposal, so it must not.
      return proposal.entity_id;
    });

    // triggerEscalation opens its own tx (and runs catalog HTTP for BFS) —
    // keep it outside the per-proposal tx, same pattern as DeadlineCheckerService.
    // No-op while sibling proposals remain pending; escalates once all have
    // responded.
    await this.escalationTrigger.triggerEscalation(entityId);

    const [updatedProposal, updatedEntity] = await Promise.all([
      this.store.getProposal(proposalId),
      this.store.getEntityById(entityId),
    ]);

    return {
      proposal: updatedProposal!,
      entity: updatedEntity!,
    };
  }
}
