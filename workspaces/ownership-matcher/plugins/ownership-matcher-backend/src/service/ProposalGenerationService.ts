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
import { ServiceUnavailableError } from '@backstage/errors';
import { ProposalStrategy, ProposalStrategyContext } from '../proposals/types';
import { FallbackStrategy } from '../proposals/FallbackStrategy';
import { OwnershipStore } from './DatabaseOwnershipStore';
import {
  CatalogComponent,
  CatalogService,
  ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ProposalsConfig } from '../config/types';
import { Clock } from '../escalation/Clock';

/** Per-team accumulator used by {@link OwnershipMatcherService} to fan one
 * `ProposalsBatchReady` event out per team at the end of a scan. */
export interface PersistedProposalRef {
  proposalId: string;
  ownerRef: string;
}

/**
 * Thrown by {@link ProposalGenerationService.generateProposals} when no
 * candidate survived *because* a candidate source failed (a strategy threw,
 * or the team registry came back empty). The empty result is "unknown", not
 * "zero candidates", so callers must not escalate on it — the case keeps its
 * status and the next scan retries.
 */
export class CandidateSourcesUnavailableError extends ServiceUnavailableError {}

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;

interface MergedCandidate {
  ownerRef: string;
  weightedScore: number;
  reasons: string[];
}

interface ScoredCandidate extends MergedCandidate {
  normalizedScore: number;
}

// ─── Pipeline steps ──────────────────────────────────────────────────────────

function mergeCandidates(
  merged: Map<string, MergedCandidate>,
  candidates: {
    ownerRef: string;
    confidenceScore: number;
    confidenceReason: string[];
  }[],
  weight: number,
): void {
  for (const candidate of candidates) {
    const existing = merged.get(candidate.ownerRef);
    if (existing) {
      existing.weightedScore += candidate.confidenceScore * weight;
      existing.reasons.push(...candidate.confidenceReason);
    } else {
      merged.set(candidate.ownerRef, {
        ownerRef: candidate.ownerRef,
        weightedScore: candidate.confidenceScore * weight,
        reasons: [...candidate.confidenceReason],
      });
    }
  }
}

function filterToTeamGroups(
  merged: Map<string, MergedCandidate>,
  teamRegistry: Set<string>,
): Map<string, MergedCandidate> {
  const filtered = new Map<string, MergedCandidate>();
  for (const [ref, candidate] of merged) {
    if (teamRegistry.has(ref)) {
      filtered.set(ref, candidate);
    }
  }
  return filtered;
}

function normalizeScores(
  candidates: MergedCandidate[],
  totalWeight: number,
): ScoredCandidate[] {
  return candidates
    .map(c => ({
      ...c,
      normalizedScore:
        totalWeight > 0 ? Math.min(1, c.weightedScore / totalWeight) : 0,
    }))
    .sort((a, b) => b.normalizedScore - a.normalizedScore);
}

function applyThreshold(
  candidates: ScoredCandidate[],
  minimumScoreThreshold: number,
): ScoredCandidate[] {
  return candidates.filter(
    (c, i) => i === 0 || c.normalizedScore >= minimumScoreThreshold,
  );
}

