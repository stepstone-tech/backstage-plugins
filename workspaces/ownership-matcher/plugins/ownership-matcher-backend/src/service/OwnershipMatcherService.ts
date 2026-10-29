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
import {
  CatalogComponent,
  CatalogService,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  EntityProcessingService,
  toEntityRef,
} from './EntityProcessingService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import { OwnershipCheckContext } from '../checks';
import { OwnershipMatcherConfig } from '../config/types';
import { CheckName } from '../types';
import { PersistedProposalRef } from './ProposalGenerationService';
import type { ContributorService } from './ContributorService';
import { NotificationsTopic } from './notifications/topics';

export interface ScanStats {
  totalScanned: number;
  newIssuesFound: number;
  existingIssuesUpdated: number;
  issuesAutoResolved: number;
}

/** Result of {@link OwnershipMatcherService.scanEntity}. */
export interface ScanEntityResult {
  passes: boolean;
  isCatalogPresent: boolean;
  entity?: CatalogComponent;
  failingCheck?: CheckName;
}

/** Public surface used by the escalation router for retrigger orchestration (— replaces the previous duck-type `(scanner as { scanEntity?: ... */
export interface OwnershipMatcherService {
  runScan(): Promise<ScanStats>;
  scanEntity(entityRef: string): Promise<ScanEntityResult>;
}

