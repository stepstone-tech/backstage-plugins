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
import {
  normalizeGroupRef,
  type ScmClient,
  type ScmPullRequest,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { OwnershipStore } from '../service/DatabaseOwnershipStore';
import { PrStatePatch } from '../service/stores';
import { Clock } from '../escalation/Clock';
import {
  entityRepo,
  HistoryAction,
  OwnershipEntityRow,
  PrStatus,
} from '../types';
import type { PrCatalog } from './PrCreationService';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A case is reconciled at most this often; the deadline sweep runs more frequently. */
export const PR_RECONCILE_INTERVAL_MS = HOUR;

export const DEFAULT_PR_MERGE_GRACE_MS = 24 * HOUR;

/** The KPI is logged when a sweep changed a case, otherwise at most this often. */
const PR_KPI_LOG_INTERVAL_MS = HOUR;

/** Subset of `ScmRegistry` used here — kept narrow so tests can fake it. */
export interface ReconcileScm {
  clientFor(repo: ScmRepoRef): Promise<ScmClient | undefined>;
}

export interface PrReconciliationOptions {
  /**
   * Part B (PR state tracking). `undefined` = catalog-only reconciliation,
   * e.g. while PR automation is disabled and must not reach the SCM.
   */
  scm?: ReconcileScm;
  /** Catalog refresh lag allowed after a merge before the PR is flagged `failed`. */
  mergeGraceMs?: number;
}

/**
 * Whether the catalog's `spec.owner` is the accepted owner, comparing refs the
 * way the catalog resolves them: `team-x`, `group:team-x` and
 * `group:default/team-x` are the same owner, and refs are case-insensitive.
 * A missing catalog owner never matches.
 */
export function isAcceptedOwner(
  catalogOwner: string | undefined,
  acceptedOwner: string,
): boolean {
  const catalog = normalizeOwner(catalogOwner);
  return catalog !== undefined && catalog === normalizeOwner(acceptedOwner);
}

function normalizeOwner(ref: string | undefined): string | undefined {
  const trimmed = ref?.trim();
  return trimmed ? normalizeGroupRef(trimmed).toLowerCase() : undefined;
}

/** A state change worked out for one case. */
interface Transition {
  status: PrStatus;
  action: HistoryAction;
  details: Record<string, unknown>;
  lastError?: string | null;
  /** Logged as a warning (it needs a human), not as info. */
  warn?: boolean;
}

/**
 * Closes the loop on catalog-info PRs. A raised PR only proves
 * a PR was opened; this pass checks the outcome the epic cares about — the
 * catalog's `spec.owner` is the accepted team — and records it:
 *
 * - catalog owner = accepted owner → `completed`
 * - another owner on a case the scan closed as `ownership_changed` →
 *   `superseded`: the scan closes a case only once its owner passes every
 *   check, so someone else settled ownership; nothing more is raised
 * - another owner on a still-accepted case is not a third-party fix — the
 *   owner still fails the checks, even if its value changed — so for a raised
 *   PR it falls through to Part B (via the SCM provider): declined (or
 *   gone) → `declined`, retryable by hand; merged but the catalog still
 *   differs after the grace period → `failed`. An open PR is left alone: the
 *   accepting team is already reminded by the acceptance-pending
 *   notification, which links the PR.
 *
 * Cases whose PR `failed`, was `declined` or hit an `unsupported_scm` get
 * Part A only: a team that fixed the owner by hand still reaches `completed`,
 * and a third-party change still reaches `superseded` once the scan closed the
 * case (cancelling any queued retry).
 *
 * Part A (the catalog comparison) makes no SCM calls; Part B is skipped when
 * no SCM is given, the host has no provider with `pullRequests`, or the PR id
 * is unknown. Runs from the deadline sweep; each case at most once per
 * {@link PR_RECONCILE_INTERVAL_MS}. A running PR job (`pending`) is never
 * touched: every write is conditional on the `pr_status` the decision was
 * based on.
 */
export class PrReconciliationService {
  private readonly mergeGraceMs: number;
  private lastKpiLogAt: number | undefined;

  constructor(
    private readonly store: OwnershipStore,
    private readonly catalog: PrCatalog,
    private readonly clock: Clock,
    private readonly logger: LoggerService,
    private readonly options: PrReconciliationOptions = {},
  ) {
    this.mergeGraceMs = options.mergeGraceMs ?? DEFAULT_PR_MERGE_GRACE_MS;
  }

  /**
   * Reconcile every case not checked within {@link PR_RECONCILE_INTERVAL_MS},
   * then log the KPI — when a case changed, else at most once per
   * {@link PR_KPI_LOG_INTERVAL_MS}.
   */
  async reconcileDue(): Promise<void> {
    const now = this.clock.now();
    const due = await this.store.listEntitiesForPrReconciliation(
      new Date(now.getTime() - PR_RECONCILE_INTERVAL_MS),
    );
    let changed = false;
    for (const entity of due) {
      try {
        changed = (await this.reconcile(entity)) || changed;
      } catch (err) {
        this.logger.error(
          `[pr-reconciliation] failed to reconcile ${
            entity.entity_ref
          }: ${errorText(err)}`,
        );
      }
    }
    if (
      changed ||
      this.lastKpiLogAt === undefined ||
      now.getTime() - this.lastKpiLogAt >= PR_KPI_LOG_INTERVAL_MS
    ) {
      await this.logLoopClosed();
      this.lastKpiLogAt = now.getTime();
    }
  }

  /**
   * Reconcile one case and record the outcome (or just the check time).
   * Returns whether the case's `pr_status` changed.
   */
  async reconcile(entity: OwnershipEntityRow): Promise<boolean> {
    const transition = await this.decide(entity);
    const checkedAt = this.clock.now();
    if (!transition) {
      await this.store.withTransaction(tx =>
        tx.entityStore.updatePrStateIf(entity.id, entity.pr_status, {
          pr_checked_at: checkedAt,
        }),
      );
      return false;
    }
    // Completed and superseded cases need no further PR job: a queued retry
    // (e.g. after a `failed` attempt) is cancelled.
    const endsPrJobs =
      transition.status === 'completed' || transition.status === 'superseded';

    const patch: PrStatePatch = {
      pr_status: transition.status,
      pr_checked_at: checkedAt,
    };
    if (transition.lastError !== undefined)
      patch.pr_last_error = transition.lastError;
    const recorded = await this.store.withTransaction(async tx => {
      if (endsPrJobs) {
        // Serialise against a concurrent lease (lock order: deadline rows →
        // entity row, as in PrCreationService). A job leased first sets
        // `pending`, so the conditional write below then does nothing.
        await tx.pendingDeadlineStore.lockUnprocessedForEntity(entity.id, [
          'pr_creation',
        ]);
      }
      if (
        !(await tx.entityStore.updatePrStateIf(
          entity.id,
          entity.pr_status,
          patch,
        ))
      ) {
        return false;
      }
      if (endsPrJobs) {
        await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entity.id, [
          'pr_creation',
        ]);
      }
      await tx.historyStore.appendHistory({
        entity_id: entity.id,
        action: transition.action,
        actor: 'system',
        details: transition.details,
      });
      return true;
    });

    if (!recorded) {
      this.logger.info(
        `[pr-reconciliation] ${entity.entity_ref} left ${entity.pr_status} while reconciling; discarding ${transition.status}`,
      );
      return false;
    }
    const message = `[pr-reconciliation] ${entity.entity_ref}: ${entity.pr_status} → ${transition.status}`;
    if (transition.warn) {
      this.logger.warn(
        `${message} (${transition.lastError ?? transition.action})`,
      );
    } else {
      this.logger.info(message);
    }
    return true;
  }

  /** The transition for one case, or `undefined` when nothing changed (yet). */
  private async decide(
    entity: OwnershipEntityRow,
  ): Promise<Transition | undefined> {
    const acceptedOwner = await this.acceptedOwner(entity);
    if (!acceptedOwner) return undefined;

    // A catalog error throws: the case is retried on the next sweep.
    const catalogEntity = await this.catalog.getEntityByRef(entity.entity_ref);
    // Gone from the catalog: the scan's own reconciliation closes the case.
    if (!catalogEntity) return undefined;

    const catalogOwner = catalogEntity.spec?.owner;
    const owners = { catalogOwner: catalogOwner ?? null, acceptedOwner };

    if (isAcceptedOwner(catalogOwner, acceptedOwner)) {
      return {
        status: 'completed',
        action: 'pr_completed',
        details: { ...owners, prUrl: entity.pr_url },
        lastError: null,
      };
    }
    // Closed as `ownership_changed`: the scan saw an owner that passes every
    // check, and it isn't the accepted one — someone else settled ownership.
    if (entity.current_status === 'closed') {
      return catalogOwner?.trim()
        ? {
            status: 'superseded',
            action: 'pr_superseded',
            details: { ...owners, prUrl: entity.pr_url },
          }
        : undefined;
    }
    // Still accepted: the owner still fails the checks (else the scan would
    // have closed the case), whatever its value — wait for the PR.
    if (entity.pr_status !== 'raised') return undefined;
    return this.decideFromPullRequest(entity, owners);
  }

  /** Part B: the raised PR's state, when the SCM can tell. */
  private async decideFromPullRequest(
    entity: OwnershipEntityRow,
    owners: Record<string, string | null>,
  ): Promise<Transition | undefined> {
    const pr = await this.readPullRequest(entity);
    if (pr === 'unavailable') return undefined;

    const prDetails = { prId: entity.pr_id, prUrl: entity.pr_url };
    if (!pr || pr.state === 'declined') {
      return {
        status: 'declined',
        action: 'pr_declined',
        details: {
          ...prDetails,
          ...(pr
            ? { closedAt: pr.closedAt?.toISOString() }
            : { reason: 'pr_not_found' }),
        },
        lastError: pr
          ? 'The pull request was declined'
          : 'The pull request was not found (deleted, or the repository was moved or renamed)',
      };
    }
    if (pr.state === 'open') return undefined;

    // No merge time = no grace period to measure: wait rather than guess.
    const mergedAt = pr.closedAt;
    if (
      !mergedAt ||
      this.clock.now().getTime() - mergedAt.getTime() < this.mergeGraceMs
    ) {
      return undefined;
    }
    const lastError =
      `The pull request was merged on ${mergedAt.toISOString()}, but the catalog still shows ` +
      `spec.owner ${owners.catalogOwner ?? '<none>'} instead of ${
        owners.acceptedOwner
      }. ` +
      'It may have been merged into a branch the catalog does not read, or the file was overwritten since.';
    return {
      status: 'failed',
      action: 'pr_not_applied',
      details: { ...prDetails, ...owners, mergedAt: mergedAt.toISOString() },
      lastError,
      warn: true,
    };
  }

  /**
   * The PR via the provider serving the entity's repository. `'unavailable'`
   * when Part B can't run: no SCM, no repository/PR id, no provider with
   * `pullRequests` for the host, or a failed SCM call (logged).
   */
  private async readPullRequest(
    entity: OwnershipEntityRow,
  ): Promise<ScmPullRequest | undefined | 'unavailable'> {
    const repo = entityRepo(entity);
    if (!this.options.scm || !repo || !entity.pr_id) return 'unavailable';
    try {
      const prs = (await this.options.scm.clientFor(repo))?.pullRequests;
      if (!prs) return 'unavailable';
      return await prs.getPullRequest(repo, entity.pr_id);
    } catch (err) {
      this.logger.warn(
        `[pr-reconciliation] could not read PR ${entity.pr_id} for ${
          entity.entity_ref
        }: ${errorText(err)}`,
      );
      return 'unavailable';
    }
  }

  /** The owner the case was accepted for: the newest accepted proposal, else the assignee. */
  private async acceptedOwner(
    entity: OwnershipEntityRow,
  ): Promise<string | undefined> {
    const accepted = (await this.store.listProposalsByEntity(entity.id))
      .filter(p => p.status === 'accepted')
      .sort((a, b) => time(b.responded_at) - time(a.responded_at))[0];
    return accepted?.proposed_owner_ref ?? entity.assigned_to ?? undefined;
  }

  /** The epic's KPI: how many accepted cases have the accepted team as their catalog owner. */
  private async logLoopClosed(): Promise<void> {
    const counts = await this.store.countPrStatusesForAccepted();
    const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
    const breakdown = Object.entries(counts)
      .map(([status, n]) => `${status}=${n}`)
      .join(', ');
    this.logger.info(
      `[pr-reconciliation] loop closed for ${
        counts.completed ?? 0
      } of ${total} accepted case(s) (${breakdown})`,
      { loopClosed: counts.completed ?? 0, acceptedTotal: total },
    );
  }
}

function time(date: Date | null): number {
  return date ? new Date(date).getTime() : 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