function capResults(
  candidates: ScoredCandidate[],
  maxCandidatesPerEntity: number,
): ScoredCandidate[] {
  return candidates.slice(0, maxCandidatesPerEntity);
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class ProposalGenerationService {
  private readonly strategyWeights: Map<string, number>;
  private readonly totalWeight: number;

  constructor(
    private readonly store: OwnershipStore,
    private readonly strategies: ProposalStrategy[],
    private readonly config: ProposalsConfig,
    private readonly logger: LoggerService,
    private readonly catalogService: CatalogService,
    private readonly clock?: Clock,
  ) {
    this.strategyWeights = new Map();
    for (const s of config.strategies) {
      if (s.weight !== undefined) {
        this.strategyWeights.set(s.name, s.weight);
      }
    }
    // Theoretical max weighted score = sum of weights for every contributing
    // strategy (FallbackStrategy is skipped in `collectCandidates`). Dividing
    // by this — rather than the observed max — keeps normalized scores
    // stable and lets the design's confidence tiers stay meaningful.
    this.totalWeight = this.strategies
      .filter(s => !(s instanceof FallbackStrategy))
      .reduce((sum, s) => sum + (this.strategyWeights.get(s.name) ?? 1.0), 0);
  }

  /** Retrigger entry point. */
  async generateProposalsForEntity(
    entityId: string,
    entity: CatalogComponent,
    currentCheck: string,
    currentOwner: string | undefined,
    repo: ScmRepoRef | undefined,
  ): Promise<number> {
    const scanId = `retrigger:${entityId}`;

    const before = await this.store.listActiveProposalsByEntity(entityId);
    const beforeCount = before.length;

    const ok = await this.generateProposals(
      entityId,
      entity,
      currentCheck,
      currentOwner,
      repo,
      scanId,
    );
    if (!ok) return 0;

    const after = await this.store.listActiveProposalsByEntity(entityId);
    // `generateProposals` may persist either fallback or strategy proposals;
    // count the delta so we don't include any pre-existing rows the caller
    // chose not to cancel.
    return Math.max(after.length - beforeCount, 0);
  }

  async generateProposals(
    entityId: string,
    entity: CatalogComponent,
    currentCheck: string,
    currentOwner: string | undefined,
    repo: ScmRepoRef | undefined,
    scanId: string,
    /** Optional sink for `{proposalId, ownerRef}` of every created proposal —
     * the orchestrator drains it once per scan to emit one
     * `ProposalsBatchReady` per team. */
    persistedAccumulator?: PersistedProposalRef[],
  ): Promise<boolean> {
    const rejectedActors = await this.store.getRejectedActors(entityId);

    const ctx: ProposalStrategyContext = {
      entity,
      repo,
      currentCheck,
      currentOwner,
      rejectedActors,
    };

    const { merged, fallbackStrategy, failedStrategies } =
      await this.collectCandidates(ctx, entityId);

    const teamRegistry = await this.catalogService.getTeamGroupRegistry();
    let filtered = filterToTeamGroups(merged, teamRegistry);

    // `getTeamGroupRegistry` returns an empty set on a catalog error, and the
    // strategies' failures are only logged by `collectCandidates`. Either way
    // an empty `filtered` would be indistinguishable from "nobody owns this"
    // and escalate the case to `unresolved` on a transient blip. Bail out
    // before the fallback too: a fixed-owner fallback must not be assigned
    // just because the real signals were unavailable.
    if (filtered.size === 0) {
      const registryUnavailable = teamRegistry.size === 0 && merged.size > 0;
      if (failedStrategies.length > 0 || registryUnavailable) {
        throw new CandidateSourcesUnavailableError(
          `Candidate sources unavailable for entity ${entityId} (${
            registryUnavailable
              ? 'team registry empty'
              : `failed strategies: ${failedStrategies.join(', ')}`
          }); not treating as zero candidates`,
        );
      }

      const fallbackResult = await this.tryFallback(
        fallbackStrategy,
        ctx,
        teamRegistry,
        entityId,
        scanId,
      );
      if (fallbackResult && fallbackResult !== 'escalated') {
        filtered = fallbackResult;
      }
    }

    // (`EntityProcessingService`) is responsible for invoking the
    // {@link EscalationTrigger} when we return `false` so the entity-status
    // flip and history entry happen exactly once at the boundary.
    if (filtered.size === 0) {
      // Possible owners are regenerated wholesale each scan (see
      // `persistProposals`), so a scan that found nobody clears the previous
      // set too — otherwise stale rows stay claimable and make the escalation
      // boundary record `only_possible_owners` for a scan that found nothing.
      await this.store.deletePossibleOwnersByEntity(entityId);
      return false;
    }

    const normalized = normalizeScores(
      Array.from(filtered.values()),
      this.totalWeight,
    );
    const thresholded = applyThreshold(
      normalized,
      this.config.minimumScoreThreshold,
    );
    const finalCandidates = capResults(
      thresholded,
      this.config.maxCandidatesPerEntity,
    );

    // Split survivors by the notification threshold. Candidates at or above it
    // become active proposals (first is notified). Those below are stored as
    // `possible_owner` for voluntary claiming and never notified. `finalCandidates`
    // is already sorted descending by score, so the active set keeps the lower
    // `proposal_order` values and the possible owners follow.
    const notificationThreshold = this.config.notificationThreshold;
    const activeCandidates = finalCandidates.filter(
      c => c.normalizedScore >= notificationThreshold,
    );
    const possibleOwners = finalCandidates.filter(
      c => c.normalizedScore < notificationThreshold,
    );

    await this.persistProposals(
      activeCandidates,
      possibleOwners,
      entityId,
      scanId,
      persistedAccumulator,
    );

    this.logger.info(
      `Generated ${activeCandidates.length} proposal(s) and ${possibleOwners.length} possible owner(s) for entity ${entityId}`,
    );

    // Possible-owner-only: nobody is notified, so nothing would ever move the
    // case. Return false so the caller escalates it to `unresolved`; the
    // possible owners stay persisted and claimable from the UI.
    if (activeCandidates.length === 0) {
      return false;
    }

    await this.store.updateAssignee(entityId, activeCandidates[0].ownerRef);
    return true;
  }

  // ── Pipeline building blocks ──────────────────────────────────────────────

  private async collectCandidates(
    ctx: ProposalStrategyContext,
    entityId: string,
  ): Promise<{
    merged: Map<string, MergedCandidate>;
    fallbackStrategy?: FallbackStrategy;
    failedStrategies: string[];
  }> {
    const merged = new Map<string, MergedCandidate>();
    const failedStrategies: string[] = [];
    let fallbackStrategy: FallbackStrategy | undefined;

    for (const strategy of this.strategies) {
      if (strategy instanceof FallbackStrategy) {
        fallbackStrategy = strategy;
        continue;
      }

      const weight = this.strategyWeights.get(strategy.name) ?? 1.0;

      try {
        const found = await strategy.findCandidates(ctx);
        mergeCandidates(merged, found, weight);
      } catch (error) {
        failedStrategies.push(strategy.name);
        this.logger.warn(
          `Strategy "${strategy.name}" failed for entity ${entityId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { merged, fallbackStrategy, failedStrategies };
  }

  private async tryFallback(
    fallbackStrategy: FallbackStrategy | undefined,
    ctx: ProposalStrategyContext,
    teamRegistry: Set<string>,
    entityId: string,
    _scanId: string,
  ): Promise<Map<string, MergedCandidate> | 'escalated' | undefined> {
    if (!fallbackStrategy) return undefined;

    try {
      const fallbackCandidates = await fallbackStrategy.findCandidates(ctx);

      if (fallbackCandidates.length > 0) {
        const result = new Map<string, MergedCandidate>();
        for (const c of fallbackCandidates) {
          if (!teamRegistry.has(c.ownerRef)) continue;
          result.set(c.ownerRef, {
            ownerRef: c.ownerRef,
            weightedScore: c.confidenceScore,
            reasons: [...c.confidenceReason],
          });
        }
        if (result.size > 0) return result;
      } else if (fallbackStrategy.triggersEscalation) {
        // Caller invokes the {@link EscalationTrigger} on `false`; we just
        // signal the no-candidates outcome here.
        return 'escalated';
      }
    } catch (error) {
      this.logger.warn(
        `Strategy "fallback" failed for entity ${entityId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return undefined;
  }

  private async persistProposals(
    activeCandidates: ScoredCandidate[],
    possibleOwners: ScoredCandidate[],
    entityId: string,
    scanId: string,
    persistedAccumulator?: PersistedProposalRef[],
  ): Promise<void> {
    const now = this.clock?.now() ?? new Date();

    // Buffer locally so partial-failure inside the tx never leaks into the
    // caller's accumulator (drained later for ProposalsBatchReady emission).
    const persisted: PersistedProposalRef[] = [];

    // Tag each candidate with the persistence mode so the single loop below
    // can handle both sets. `proposal_order` runs continuously: active
    // candidates first (already higher-scored), then possible owners.
    const work: { candidate: ScoredCandidate; possibleOwner: boolean }[] = [
      ...activeCandidates.map(c => ({ candidate: c, possibleOwner: false })),
      ...possibleOwners.map(c => ({ candidate: c, possibleOwner: true })),
    ];

    await this.store.withTransaction(async tx => {
      // Possible owners are regenerated wholesale each scan. Clear the stale set
      // first so scores stay fresh, a candidate can move between possible_owner
      // and active across scans, and re-scans don't accumulate duplicate rows
      // (possible_owner sits outside the active partial-unique index, so the DB
      // would not reject them).
      // Remember who was already a possible owner so a daily re-score doesn't
      // log a fresh `proposal_created` for an unchanged candidate.
      const previousPossibleOwners = new Set(
        (await tx.proposalStore.listProposalsByEntity(entityId))
          .filter(p => p.status === 'possible_owner')
          .map(p => p.proposed_owner_ref),
      );
      await tx.proposalStore.deletePossibleOwnersByEntity(entityId);

      let order = 0;

      for (const { candidate: c, possibleOwner } of work) {
        order += 1;
        let proposalId: string;
        try {
          proposalId = await tx.proposalStore.createProposal({
            entity_id: entityId,
            proposed_owner_ref: c.ownerRef,
            confidence_reason: JSON.stringify(c.reasons),
            confidence_score: c.normalizedScore,
            proposal_order: order,
            escalation_level: 0,
            ...(possibleOwner ? { status: 'possible_owner' as const } : {}),
          });
        } catch (error) {
          if (
            String(error).includes('unique constraint') ||
            String(error).includes('UNIQUE constraint')
          ) {
            this.logger.warn(
              `Skipping duplicate ${
                possibleOwner ? 'possible owner' : 'proposal'
              } ${c.ownerRef} for entity ${entityId}`,
            );
            order -= 1;
            continue;
          }
          throw error;
        }

        // Broadcast: every active proposal is activated (pending), given an
        // expiry deadline, and fed to the notification accumulator so all
        // above-threshold candidates are notified simultaneously.
        // Possible owners do none of this — they are stored inert for
        // voluntary claiming.
        if (!possibleOwner) {
          await tx.proposalStore.updateProposalStatus(proposalId, 'pending', {
            notifiedAt: now,
          });
          if (this.config.autoExpiry) {
            const expiryMs =
              this.config.expirationMinutes !== undefined
                ? this.config.expirationMinutes * MS_PER_MINUTE
                : this.config.expirationDays * MS_PER_DAY;
            await tx.pendingDeadlineStore.writeDeadline({
              entity_id: entityId,
              proposal_id: proposalId,
              deadline_type: 'proposal_expiry',
              fire_at: new Date(now.getTime() + expiryMs),
            });
          }
        }

        if (possibleOwner && previousPossibleOwners.has(c.ownerRef)) continue;

        await tx.historyStore.appendHistory({
          entity_id: entityId,
          proposal_id: proposalId,
          scan_id: scanId,
          action: 'proposal_created',
          actor: 'system',
          details: {
            ownerRef: c.ownerRef,
            reasons: c.reasons,
            score: c.normalizedScore,
            ...(possibleOwner ? { status: 'possible_owner' } : {}),
          },
        });

        // Only active proposals feed the notification accumulator.
        if (!possibleOwner) {
          persisted.push({ proposalId, ownerRef: c.ownerRef });
        }
      }
    });

    // Drain into caller-owned accumulator after the tx commits.
    if (persistedAccumulator && persisted.length > 0) {
      for (const ref of persisted) {
        persistedAccumulator.push(ref);
      }
    }
  }
}
