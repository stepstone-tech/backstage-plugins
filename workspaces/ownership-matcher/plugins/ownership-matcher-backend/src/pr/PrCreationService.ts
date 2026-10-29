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
import { ConflictError, NotFoundError } from '@backstage/errors';
import {
  isScmError,
  type ScmErrorKind,
  type ScmFileLocation,
  type ScmPullRequestCapability,
  type ScmPullRequestRef,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { OwnershipStore } from '../service/DatabaseOwnershipStore';
import { PrStatePatch } from '../service/stores';
import { Clock } from '../escalation/Clock';
import { PendingDeadlineRow } from '../escalation/types';
import {
  CatalogComponent,
  HistoryAction,
  OwnershipEntityRow,
  PrStatus,
} from '../types';
import { setSpecOwner, toCatalogOwnerValue } from './catalogInfoEditor';
import { EntityValidator } from './EntityValidator';
import type { ScmLocationResolution } from '../scm';

const MINUTE = 60_000;

/** Delay before auto-retry N (1-indexed). The last value is reused for later attempts. */
export const PR_RETRY_BACKOFF_MS = [
  5 * MINUTE,
  30 * MINUTE,
  120 * MINUTE,
  360 * MINUTE,
];

/**
 * Delay before retrying a repository that is read-only or archived — typically
 * mid-migration between SCMs, which takes days, not minutes.
 */
export const PR_READ_ONLY_BACKOFF_MS = 24 * 60 * MINUTE;

export const DEFAULT_PR_MAX_ATTEMPTS = 5;

/** `pr_status` values a manual Retry accepts. */
export const RETRYABLE_PR_STATUSES: readonly PrStatus[] = [
  'failed',
  'unsupported_scm',
  'declined',
];

/**
 * How long a started job owns its deadline row. Must comfortably exceed one
 * run (a handful of SCM calls, 30s timeout each). If the process dies
 * mid-job, the row becomes due again after this and the next sweep re-runs it.
 */
export const PR_JOB_LEASE_MS = 15 * MINUTE;

/** Subset of `ScmRegistry` used here — kept narrow so tests can fake it. */
export interface PrScm {
  forLocation(
    managedByLocation: string | undefined,
  ): Promise<ScmLocationResolution>;
}

/** Subset of `CatalogService` used here. */
export interface PrCatalog {
  getEntityByRef(entityRef: string): Promise<CatalogComponent | undefined>;
}

export interface PrCreationOptions {
  maxAttempts?: number;
  /** `app.title`, named in the PR description. Defaults to `Backstage`. */
  appTitle?: string;
}

/** Kicks a single `pr_creation` deadline right after it was enqueued (fire-and-forget by the caller). */
export interface PrCreationTrigger {
  trigger(deadlineId: string): Promise<void>;
}

/** Used in tests and when PR creation is disabled. */
export const noopPrCreationTrigger: PrCreationTrigger = {
  async trigger() {},
};

/**
 * A failed step. `retryable` failures get an automatic retry deadline (with
 * backoff, up to `maxAttempts`); permanent ones (file/entity not found,
 * validation errors, auth) only wait for a manual retry, since retrying
 * unchanged input cannot succeed. `scmKind` is set when the cause was an
 * {@link ScmError}; a read-only repository retries after
 * {@link PR_READ_ONLY_BACKOFF_MS} instead of the normal backoff.
 */
class PrStepError extends Error {
  constructor(
    readonly step: string,
    message: string,
    readonly retryable: boolean,
    readonly scmKind?: ScmErrorKind,
  ) {
    super(message);
  }
}

/** The repository's PR capability plus the parsed catalog-info location. */
interface PrTarget {
  prs: ScmPullRequestCapability;
  location: ScmFileLocation;
  repo: ScmRepoRef;
}

type RunOutcome =
  | {
      kind: 'raised';
      action: 'pr_raised' | 'pr_reused';
      pr: ScmPullRequestRef;
      branch: string;
      /** Extra history details about who was requested for review. */
      reviewerDetails?: Record<string, unknown>;
    }
  | { kind: 'skipped'; reason: string }
  /** No installed SCM provider can raise PRs for the entity's repository. Terminal. */
  | { kind: 'unsupported'; message: string; details: Record<string, unknown> };

/**
 * Drains `pr_creation` deadlines: opens a PR setting
 * `spec.owner` in the entity's catalog-info.yaml to the accepting team, via
 * the SCM provider serving the entity's `managed-by-location`.
 *
 * All SCM/catalog I/O runs OUTSIDE database transactions; only the
 * lease and the final state write are transactional. Every exit path records
 * `pr_status` + an `ownership_history` row and marks the deadline processed in
 * that same transaction. A job is never stranded: the deadline is only
 * *leased* when work starts (see {@link PR_JOB_LEASE_MS}), so if the process
 * dies or the final write throws, the lease expires and the next sweep re-runs
 * it. Re-runs are safe — an open PR on the job's branch is found and reused.
 */
export class PrCreationService implements PrCreationTrigger {
  private readonly maxAttempts: number;
  private readonly appTitle: string;

  constructor(
    private readonly store: OwnershipStore,
    private readonly scm: PrScm,
    private readonly catalog: PrCatalog,
    private readonly validator: EntityValidator,
    private readonly clock: Clock,
    private readonly logger: LoggerService,
    options: PrCreationOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_PR_MAX_ATTEMPTS;
    this.appTitle = options.appTitle ?? 'Backstage';
  }

  /** Process every due `pr_creation` deadline. Called by the deadline-checker scheduled task. */
  async processDue(): Promise<void> {
    const due = await this.store.findExpiredDeadlines(this.clock.now(), {
      types: ['pr_creation'],
    });
    for (const row of due) {
      try {
        await this.trigger(row.id);
      } catch (err) {
        this.logger.error(
          `[pr-creation] failed to process deadline ${row.id}: ${errorText(
            err,
          )}`,
        );
      }
    }
  }

  /**
   * {@inheritdoc PrCreationTrigger.trigger} — lease (SKIP LOCKED, so the kick
   * and the worker never both run a job) then run. Leasing instead of marking
   * processed up front is what makes a crash mid-job recoverable.
   *
   * The same transaction sets `pr_status = 'pending'`, so a manual Retry
   * (which requires `failed`) is refused while a job is running — otherwise an
   * auto-retry still showing `failed` could run alongside a user-triggered one
   * and open a second PR. Lock order is deadline row → entity row, matching
   * {@link requestRetry}.
   */
  async trigger(deadlineId: string): Promise<void> {
    const now = this.clock.now();
    const row = await this.store.withTransaction(async tx => {
      const leased = await tx.pendingDeadlineStore.leaseDeadline(
        deadlineId,
        now,
        new Date(now.getTime() + PR_JOB_LEASE_MS),
      );
      if (leased) {
        await tx.entityStore.updatePrState(leased.entity_id, {
          pr_status: 'pending',
        });
      }
      return leased;
    });
    if (!row) return;
    await this.run(row);
  }

  /**
   * Manual retry after a failure: resets the attempt counter and enqueues a
   * fresh job, then kicks it (fire-and-forget). The reviewer stays the user who
   * accepted ownership (`resolved_by`), not the person clicking retry.
   */
  async requestRetry(
    entityId: string,
    actorRef: string,
  ): Promise<OwnershipEntityRow> {
    const deadlineId = await this.store.withTransaction(async tx => {
      // Serialise against a concurrent lease (same lock order: deadline rows →
      // entity row). If a job got leased first we wait for it to commit and
      // then see `pending` below, so the retry is refused instead of starting
      // a second, concurrent run.
      await tx.pendingDeadlineStore.lockUnprocessedForEntity(entityId, [
        'pr_creation',
      ]);
      const entity = await tx.entityStore.getEntityByIdForUpdate(entityId);
      if (!entity) throw new NotFoundError(`Entity ${entityId} not found`);
      if (entity.current_status !== 'accepted') {
        throw new ConflictError(
          `Entity ${entityId} is ${entity.current_status}, not accepted`,
        );
      }
      // `unsupported_scm` is retryable by hand: installing a provider module
      // (or adding the integration) later makes the job runnable. A `declined`
      // PR is retried by raising a fresh one.
      if (!RETRYABLE_PR_STATUSES.includes(entity.pr_status)) {
        throw new ConflictError(
          `PR for entity ${entityId} is ${
            entity.pr_status
          }; only ${RETRYABLE_PR_STATUSES.join(', ')} PRs can be retried`,
        );
      }
      const accepted = (
        await tx.proposalStore.listProposalsByEntity(entityId)
      ).find(p => p.status === 'accepted');

      await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
        'pr_creation',
      ]);
      const id = await tx.pendingDeadlineStore.writeDeadline({
        entity_id: entityId,
        proposal_id: accepted?.id ?? null,
        deadline_type: 'pr_creation',
        fire_at: this.clock.now(),
        actor_ref: entity.resolved_by,
      });
      await tx.entityStore.updatePrState(entityId, {
        pr_status: 'pending',
        pr_attempts: 0,
        pr_last_error: null,
      });
      await tx.historyStore.appendHistory({
        entity_id: entityId,
        proposal_id: accepted?.id,
        action: 'pr_retry_requested',
        actor: actorRef,
        details: {
          previousAttempts: entity.pr_attempts,
          previousError: entity.pr_last_error,
        },
      });
      return id;
    });

    void this.trigger(deadlineId).catch(err =>
      this.logger.error(
        `[pr-creation] retry kick for entity ${entityId} failed: ${errorText(
          err,
        )}`,
      ),
    );

    return (await this.store.getEntityById(entityId))!;
  }

  /**
   * Execute one leased `pr_creation` deadline. `deadline.fire_at` is the
   * lease expiry returned by {@link leaseDeadline} and doubles as this run's
   * ownership token when the outcome is written.
   */
  async run(deadline: PendingDeadlineRow): Promise<void> {
    const entity = await this.store.getEntityById(deadline.entity_id);
    if (!entity) {
      this.logger.warn(
        `[pr-creation] deadline ${deadline.id} references missing entity ${deadline.entity_id}`,
      );
      await this.store.withTransaction(tx =>
        tx.pendingDeadlineStore.completeLease(
          deadline.id,
          deadline.fire_at,
          this.clock.now(),
        ),
      );
      return;
    }

    let outcome: RunOutcome;
    try {
      outcome = await this.execute(deadline, entity);
    } catch (err) {
      const failure =
        err instanceof PrStepError
          ? err
          : new PrStepError('unexpected', errorText(err), true);
      await this.recordFailure(deadline, entity, failure);
      return;
    }

    if (outcome.kind === 'unsupported') {
      this.logger.warn(
        `[pr-creation] ${entity.entity_ref}: ${outcome.message}`,
      );
      await this.recordState(deadline, entity, {
        patch: { pr_status: 'unsupported_scm', pr_last_error: outcome.message },
        action: 'pr_creation_skipped',
        details: {
          reason: 'unsupported_scm',
          message: outcome.message,
          ...outcome.details,
        },
      });
      return;
    }

    if (outcome.kind === 'skipped') {
      await this.recordState(deadline, entity, {
        patch: { pr_status: 'none', pr_last_error: null },
        action: 'pr_creation_skipped',
        details: { reason: outcome.reason },
      });
      return;
    }

    await this.recordState(deadline, entity, {
      patch: {
        pr_status: 'raised',
        pr_url: outcome.pr.url,
        pr_id: outcome.pr.id,
        pr_branch: outcome.branch,
        pr_last_error: null,
        // Reconcile the new PR on the next sweep.
        pr_checked_at: null,
      },
      action: outcome.action,
      details: {
        prId: outcome.pr.id,
        prUrl: outcome.pr.url,
        branch: outcome.branch,
        ...outcome.reviewerDetails,
      },
    });
    this.logger.info(
      `[pr-creation] ${outcome.action} for ${entity.entity_ref}: ${outcome.pr.url}`,
    );
  }

  /** Orchestrates one PR job; each step lives in its own helper and throws a {@link PrStepError} on failure. */
  private async execute(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): Promise<RunOutcome> {
    const owner = await this.resolveOwner(deadline, entity);
    if (owner.kind === 'skipped') return owner;
    const { ownerValue } = owner;

    const located = await this.locateFile(entity);
    if ('kind' in located) return located;
    const { target, locationRef, baseBranch } = located;

    // Reuse an open PR if one exists (at most one per entity).
    const preferredBranch = branchNameFor(entity);
    const existing = await this.findExistingPr(target, entity, preferredBranch);

    // Read, edit, validate — before creating anything in the SCM. A branch a
    // previous attempt created but never opened a PR from is read (and later
    // reused) instead of the base branch, so retries don't pile up branches.
    const { edited, leftover } = await this.readForWork(
      target,
      entity,
      existing?.branch,
      baseBranch,
      ownerValue,
    );
    if (edited.status === 'unchanged' && !leftover) {
      return existing
        ? this.reuseOpenPr(deadline, entity, target, ownerValue, existing)
        : { kind: 'skipped', reason: 'already_up_to_date' };
    }
    if (edited.status === 'changed') {
      await this.validateEdit(edited.entity, locationRef);
    }

    const workBranch =
      existing?.branch ??
      leftover ??
      (await this.createWorkBranch(
        deadline,
        entity,
        target,
        preferredBranch,
        baseBranch,
      ));
    if (edited.status === 'changed') {
      await this.commitEdit(
        target,
        workBranch,
        edited,
        entity,
        ownerValue,
        locationRef,
      );
    }

    if (existing) {
      return this.reuseOpenPr(deadline, entity, target, ownerValue, existing);
    }
    return this.openPullRequest(
      deadline,
      entity,
      target,
      ownerValue,
      workBranch,
      baseBranch,
    );
  }

  /**
   * Pick the branch to read from and run the edit. Order: the open PR's
   * branch, else a leftover work branch from a failed attempt (`pr_branch`
   * set, no PR ever opened → `pr_url` null), else the base branch. A leftover
   * that has since been deleted reads as not-found; fall back to the base
   * branch and let a fresh branch be created.
   */
  private async readForWork(
    target: PrTarget,
    entity: OwnershipEntityRow,
    openPrBranch: string | undefined,
    baseBranch: string,
    ownerValue: string,
  ): Promise<{ edited: EditResult; leftover?: string }> {
    if (openPrBranch) {
      return {
        edited: await this.readAndEdit(
          target,
          openPrBranch,
          entity,
          ownerValue,
        ),
      };
    }
    const leftover =
      entity.pr_branch && !entity.pr_url ? entity.pr_branch : undefined;
    if (leftover) {
      const fromLeftover = await this.readAndEdit(
        target,
        leftover,
        entity,
        ownerValue,
        {
          missingIsRetryable: true,
        },
      );
      if (fromLeftover) return { edited: fromLeftover, leftover };
      this.logger.info(
        `[pr-creation] leftover branch ${leftover} for ${entity.entity_ref} is gone; starting from ${baseBranch}`,
      );
    }
    return {
      edited: await this.readAndEdit(target, baseBranch, entity, ownerValue),
    };
  }

  /** The owner to write, or a `skipped` outcome when the job is stale. */
  private async resolveOwner(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
  ): Promise<
    | { kind: 'owner'; ownerValue: string }
    | Extract<RunOutcome, { kind: 'skipped' }>
  > {
    if (entity.current_status !== 'accepted') {
      return { kind: 'skipped', reason: `entity_${entity.current_status}` };
    }
    const proposal = deadline.proposal_id
      ? await this.store.getProposal(deadline.proposal_id)
      : undefined;
    if (proposal && proposal.status !== 'accepted') {
      return { kind: 'skipped', reason: `proposal_${proposal.status}` };
    }
    const ownerRef = proposal?.proposed_owner_ref ?? entity.assigned_to;
    if (!ownerRef) {
      throw new PrStepError(
        'resolve-owner',
        'No accepted owner to write',
        false,
      );
    }
    return { kind: 'owner', ownerValue: toCatalogOwnerValue(ownerRef) };
  }

  /**
   * Find the catalog-info file via the catalog entity's `managed-by-location`
   * and route it to the SCM provider for its host. No provider (or one
   * without the `pullRequests` capability) is the terminal `unsupported` outcome.
   */
  private async locateFile(
    entity: OwnershipEntityRow,
  ): Promise<
    | { target: PrTarget; locationRef: string; baseBranch: string }
    | Extract<RunOutcome, { kind: 'unsupported' }>
  > {
    const catalogEntity = await this.catalog.getEntityByRef(entity.entity_ref);
    if (!catalogEntity) {
      throw new PrStepError(
        'locate',
        `Entity ${entity.entity_ref} not found in catalog`,
        false,
      );
    }
    const locationRef =
      catalogEntity.metadata.annotations?.['backstage.io/managed-by-location'];
    const resolved = await this.scm.forLocation(locationRef);
    switch (resolved.status) {
      case 'no-integration':
        return {
          kind: 'unsupported',
          message: `No SCM integration is configured for ${resolved.host}`,
          details: { host: resolved.host },
        };
      case 'no-provider':
        return {
          kind: 'unsupported',
          message: `No ownership-matcher SCM provider is installed for ${resolved.type} (${resolved.host})`,
          details: { host: resolved.host, scmType: resolved.type },
        };
      case 'missing':
      case 'unparseable':
        throw new PrStepError(
          'locate',
          `Unsupported or missing backstage.io/managed-by-location: ${
            locationRef ?? '<none>'
          }`,
          false,
        );
      default:
        break;
    }
    const { client, location } = resolved;
    if (!client.pullRequests) {
      return {
        kind: 'unsupported',
        message: `The ${location.repo.type} SCM provider for ${location.repo.host} cannot raise pull requests`,
        details: { host: location.repo.host, scmType: location.repo.type },
      };
    }
    const target: PrTarget = {
      prs: client.pullRequests,
      location,
      repo: location.repo,
    };
    const baseBranch = await this.resolveBaseBranch(target);
    return { target, locationRef: locationRef!, baseBranch };
  }

  /**
   * Read the file from `branch` and set `spec.owner`. With
   * `missingIsRetryable`, a not-found (e.g. the branch was deleted) returns
   * `undefined` instead of failing the job.
   */
  private async readAndEdit(
    target: PrTarget,
    branch: string,
    entity: OwnershipEntityRow,
    ownerValue: string,
  ): Promise<EditResult>;
  private async readAndEdit(
    target: PrTarget,
    branch: string,
    entity: OwnershipEntityRow,
    ownerValue: string,
    opts: { missingIsRetryable: true },
  ): Promise<EditResult | undefined>;
  private async readAndEdit(
    target: PrTarget,
    branch: string,
    entity: OwnershipEntityRow,
    ownerValue: string,
    opts?: { missingIsRetryable: true },
  ): Promise<EditResult | undefined> {
    const { repo, path: filePath } = target.location;
    const file = await scmStep('read', `Failed to read ${filePath}`, () =>
      target.prs.readFile(repo, filePath, branch),
    );
    if (!file && opts?.missingIsRetryable) return undefined;
    if (!file) {
      throw new PrStepError(
        'read',
        `${filePath} not found in ${repo.path}@${branch}`,
        false,
      );
    }

    const edit = setSpecOwner(
      file.content,
      {
        kind: entity.entity_kind,
        name: entity.entity_name,
        namespace: entity.entity_namespace,
      },
      ownerValue,
    );
    switch (edit.status) {
      case 'unchanged':
        return edit;
      case 'entity-not-found':
        throw new PrStepError(
          'edit',
          `${entity.entity_kind}:${entity.entity_name} not found in ${filePath}`,
          false,
        );
      case 'parse-error':
        throw new PrStepError(
          'edit',
          `Cannot edit ${filePath}: ${edit.message}`,
          false,
        );
      default:
        return { ...edit, revision: file.revision };
    }
  }

  /** Validate the edited entity against the catalog, including any custom catalog processors. */
  private async validateEdit(
    entity: Record<string, unknown>,
    locationRef: string,
  ): Promise<void> {
    const validation = await this.validator.validate(entity, locationRef);
    if (validation.status === 'unavailable') {
      throw new PrStepError(
        'validate',
        `Validator unavailable: ${validation.message}`,
        true,
      );
    }
    if (validation.status === 'invalid') {
      throw new PrStepError(
        'validate',
        `Edited entity failed validation: ${validation.errors.join('; ')}`,
        false,
      );
    }
  }

  /**
   * Commit the edit. If the file changed on `branch` since it was read (a
   * `conflict`), re-read, re-edit and re-validate once and commit again —
   * unless the fresh content already has the owner, which needs no commit.
   */
  private async commitEdit(
    target: PrTarget,
    branch: string,
    edited: Extract<EditResult, { status: 'changed' }>,
    entity: OwnershipEntityRow,
    ownerValue: string,
    locationRef: string,
  ): Promise<void> {
    const { repo, path: filePath } = target.location;
    const commit = (edit: Extract<EditResult, { status: 'changed' }>) =>
      scmStep('commit', `Failed to commit ${filePath} to ${branch}`, () =>
        target.prs.commitFile(repo, filePath, {
          content: edit.content,
          message: `chore(ownership): set spec.owner to ${ownerValue}`,
          branch,
          revision: edit.revision,
        }),
      );
    try {
      await commit(edited);
    } catch (err) {
      if (!(err instanceof PrStepError && err.scmKind === 'conflict'))
        throw err;
      this.logger.info(
        `[pr-creation] ${filePath} changed on ${branch} while editing ${entity.entity_ref}; re-reading`,
      );
      const fresh = await this.readAndEdit(target, branch, entity, ownerValue);
      if (fresh.status === 'unchanged') return;
      await this.validateEdit(fresh.entity, locationRef);
      await commit(fresh);
    }
  }

  /**
   * Open the PR. Reviewers = the user who accepted ownership + the repo's
   * default reviewers (some SCMs, e.g. Bitbucket, don't apply defaults to
   * API-created PRs).
   */
  private async openPullRequest(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    target: PrTarget,
    ownerValue: string,
    workBranch: string,
    baseBranch: string,
  ): Promise<RunOutcome> {
    const { prs, repo } = target;
    const acceptor = deadline.actor_ref
      ? await this.resolveReviewer(target, deadline.actor_ref)
      : undefined;
    const defaults = await this.defaultReviewers(
      target,
      workBranch,
      baseBranch,
    );
    const fallback = acceptor ? [acceptor] : [];
    const reviewers = dedupeSlugs([...fallback, ...(defaults ?? [])]);
    const reviewerDetails: Record<string, unknown> = { reviewers };
    if (!acceptor) reviewerDetails.reviewerUnresolved = true;
    if (defaults === null) reviewerDetails.defaultReviewersUnresolved = true;

    const prRequest = {
      ...this.prText(entity, ownerValue, deadline.actor_ref),
      fromBranch: workBranch,
      toBranch: baseBranch,
    };
    const create = (prReviewers: string[]) =>
      prs.createPullRequest(repo, { ...prRequest, reviewers: prReviewers });
    // An SCM may reject the whole PR if any reviewer is invalid — e.g. a
    // reviewer who is the PR author (the token's user), lacks repo access or is
    // inactive. Don't fail the job over that: drop the reviewers it names, or
    // (if it doesn't say which) fall back to just the acceptor. If every
    // reviewer is refused the PR is raised with none — the ownership change
    // matters more than the reviewers; `reviewersFallback` records why.
    // Terminates: `nextReviewers` always returns a strictly shorter list.
    let attempt = reviewers;
    const fallbacks: Array<{ rejected: string[]; reason: string }> = [];
    let pr: Awaited<ReturnType<typeof create>> | undefined;
    while (!pr) {
      try {
        pr = await create(attempt);
      } catch (err) {
        const next =
          isScmError(err) && err.kind === 'invalid'
            ? nextReviewers(attempt, fallback, err.rejectedReviewers)
            : undefined;
        if (!next)
          throw toStepError('pull-request', 'Failed to create PR', err);
        const reason = err.message || `HTTP ${err.httpStatus ?? 400}`;
        this.logger.warn(
          `[pr-creation] PR with reviewers [${attempt.join(
            ', ',
          )}] rejected for ${
            entity.entity_ref
          } (${reason}); retrying with [${next.join(', ')}]`,
        );
        fallbacks.push({ rejected: err.rejectedReviewers ?? attempt, reason });
        attempt = next;
      }
    }
    if (fallbacks.length) {
      // A single fallback stays an object, the shape existing history rows have.
      reviewerDetails.reviewersFallback =
        fallbacks.length === 1 ? fallbacks[0] : fallbacks;
      reviewerDetails.reviewers = attempt;
    }
    return {
      kind: 'raised',
      action: pr.status === 'reused' ? 'pr_reused' : 'pr_raised',
      pr: pr.pr,
      branch: workBranch,
      reviewerDetails,
    };
  }

  private async resolveBaseBranch(target: PrTarget): Promise<string> {
    if (target.location.ref) return target.location.ref;
    try {
      return await target.prs.getDefaultBranch(target.repo);
    } catch (err) {
      if (isScmError(err) && err.kind === 'not-found') {
        throw new PrStepError(
          'locate',
          `Repository ${target.repo.path} not found`,
          false,
        );
      }
      throw toStepError('locate', 'Failed to resolve default branch', err);
    }
  }

  /** Default reviewers, or `null` when the lookup failed (recorded, not fatal). */
  private async defaultReviewers(
    target: PrTarget,
    fromBranch: string,
    toBranch: string,
  ): Promise<string[] | null> {
    try {
      return await target.prs.getDefaultReviewers(target.repo, {
        fromBranch,
        toBranch,
      });
    } catch (err) {
      this.logger.warn(
        `[pr-creation] could not resolve default reviewers for ${
          target.repo.path
        }: ${errorText(err)}`,
      );
      return null;
    }
  }

  /** Look for an open PR on the previously recorded branch, then on the deterministic one. */
  private async findExistingPr(
    target: PrTarget,
    entity: OwnershipEntityRow,
    preferredBranch: string,
  ): Promise<{ pr: ScmPullRequestRef; branch: string } | undefined> {
    const candidates = [
      ...new Set(
        [entity.pr_branch, preferredBranch].filter(Boolean) as string[],
      ),
    ];
    for (const branch of candidates) {
      const pr = await scmStep(
        'find-pr',
        'Failed to look up existing pull requests',
        () => target.prs.findOpenPullRequest(target.repo, branch),
      );
      if (pr) return { pr, branch };
    }
    return undefined;
  }

  /**
   * Create the work branch. If the deterministic name already exists without
   * an open PR (left over from a merged/declined PR — this job didn't create
   * it), use a suffixed name so the new PR doesn't inherit stale commits.
   *
   * The new branch is saved as `pr_branch` (with `pr_url` cleared) right away,
   * so if the commit or PR step fails, the next attempt reuses this branch
   * instead of creating another one.
   */
  private async createWorkBranch(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    target: PrTarget,
    preferred: string,
    baseBranch: string,
  ): Promise<string> {
    const names = [
      preferred,
      `${preferred}-${this.clock.now().getTime().toString(36)}`,
    ];
    for (const name of names) {
      const result = await scmStep(
        'branch',
        `Failed to create branch ${name}`,
        () => target.prs.createBranch(target.repo, name, baseBranch),
      );
      if (result === 'created') {
        await this.rememberWorkBranch(deadline, entity, name);
        return name;
      }
    }
    throw new PrStepError('branch', `Branch ${preferred} already exists`, true);
  }

  /** Persist the branch this run created — only while it still owns the job, so a superseded run can't clobber a newer one's branch. */
  private async rememberWorkBranch(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    branch: string,
  ): Promise<void> {
    await this.store.withTransaction(async tx => {
      if (
        await tx.pendingDeadlineStore.isLeaseHeld(deadline.id, deadline.fire_at)
      ) {
        await tx.entityStore.updatePrState(entity.id, {
          pr_branch: branch,
          pr_url: null,
        });
      }
    });
  }

  private async resolveReviewer(
    target: PrTarget,
    userRef: string,
  ): Promise<string | undefined> {
    try {
      const user = await this.catalog.getEntityByRef(userRef);
      const email = user?.spec?.profile?.email;
      if (typeof email !== 'string' || !email) return undefined;
      return await target.prs.resolveReviewer(target.repo, email);
    } catch (err) {
      this.logger.warn(
        `[pr-creation] could not resolve reviewer ${userRef}: ${errorText(
          err,
        )}`,
      );
      return undefined;
    }
  }

  /**
   * Reuse an already-open PR (at most one per entity). The PR may have been
   * opened for a different owner (the case was reopened and re-accepted by
   * another team), so bring its title/description in line with the new commit
   * and add the new acceptor as reviewer. Best-effort: the commit is already
   * on the PR, so a failed update is recorded but doesn't fail the job.
   */
  private async reuseOpenPr(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    target: PrTarget,
    ownerValue: string,
    existing: { pr: ScmPullRequestRef; branch: string },
  ): Promise<RunOutcome> {
    const acceptor = deadline.actor_ref
      ? await this.resolveReviewer(target, deadline.actor_ref)
      : undefined;
    const reviewerDetails: Record<string, unknown> = {};
    try {
      reviewerDetails.prSync = await target.prs.updatePullRequest(
        target.repo,
        existing.pr,
        {
          ...this.prText(entity, ownerValue, deadline.actor_ref),
          addReviewers: acceptor ? [acceptor] : [],
        },
      );
    } catch (err) {
      this.logger.warn(
        `[pr-creation] could not update reused PR ${existing.pr.url} for ${
          entity.entity_ref
        }: ${errorText(err)}`,
      );
      reviewerDetails.prSync = 'error';
      reviewerDetails.prSyncError = errorText(err);
    }
    return {
      kind: 'raised',
      action: 'pr_reused',
      pr: existing.pr,
      branch: existing.branch,
      reviewerDetails,
    };
  }

  /** Title + description for the PR — shared by new and reused PRs so they always match the commit. */
  private prText(
    entity: OwnershipEntityRow,
    ownerValue: string,
    actorRef: string | null,
  ): { title: string; description: string } {
    return {
      title: `Set owner of ${entity.entity_name} to ${ownerValue}`,
      description: this.describe(entity, ownerValue, actorRef),
    };
  }

  private describe(
    entity: OwnershipEntityRow,
    ownerValue: string,
    actorRef: string | null,
  ): string {
    const acceptedBy = actorRef ? ` (accepted by \`${actorRef}\`)` : '';
    return [
      `Ownership of \`${entity.entity_ref}\` was accepted by **${ownerValue}**${acceptedBy} in ${this.appTitle}.`,
      '',
      'This PR updates `spec.owner` in the catalog descriptor accordingly. It was raised automatically by the Ownership Matcher.',
    ].join('\n');
  }

  private async recordFailure(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    failure: PrStepError,
  ): Promise<void> {
    const attempt = entity.pr_attempts + 1;
    const willRetry = failure.retryable && attempt < this.maxAttempts;
    const retryAt = willRetry
      ? new Date(
          this.clock.now().getTime() +
            (failure.scmKind === 'read-only'
              ? PR_READ_ONLY_BACKOFF_MS
              : PR_RETRY_BACKOFF_MS[
                  Math.min(attempt - 1, PR_RETRY_BACKOFF_MS.length - 1)
                ]),
        )
      : undefined;

    const retryNote = retryAt ? ` — retrying at ${retryAt.toISOString()}` : '';
    this.logger.warn(
      `[pr-creation] ${entity.entity_ref} failed at ${failure.step} (attempt ${attempt}): ${failure.message}${retryNote}`,
    );

    await this.recordState(deadline, entity, {
      patch: {
        pr_status: 'failed',
        pr_attempts: attempt,
        pr_last_error: failure.message,
      },
      action: 'pr_creation_failed',
      details: {
        step: failure.step,
        reason: failure.message,
        attempt,
        retryable: failure.retryable,
        ...(retryAt ? { nextRetryAt: retryAt.toISOString() } : {}),
      },
      retryAt,
    });
  }

  private async recordState(
    deadline: PendingDeadlineRow,
    entity: OwnershipEntityRow,
    opts: {
      patch: PrStatePatch;
      action: HistoryAction;
      details: Record<string, unknown>;
      retryAt?: Date;
    },
  ): Promise<void> {
    const recorded = await this.store.withTransaction(async tx => {
      // Done only once the outcome is persisted — same tx as the state write.
      // If this run no longer owns the job (cancelled by a retry/re-acceptance,
      // or re-leased after the lease expired) a newer run is authoritative:
      // write nothing, so we neither clobber its state nor add a retry.
      const owned = await tx.pendingDeadlineStore.completeLease(
        deadline.id,
        deadline.fire_at,
        this.clock.now(),
      );
      if (!owned) return false;
      await tx.entityStore.updatePrState(entity.id, opts.patch);
      await tx.historyStore.appendHistory({
        entity_id: entity.id,
        proposal_id: deadline.proposal_id ?? undefined,
        action: opts.action,
        actor: 'system',
        details: opts.details,
      });
      if (opts.retryAt) {
        await tx.pendingDeadlineStore.writeDeadline({
          entity_id: entity.id,
          proposal_id: deadline.proposal_id,
          deadline_type: 'pr_creation',
          fire_at: opts.retryAt,
          actor_ref: deadline.actor_ref,
        });
      }
      return true;
    });
    if (!recorded) {
      this.logger.warn(
        `[pr-creation] deadline ${deadline.id} for ${
          entity.entity_ref
        } was superseded while running; discarding its outcome (${
          opts.action
        } ${JSON.stringify(opts.details)})`,
      );
    }
  }
}