/** Orchestrates ownership scans: iterates catalog entities, delegates per-entity processing to EntityProcessingService, and manages scan lifecycle (create, complete, fail). */
export class DefaultOwnershipMatcherService implements OwnershipMatcherService {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly entityProcessingService: EntityProcessingService,
    private readonly store: OwnershipStore,
    private readonly config: OwnershipMatcherConfig,
    private readonly logger: LoggerService,
    private readonly events?: EventsService,
    /** Its user-data cache would otherwise live for the whole process. */
    private readonly contributorService?: Pick<
      ContributorService,
      'resetCache'
    >,
  ) {}

  /** The scan currently running in this process, if any. */
  private inFlightScan?: Promise<ScanStats>;

  /**
   * Execute a full ownership scan. A call made while a scan is already
   * running in this process joins that scan instead of starting another.
   */
  runScan(): Promise<ScanStats> {
    if (this.inFlightScan) {
      this.logger.info('Ownership scan: already running, joining it');
      return this.inFlightScan;
    }
    this.inFlightScan = this.executeScan().finally(() => {
      this.inFlightScan = undefined;
    });
    return this.inFlightScan;
  }

  private async executeScan(): Promise<ScanStats> {
    // Fresh contributor → team mapping per scan, even if the previous one failed.
    this.contributorService?.resetCache();
    const scanStartedAt = new Date();
    const startTime = scanStartedAt.getTime();
    const scanId = await this.store.createScan();

    const stats: ScanStats = {
      totalScanned: 0,
      newIssuesFound: 0,
      existingIssuesUpdated: 0,
      issuesAutoResolved: 0,
    };

    try {
      this.logger.info('Ownership scan: loading live group registry...');
      const liveGroupRegistry =
        await this.catalogService.getLiveGroupRegistry();
      const liveUserRegistry = await this.loadLiveUserRegistry();

      const orphanedPlaceholders = new Set(
        this.config.checks.orphaned.placeholderValues.map(v => v.toLowerCase()),
      );

      const enabledChecks = this.entityProcessingService.getEnabledChecks();

      this.logger.info(
        `Ownership scan: scanning with checks [${enabledChecks
          .map(c => c.name)
          .join(', ')}]`,
      );

      // One accumulator per scan, drained into per-team digests below.
      const persistedProposals: PersistedProposalRef[] = [];
      const seenEntityRefs = new Set<string>();

      for await (const entity of this.catalogService.paginateEntities(
        this.config.filters,
      )) {
        stats.totalScanned++;
        seenEntityRefs.add(toEntityRef(entity));

        const checkCtx: OwnershipCheckContext = {
          entity,
          liveGroupRegistry,
          liveUserRegistry,
          orphanedPlaceholders,
        };

        try {
          await this.entityProcessingService.processEntity(
            entity,
            checkCtx,
            scanId,
            stats,
            persistedProposals,
          );
        } catch (entityError) {
          this.logger.error(
            `Ownership scan: failed to process entity ${
              entity.metadata.name
            }: ${
              entityError instanceof Error
                ? entityError.message
                : String(entityError)
            }`,
          );
        }
      }

      // Reconcile cases that fell out of scope since the last scan. The
      // catalog iterator silently skips excluded kinds/namespaces/owners and
      // disabled checks, so the per-entity auto-resolve path can't see them —
      // without this pass they'd remain open forever after a config narrowing.
      try {
        await this.entityProcessingService.reconcileOutOfScope(
          this.config.filters,
          scanId,
          scanStartedAt,
          stats,
          seenEntityRefs,
        );
      } catch (reconError) {
        this.logger.error(
          `Ownership scan: reconciliation pass failed: ${
            reconError instanceof Error
              ? reconError.message
              : String(reconError)
          }`,
        );
      }

      await this.emitProposalsBatchReady(persistedProposals, scanId);

      const durationMs = Date.now() - startTime;

      await this.store.completeScan(scanId, {
        completed_at: new Date(),
        total_entities_scanned: stats.totalScanned,
        new_issues_found: stats.newIssuesFound,
        existing_issues_updated: stats.existingIssuesUpdated,
        issues_auto_resolved: stats.issuesAutoResolved,
        status: 'completed',
        duration_ms: durationMs,
      });

      this.logger.info(
        `Ownership scan complete in ${durationMs}ms — scanned: ${stats.totalScanned}, new: ${stats.newIssuesFound}, updated: ${stats.existingIssuesUpdated}, resolved: ${stats.issuesAutoResolved}`,
      );

      this.catalogService.resetCache();

      return stats;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const durationMs = Date.now() - startTime;

      await this.store.failScan(scanId, err.message, durationMs);

      this.logger.error(`Ownership scan failed: ${err.message}`);
      throw error;
    }
  }

  /** Live User refs for ZombieCheck; skipped when User owners are excluded. */
  private async loadLiveUserRegistry(): Promise<Set<string> | undefined> {
    if (this.config.owners.excludeUserKind) {
      return undefined;
    }
    return this.catalogService.getLiveUserRegistry();
  }

  /** Aggregates per-team digests and emits one `ProposalsBatchReady` per team
   * — Stage-1 replacement for the per-candidate `ProposalCreated` event. */
  private async emitProposalsBatchReady(
    persistedProposals: PersistedProposalRef[],
    scanId: string,
  ): Promise<void> {
    if (!this.events || persistedProposals.length === 0) return;

    const perTeam = new Map<string, string[]>();
    for (const { ownerRef, proposalId } of persistedProposals) {
      const ids = perTeam.get(ownerRef) ?? [];
      ids.push(proposalId);
      perTeam.set(ownerRef, ids);
    }

    for (const [ownerRef, newProposalIds] of perTeam) {
      try {
        await this.events.publish({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: {
            proposedOwnerRef: ownerRef,
            newProposalIds,
            scanId,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to publish ProposalsBatchReady for ${ownerRef}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Re-scan a single entity by catalog ref. */
  async scanEntity(entityRef: string): Promise<ScanEntityResult> {
    let entity;
    try {
      entity = await this.catalogService.getEntityByRef(entityRef);
    } catch (error) {
      this.logger.warn(
        `scanEntity(${entityRef}) failed to fetch from catalog: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Treat catalog errors as "not present" — caller can still proceed with
      // a normal cancel + rebuild flow without the archived branch.
      return { passes: false, isCatalogPresent: false };
    }

    if (!entity) {
      return { passes: false, isCatalogPresent: false };
    }

    const liveGroupRegistry = await this.catalogService.getLiveGroupRegistry();
    const liveUserRegistry = await this.loadLiveUserRegistry();
    const orphanedPlaceholders = new Set(
      this.config.checks.orphaned.placeholderValues.map(v => v.toLowerCase()),
    );
    const checkCtx: OwnershipCheckContext = {
      entity,
      liveGroupRegistry,
      liveUserRegistry,
      orphanedPlaceholders,
    };

    const enabledChecks = this.entityProcessingService.getEnabledChecks();
    const results = enabledChecks.map(check => check.run(checkCtx));
    const failures = results.filter(r => r.failed).map(r => r.checkName);

    if (failures.length === 0) {
      return { passes: true, isCatalogPresent: true, entity };
    }

    const winner = this.entityProcessingService.pickHighestPriority(failures);
    return {
      passes: false,
      isCatalogPresent: true,
      entity,
      failingCheck: winner as CheckName | undefined,
    };
  }
}
