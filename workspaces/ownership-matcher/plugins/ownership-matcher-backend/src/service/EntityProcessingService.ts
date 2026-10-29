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
import { ConflictError } from '@backstage/errors';
import { EventsService } from '@backstage/plugin-events-node';
import { ScmRegistry } from '../scm';
import {
  PersistedProposalRef,
  ProposalGenerationService,
} from './ProposalGenerationService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import {
  OwnershipCheck,
  OwnershipCheckContext,
  BUILTIN_CHECK_PRIORITY,
} from '../checks';
import {
  EntityStatus,
  OwnershipEntityRow,
  ResolutionType,
  UNRESOLVED_REASON_ACTIONS,
} from '../types';
import {
  CatalogComponent,
  CatalogService,
  EntityFilters,
  ScmRepoRef,
  buildExcludeTypeSet,
  isTypeExcluded,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ScanStats } from './OwnershipMatcherService';
import {
  AcceptancePendingEventPayload,
  NotificationsTopic,
} from './notifications/topics';
import { EscalationTrigger } from '../escalation/EscalationTrigger';

const SKIP_REGENERATION_STATUSES: ReadonlySet<EntityStatus> = new Set([
  'escalated',
  'accepted',
  'to_archive',
]);

/** Builds a canonical entity ref string from a catalog entity. Format: `kind:namespace/name` (kind lowercase, namespace as-is from catalog). Used for DB storage and seenEntityRefs lookups — must stay in sync with the format written by createEntity. */
export function toEntityRef(entity: CatalogComponent): string {
  return `${entity.kind.toLowerCase()}:${
    entity.metadata.namespace ?? 'default'
  }/${entity.metadata.name}`;
}

/** History `details` is a JSON string (SQLite) or an already-parsed object (Postgres `json`). */
function parseDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details) return undefined;
  if (typeof details === 'object') return details as Record<string, unknown>;
  try {
    return JSON.parse(String(details));
  } catch {
    return undefined;
  }
}

/** Handles per-entity processing during an ownership scan: running checks, managing entity lifecycle (create/update/auto-resolve), and triggering proposal generation when needed. */
export class EntityProcessingService {
  constructor(
    private readonly scm: ScmRegistry,
    private readonly proposalGenerationService: ProposalGenerationService,
    private readonly store: OwnershipStore,
    private readonly checks: OwnershipCheck[],
    private readonly enabledCheckNames: Set<string>,
    private readonly logger: LoggerService,
    private readonly events: EventsService | undefined,
    /** Boundary call when proposal generation produced no actionable candidates. */
    private readonly escalationTrigger: EscalationTrigger,
    private readonly catalogService: CatalogService,
  ) {}

  /** Process a single entity against enabled checks and manage its case lifecycle. */
  async processEntity(
    entity: CatalogComponent,
    checkCtx: OwnershipCheckContext,
    scanId: string,
    stats: ScanStats,
    /** Per-scan accumulator: every proposal persisted during this call is
     * pushed here so the orchestrator can emit one `ProposalsBatchReady`
     * per team at the end of the scan. */
    persistedAccumulator?: PersistedProposalRef[],
  ): Promise<void> {
    const enabledChecks = this.getEnabledChecks();
    const failures = enabledChecks
      .map(check => check.run(checkCtx))
      .filter(r => r.failed);

    const winningFailure = this.pickHighestPriority(
      failures.map(f => f.checkName),
    );
    const winningResult = failures.find(f => f.checkName === winningFailure);

    const entityRef = toEntityRef(entity);
    const activeCase = await this.store.getActiveEntityByRef(entityRef);

    if (!winningResult) {
      await this.handlePassingEntity(activeCase, scanId, entityRef, stats);
      return;
    }

    const repo = await this.scm.repoFor(
      entity.metadata.annotations?.['backstage.io/managed-by-location'],
    );

    if (activeCase) {
      await this.handleRedetection(
        activeCase,
        entity,
        winningResult,
        repo,
        scanId,
        stats,
        persistedAccumulator,
      );
      return;
    }

    await this.handleNewIssue(
      entity,
      entityRef,
      winningResult,
      repo,
      scanId,
      stats,
      persistedAccumulator,
    );
  }