/** Result of editing the catalog-info file read from a branch. */
type EditResult =
  | { status: 'unchanged' }
  | {
      status: 'changed';
      content: string;
      entity: Record<string, unknown>;
      revision: string;
    };

/** Deterministic per-entity branch name, e.g. `ownership/my-service-1a2b3c4d`. */
export function branchNameFor(
  entity: Pick<OwnershipEntityRow, 'id' | 'entity_name'>,
): string {
  const safeName = entity.entity_name
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-');
  const idPrefix = entity.id.replaceAll('-', '').slice(0, 8);
  return `ownership/${safeName}-${idPrefix}`;
}

/** Run one SCM call, turning any failure into a {@link PrStepError} for `step`. */
async function scmStep<T>(
  step: string,
  failure: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw toStepError(step, failure, err);
  }
}

/**
 * Map an SCM failure onto the job's retry policy: `auth`, `not-found` and
 * `invalid` are terminal (only a manual retry), `read-only` retries after a
 * long backoff, `conflict` is retried in-run by {@link PrCreationService},
 * everything else uses the provider's `retryable` (or retries, if it isn't an
 * {@link ScmError}).
 */
function toStepError(step: string, failure: string, err: unknown): PrStepError {
  if (!isScmError(err)) {
    return new PrStepError(step, `${failure}: ${errorText(err)}`, true);
  }
  const status = err.httpStatus ? ` (HTTP ${err.httpStatus})` : '';
  const message = `${failure}${status}${err.message ? `: ${err.message}` : ''}`;
  switch (err.kind) {
    case 'auth':
    case 'not-found':
    case 'invalid':
      return new PrStepError(step, message, false, err.kind);
    case 'read-only':
    case 'conflict':
      return new PrStepError(step, message, true, err.kind);
    default:
      return new PrStepError(step, message, err.retryable, err.kind);
  }
}

/**
 * The reviewer list to retry with after `current` was rejected, or `undefined`
 * when there's nothing left to drop: without the named `rejected` reviewers if
 * that removes any, else just the acceptor (`fallback`) if that is shorter.
 */
function nextReviewers(
  current: string[],
  fallback: string[],
  rejected: string[] | undefined,
): string[] | undefined {
  if (rejected?.length) {
    const drop = new Set(rejected.map(r => r.toLowerCase()));
    const kept = current.filter(r => !drop.has(r.toLowerCase()));
    if (kept.length < current.length) return kept;
  }
  const inCurrent = new Set(current.map(r => r.toLowerCase()));
  const acceptorOnly = fallback.filter(r => inCurrent.has(r.toLowerCase()));
  return current.length > acceptorOnly.length ? acceptorOnly : undefined;
}

/** Case-insensitive de-duplication, keeping first occurrence order (acceptor first). */
function dedupeSlugs(slugs: string[]): string[] {
  const seen = new Set<string>();
  return slugs.filter(slug => {
    const key = slug.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