  /** Returns checks filtered to only those enabled, sorted by priority. */
  getEnabledChecks(): OwnershipCheck[] {
    const enabled = this.checks.filter(c => this.enabledCheckNames.has(c.name));

    return [...enabled].sort((a, b) => {
      const ai = BUILTIN_CHECK_PRIORITY.indexOf(a.name);
      const bi = BUILTIN_CHECK_PRIORITY.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }

  /**
   * End-of-scan reconciliation: close still-active cases whose entity is no
   * longer in scope under the current config, or has been deleted from the
   * catalog entirely.
   *
   * Two paths:
   * 1. Config-based out-of-scope: `entity_kind`, `entity_namespace`, or
   *    `current_owner` is now in the corresponding exclude list, or
   *    `current_check` is no longer enabled. Applies to open/escalated/unresolved.
   * 2. Catalog deletion for accepted cases: if an `accepted` entity does not
   *    appear in `seenEntityRefs` (built from the main scan loop), it may have
   *    been deleted. A catalog lookup confirms: if the entity is gone, the case
   *    is closed as out_of_scope. The Set is a fast-path; the catalog call is
   *    a fallback only for entries absent from the set (includes entities
   *    filtered out by config-excludes).
   *
   * Only touches rows untouched by the current scan (`last_scanned_at <
   * scanStartTime`) — rows the main loop processed are already at the right
   * state. `to_archive` is excluded at the store level (deletion track has
   * its own grace window).
   *
   * `filters.excludeTypes` is evaluated through the same catalog lookup (case rows
   * store no `spec.type`): an unseen case whose entity matches is closed as
   * `type_excluded`.
   *
   * Note: `filters.requireAnnotations` is intentionally not evaluated here —
   * annotations live on the catalog entity and aren't mirrored in the DB row.
   * Reconciling that case would require a per-row catalog fetch.
   */
  async reconcileOutOfScope(
    filters: EntityFilters,
    scanId: string,
    scanStartTime: Date,
    stats: ScanStats,
    seenEntityRefs: Set<string>,
  ): Promise<void> {
    if (filters.requireAnnotations.length > 0) {
      this.logger.warn(
        `Reconciliation: filters.requireAnnotations is set but cannot be evaluated without a catalog fetch — cases for entities that lost required annotations will not be auto-closed by this pass.`,
      );
    }

    const activeCases = await this.store.listActiveEntitiesForReconciliation();
    if (activeCases.length === 0) return;

    const excludeKinds = new Set(
      filters.excludeKinds.map(k => k.toLowerCase()),
    );
    const excludeNamespaces = new Set(
      filters.excludeNamespaces.map(n => n.toLowerCase()),
    );
    const excludeOwners = new Set(filters.excludeOwners);
    const excludeTypeSet = buildExcludeTypeSet(filters.excludeTypes);

    for (const activeCase of activeCases) {
      if (new Date(activeCase.last_scanned_at) >= scanStartTime) continue;

      if (activeCase.current_status === 'accepted') {
        // Fast-path: entity was seen in this scan — still in catalog, leave it open.
        if (seenEntityRefs.has(activeCase.entity_ref)) continue;
        // Slow-path: entity absent from seenEntityRefs — could be deleted (archived
        // repos are dropped from the catalog by skipArchivedRepos) or filtered by
        // config (excludeKinds/excludeNamespaces/excludeOwners/requireAnnotations).
        // Confirm via catalog to avoid closing a live-but-config-excluded accepted case.
        let catalogEntity: CatalogComponent | undefined;
        try {
          catalogEntity = await this.catalogService.getEntityByRef(
            activeCase.entity_ref,
          );
        } catch {
          // Transient catalog error — skip closing; the next scan will retry.
          this.logger.warn(
            `Reconciliation: catalog lookup failed for ${activeCase.entity_ref} — skipping to avoid false close`,
          );
          continue;
        }
        // Entity gone from the catalog (deleted, or its repo was archived and
        // skipped by skipArchivedRepos) → close. Still present but matching
        // `excludeTypes` → close as `type_excluded`. Otherwise it's
        // config-excluded or transient — leave it open.
        if (
          catalogEntity &&
          !isTypeExcluded(
            catalogEntity.kind,
            catalogEntity.spec?.type,
            excludeTypeSet,
          )
        ) {
          continue;
        }
        const closeReason = catalogEntity
          ? 'type_excluded'
          : 'entity_removed_from_catalog';
        // Entity gone or type-excluded — close the case and cancel pending deadlines.
        try {
          await this.closeAsOutOfScope(activeCase, scanId, closeReason);
          stats.issuesAutoResolved++;
        } catch (error) {
          if (error instanceof ConflictError) {
            this.logger.debug(
              `Reconciliation: skipping ${activeCase.entity_ref} — already closed by concurrent scan`,
            );
          } else {
            this.logger.error(
              `Reconciliation: failed to close ${activeCase.entity_ref}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        continue;
      }

      const configReason = this.scopeExclusionReason(
        activeCase,
        excludeKinds,
        excludeNamespaces,
        excludeOwners,
      );

      // If no config exclusion and entity wasn't seen in this scan, check whether
      // it has been removed from the catalog. An archived repo is dropped by
      // skipArchivedRepos, so an unseen, non-config-excluded entity that no longer
      // resolves has effectively been archived/deleted and its case should close.
      let closeReason: string | undefined = configReason;
      if (!closeReason && !seenEntityRefs.has(activeCase.entity_ref)) {
        // One catalog round-trip per unseen, non-config-excluded case — expected to be rare
        // (only newly-archived/deleted entities hit this path). If this becomes a bottleneck at
        // scale, batch via getEntitiesByRefs before the loop.
        try {
          const catalogEntity = await this.catalogService.getEntityByRef(
            activeCase.entity_ref,
          );
          if (!catalogEntity) {
            closeReason = 'entity_removed_from_catalog';
          } else if (
            isTypeExcluded(
              catalogEntity.kind,
              catalogEntity.spec?.type,
              excludeTypeSet,
            )
          ) {
            closeReason = 'type_excluded';
          }
        } catch {
          // Transient catalog error — skip; next scan will retry.
          this.logger.warn(
            `Reconciliation: catalog lookup failed for ${activeCase.entity_ref} — skipping to avoid false close`,
          );
          continue;
        }
      }

      if (!closeReason) continue;

      try {
        await this.closeAsOutOfScope(activeCase, scanId, closeReason);
        stats.issuesAutoResolved++;
      } catch (error) {
        if (error instanceof ConflictError) {
          // Version mismatch: a concurrent scan already closed this case.
          this.logger.debug(
            `Reconciliation: skipping ${activeCase.entity_ref} — already closed by concurrent scan`,
          );
        } else {
          this.logger.error(
            `Reconciliation: failed to close ${activeCase.entity_ref}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  /** Returns the first matching exclusion reason, or undefined if the case is still in scope. */
  private scopeExclusionReason(
    row: OwnershipEntityRow,
    excludeKinds: Set<string>,
    excludeNamespaces: Set<string>,
    excludeOwners: Set<string>,
  ): string | undefined {
    if (excludeKinds.has(row.entity_kind.toLowerCase())) return 'kind_excluded';
    if (excludeNamespaces.has(row.entity_namespace.toLowerCase())) {
      return 'namespace_excluded';
    }
    if (row.current_owner && excludeOwners.has(row.current_owner)) {
      return 'owner_excluded';
    }
    if (!this.enabledCheckNames.has(row.current_check)) return 'check_disabled';
    return undefined;
  }

  private async closeAsOutOfScope(
    row: OwnershipEntityRow,
    scanId: string,
    reason: string,
  ): Promise<void> {
    const needsEscalationCleanup =
      row.current_status === 'escalated' ||
      row.current_status === 'unresolved' ||
      row.current_status === 'accepted';

    // An entity that has vanished from the catalog is treated as archived (its
    // repo was archived and dropped by skipArchivedRepos, or it was deleted),
    // matching the retrigger close path in EscalationService. All other reasons
    // (config exclusion) are out_of_scope.
    const resolutionType: ResolutionType =
      reason === 'entity_removed_from_catalog' ? 'archived' : 'out_of_scope';

    await this.store.withTransaction(async stores => {
      await stores.entityStore.closeEntity(
        row.id,
        'system',
        resolutionType,
        row.version,
      );
      // Terminate every still-live proposal — pending and accepted — so
      // a closed case never leaves a dangling proposal. An accepted proposal on
      // an entity removed from the catalog is expired (not cancelled): the team
      // committed but an external event prevented them from acting, matching the
      // grace-expiry and retrigger paths. All others are cancelled.
      const liveProposals =
        await stores.proposalStore.listCancellableProposalsByEntity(row.id);
      for (const p of liveProposals) {
        if (p.status === 'accepted' && resolutionType === 'archived') {
          await stores.proposalStore.updateProposalStatus(p.id, 'expired');
          await stores.historyStore.appendHistory({
            entity_id: row.id,
            proposal_id: p.id,
            scan_id: scanId,
            action: 'proposal_acceptance_reverted',
            actor: 'system',
            details: { reason },
          });
        } else {
          await stores.proposalStore.updateProposalStatus(p.id, 'cancelled');
        }
      }
      if (needsEscalationCleanup) {
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(row.id);
        const active = await stores.escalationQueueStore.findActiveEntry(
          row.id,
        );
        if (active) {
          await stores.escalationQueueStore.markEntryCompleted(active.id);
        }
      }
      await stores.historyStore.appendHistory({
        entity_id: row.id,
        scan_id: scanId,
        action:
          resolutionType === 'archived'
            ? 'issue_closed_archived'
            : 'issue_closed_out_of_scope',
        actor: 'system',
        details: {
          entityRef: row.entity_ref,
          reason,
          ...(needsEscalationCleanup ? { escalationCleanedUp: true } : {}),
        },
      });
    });
  }

  pickHighestPriority(failedCheckNames: string[]): string | undefined {
    if (failedCheckNames.length === 0) return undefined;

    const priority = [
      ...BUILTIN_CHECK_PRIORITY,
      ...this.checks
        .map(c => c.name)
        .filter(n => !BUILTIN_CHECK_PRIORITY.includes(n)),
    ];

    for (const name of priority) {
      if (failedCheckNames.includes(name)) return name;
    }

    return failedCheckNames[0];
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async handlePassingEntity(
    activeCase: OwnershipEntityRow | undefined,
    scanId: string,
    entityRef: string,
    stats: ScanStats,
  ): Promise<void> {
    if (!activeCase) return;

    // is on a deletion track — auto-resolving would resurrect it. The
    // archival owner still has the grace window to revert the decision via
    // the explicit lifecycle endpoints.
    if (activeCase.current_status === 'to_archive') {
      this.logger.debug(
        `Skipping auto-resolution for ${entityRef}: entity is to_archive`,
      );
      return;
    }

    // For escalated/unresolved entities, also cancel pending deadlines and
    // complete the active queue entry inside the same transaction —
    // otherwise the deadline checker fires timeouts on a closed entity.
    const needsEscalationCleanup =
      activeCase.current_status === 'escalated' ||
      activeCase.current_status === 'unresolved';

    if (needsEscalationCleanup) {
      await this.store.withTransaction(async stores => {
        await stores.entityStore.closeEntity(
          activeCase.id,
          'system',
          'ownership_changed',
          activeCase.version,
        );
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(
          activeCase.id,
        );
        const active = await stores.escalationQueueStore.findActiveEntry(
          activeCase.id,
        );
        if (active) {
          await stores.escalationQueueStore.markEntryCompleted(active.id);
        }
        await stores.historyStore.appendHistory({
          entity_id: activeCase.id,
          scan_id: scanId,
          action: 'issue_auto_closed',
          actor: 'system',
          details: { entityRef, escalationCleanedUp: true },
        });
      });
      stats.issuesAutoResolved++;
      return;
    }

    await this.store.closeEntity(
      activeCase.id,
      'system',
      'ownership_changed',
      activeCase.version,
    );
    await this.store.appendHistory({
      entity_id: activeCase.id,
      scan_id: scanId,
      action: 'issue_auto_closed',
      actor: 'system',
      details: { entityRef },
    });
    stats.issuesAutoResolved++;
  }

  private async handleRedetection(
    activeCase: OwnershipEntityRow,
    entity: CatalogComponent,
    winningResult: { checkName: string; details?: Record<string, unknown> },
    repo: ScmRepoRef | undefined,
    scanId: string,
    stats: ScanStats,
    persistedAccumulator?: PersistedProposalRef[],
  ): Promise<void> {
    // Repository identity is re-derived on every run, so a repo that moved
    // (e.g. Bitbucket → GitLab) updates this row instead of creating another.
    // An unresolved repo (no provider, transient SCM error) keeps the old values.
    await this.store.updateEntityLastScanned(activeCase.id, scanId, repo);
    await this.store.appendHistory({
      entity_id: activeCase.id,
      scan_id: scanId,
      action: 'issue_redetected',
      actor: 'system',
      details: {
        checkName: winningResult.checkName,
        checkDetails: winningResult.details,
      },
    });
    stats.existingIssuesUpdated++;

    if (activeCase.current_status === 'accepted') {
      await this.publishAcceptancePending(activeCase);
    }

    if (SKIP_REGENERATION_STATUSES.has(activeCase.current_status)) return;

    const activeProposals = await this.store.listActiveProposalsByEntity(
      activeCase.id,
    );
    if (activeProposals.length === 0) {
      const currentOwner = entity.spec?.owner;
      const ok = await this.proposalGenerationService.generateProposals(
        activeCase.id,
        entity,
        winningResult.checkName,
        winningResult.checkName === 'zombie' ? currentOwner : undefined,
        repo,
        scanId,
        persistedAccumulator,
      );
      if (!ok) {
        await this.escalationTrigger.triggerEscalation(activeCase.id);
        return;
      }
    }

    // Generation succeeded (or pending proposals already exist), so the case
    // has candidates again — an `unresolved` status is stale.
    if (activeCase.current_status === 'unresolved') {
      await this.reopenIfCandidatesFound(activeCase.id, scanId);
    }
  }

  /**
   * Self-heal an `unresolved` case once a scan produces a notified (`pending`)
   * proposal again. Every unresolved reason — no_candidates_found,
   * no_candidates_after_retrigger, escalation_exhausted — means "nobody
   * acted". Possible owners alone don't count: they are never notified, so a
   * possible-owner-only case stays unresolved (still claimable from the UI).
   * Without this, a single transient no-candidates scan left the case
   * unresolved forever.
   *
   * The history row is self-explanatory on purpose: the case leaves the admin
   * Unresolved tab, and the audit trail must say why and with which candidates.
   */
  private async reopenIfCandidatesFound(
    entityId: string,
    scanId: string,
  ): Promise<void> {
    try {
      await this.store.withTransaction(async stores => {
        const entity = await stores.entityStore.getEntityByIdForUpdate(
          entityId,
        );
        if (!entity || entity.current_status !== 'unresolved') return;

        // Legacy rows without a recorded reason: leave them for an admin.
        const reasonRow = await stores.historyStore.getLatestHistoryActionIn(
          entityId,
          UNRESOLVED_REASON_ACTIONS,
        );
        if (!reasonRow) return;

        const candidates = (
          await stores.proposalStore.listProposalsByEntity(entityId)
        )
          .filter(p => p.status === 'pending')
          .map(p => ({
            ownerRef: p.proposed_owner_ref,
            score: p.confidence_score,
            status: p.status,
          }));
        if (candidates.length === 0) return;

        // Escalation leftovers (escalation_exhausted cases): a stale timeout
        // must not fire against the reopened case. Proposal-level deadlines
        // (proposal_expiry, pr_creation) belong to the live proposals — keep them.
        await stores.pendingDeadlineStore.cancelDeadlinesForEntity(entityId, [
          'escalation_timeout',
          'redecision_expiry',
        ]);
        const activeEntry = await stores.escalationQueueStore.findActiveEntry(
          entityId,
        );
        if (activeEntry) {
          await stores.escalationQueueStore.markEntryCompleted(activeEntry.id);
        }

        await stores.entityStore.reopenEntity(entity.id, entity.version);

        const reasonDetails = parseDetails(reasonRow.details);
        await stores.historyStore.appendHistory({
          entity_id: entityId,
          scan_id: scanId,
          action: 'reopened_candidates_found',
          actor: 'system',
          details: {
            entityRef: entity.entity_ref,
            previousReason: reasonRow.action,
            ...(typeof reasonDetails?.reason === 'string'
              ? { previousReasonDetail: reasonDetails.reason }
              : {}),
            previousReasonAt: new Date(reasonRow.created_at).toISOString(),
            candidates,
          },
        });
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        this.logger.debug(
          `Reopen: skipping ${entityId} — modified concurrently, next scan retries`,
        );
        return;
      }
      throw error;
    }
  }

  private async publishAcceptancePending(
    activeCase: OwnershipEntityRow,
  ): Promise<void> {
    if (!this.events) return;
    if (!activeCase.accepted_at || !activeCase.assigned_to) return;

    const daysSinceAcceptance =
      (Date.now() - new Date(activeCase.accepted_at).getTime()) /
      (24 * 60 * 60 * 1000);

    try {
      await this.events.publish({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: {
          entityId: activeCase.id,
          entityName: activeCase.entity_name,
          assignedTo: activeCase.assigned_to,
          daysSinceAcceptance,
          repoUrl: activeCase.repo_url ?? null,
          prUrl: activeCase.pr_status === 'raised' ? activeCase.pr_url : null,
        } satisfies AcceptancePendingEventPayload,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to publish ${NotificationsTopic.AcceptancePending} for ${
          activeCase.id
        }: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleNewIssue(
    entity: CatalogComponent,
    entityRef: string,
    winningResult: { checkName: string; details?: Record<string, unknown> },
    repo: ScmRepoRef | undefined,
    scanId: string,
    stats: ScanStats,
    persistedAccumulator?: PersistedProposalRef[],
  ): Promise<void> {
    const currentOwner = entity.spec?.owner;

    let entityId: string;
    try {
      entityId = await this.store.createEntity({
        entity_ref: entityRef,
        entity_name: entity.metadata.name,
        entity_kind: entity.kind,
        entity_namespace: entity.metadata.namespace ?? 'default',
        current_owner:
          winningResult.checkName === 'zombie' ? currentOwner : undefined,
        current_check: winningResult.checkName,
        check_details: winningResult.details,
        repo,
      });
    } catch (error) {
      // Duplicate entity_ref from catalog pagination — treat as re-detection.
      if (
        String(error).includes('unique constraint') ||
        String(error).includes('UNIQUE constraint')
      ) {
        this.logger.warn(
          `Duplicate entity_ref ${entityRef} in scan — skipping duplicate`,
        );
        return;
      }
      throw error;
    }

    await this.store.appendHistory({
      entity_id: entityId,
      scan_id: scanId,
      action: 'issue_detected',
      actor: 'system',
      details: {
        checkName: winningResult.checkName,
        checkDetails: winningResult.details,
        entityRef,
      },
    });

    stats.newIssuesFound++;

    const ok = await this.proposalGenerationService.generateProposals(
      entityId,
      entity,
      winningResult.checkName,
      winningResult.checkName === 'zombie' ? currentOwner : undefined,
      repo,
      scanId,
      persistedAccumulator,
    );
    if (!ok) {
      await this.escalationTrigger.triggerEscalation(entityId);
    }
  }
}
