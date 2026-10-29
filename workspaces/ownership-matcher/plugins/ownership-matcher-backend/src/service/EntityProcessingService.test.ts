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

/**
 * Tests for EntityProcessingService event publishing.
 * Covers the acceptance.pending publish path in handleRedetection.
 */

import { EntityProcessingService } from './EntityProcessingService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import { ScmRegistry } from '../scm';
import {
  PersistedProposalRef,
  ProposalGenerationService,
} from './ProposalGenerationService';
import { mockServices } from '@backstage/backend-test-utils';
import { EventsService } from '@backstage/plugin-events-node';
import { CatalogComponent, OwnershipEntityRow } from '../types';
import { OwnershipCheck, OwnershipCheckContext } from '../checks';
import { ScanStats } from './OwnershipMatcherService';
import { NotificationsTopic } from './notifications/topics';
import { EscalationTrigger } from '../escalation/EscalationTrigger';
import { createMockEscalationTrigger } from '../__testutils__/mockEscalationTrigger';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStore(overrides: Partial<OwnershipStore> = {}): OwnershipStore {
  return {
    createScan: jest.fn(),
    completeScan: jest.fn(),
    failScan: jest.fn(),
    failStaleScans: jest.fn().mockResolvedValue(0),
    getScan: jest.fn(),
    listScans: jest.fn(),
    createEntity: jest.fn().mockResolvedValue('entity-id'),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    closeEntity: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    getActiveEntityByRef: jest.fn(),
    getEntityById: jest.fn(),
    listEntities: jest.fn(),
    createProposal: jest.fn().mockResolvedValue('proposal-id'),
    getProposal: jest.fn(),
    listProposalsByEntity: jest.fn(),
    listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    updateProposalStatus: jest.fn(),
    appendHistory: jest.fn(),
    listHistory: jest.fn(),
    getRejectedActors: jest.fn().mockResolvedValue(new Set()),
    ...overrides,
  } as unknown as OwnershipStore;
}

function makeEventsService(throws?: Error): jest.Mocked<EventsService> {
  return {
    subscribe: jest.fn(),
    publish: jest.fn(async () => {
      if (throws) throw throws;
    }),
  } as unknown as jest.Mocked<EventsService>;
}

function makeScmRegistry(repo?: unknown): jest.Mocked<ScmRegistry> {
  return {
    repoFor: jest.fn().mockResolvedValue(repo),
  } as unknown as jest.Mocked<ScmRegistry>;
}

function makeProposalGenerationService(): jest.Mocked<ProposalGenerationService> {
  return {
    generateProposals: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<ProposalGenerationService>;
}

function makeCatalogService(entityExists = true): jest.Mocked<CatalogService> {
  return {
    getEntityByRef: jest.fn().mockResolvedValue(entityExists ? {} : undefined),
  } as unknown as jest.Mocked<CatalogService>;
}

/** A check that always fails (entity has ownership issue). */
const failingCheck: OwnershipCheck = {
  name: 'orphaned',
  title: 'Orphaned',
  description: 'No owner',
  run: (_ctx: OwnershipCheckContext) => ({
    failed: true,
    checkName: 'orphaned',
    details: {},
  }),
};

const enabledCheckNames = new Set(['orphaned']);

const testEntity: CatalogComponent = {
  kind: 'Component',
  metadata: { name: 'svc-alpha', namespace: 'default' },
  spec: {},
};

const emptyScanStats: ScanStats = {
  newIssuesFound: 0,
  existingIssuesUpdated: 0,
  issuesAutoResolved: 0,
  totalScanned: 0,
};

const NOW = new Date();
const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);

/**
 * Builds an accepted entity row with the given accepted_at and assigned_to.
 * Used to test publishing, and skipping publish when fields are missing.
 */
function makeAcceptedEntityRow(overrides: {
  accepted_at?: Date | null;
  assigned_to?: string | null;
}): OwnershipEntityRow {
  return {
    id: 'entity-1',
    entity_ref: 'component:default/svc-alpha',
    entity_name: 'svc-alpha',
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: EIGHT_DAYS_AGO,
    last_scanned_at: EIGHT_DAYS_AGO,
    current_status: 'accepted',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    scm_type: null,
    repo_host: null,
    repo_path: null,
    pr_status: 'none',
    pr_url: null,
    pr_branch: null,
    pr_attempts: 0,
    pr_last_error: null,
    pr_id: null,
    pr_checked_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution_type: null,
    accepted_at:
      overrides.accepted_at !== undefined
        ? overrides.accepted_at
        : EIGHT_DAYS_AGO,
    assigned_to:
      overrides.assigned_to !== undefined
        ? overrides.assigned_to
        : 'group:default/team-y',
    version: 1,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EntityProcessingService — event publishing', () => {
  const logger = mockServices.logger.mock();
  const checkCtx: OwnershipCheckContext = {
    entity: testEntity,
    liveGroupRegistry: new Set(),
    orphanedPlaceholders: new Set(['unknown']),
  };

  // Re-detected accepted entity with full fields → publishes acceptance.pending
  it('handleRedetection publishes acceptance.pending for accepted entity with accepted_at and assigned_to', async () => {
    const acceptedCase = makeAcceptedEntityRow({
      accepted_at: EIGHT_DAYS_AGO,
      assigned_to: 'group:default/team-y',
    });
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]), // existing proposals → no regen
    });
    const events = makeEventsService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: expect.objectContaining({
          entityId: 'entity-1',
          entityName: 'svc-alpha',
          assignedTo: 'group:default/team-y',
          daysSinceAcceptance: expect.any(Number),
          repoUrl: null,
        }),
      }),
    );
    // daysSinceAcceptance must be a float (not 0, not negative)
    const publishCall = (events.publish as jest.Mock).mock.calls[0][0];
    expect(publishCall.eventPayload.daysSinceAcceptance).toBeGreaterThan(0);
  });

  // repoUrl pass-through — when activeCase.repo_url is set, payload carries the same URL
  it('handleRedetection forwards activeCase.repo_url to AcceptancePending payload as repoUrl', async () => {
    const repoUrl =
      'https://repo.example.com/projects/PRJ/repos/svc-alpha/browse';
    const acceptedCase: OwnershipEntityRow = {
      ...makeAcceptedEntityRow({
        accepted_at: EIGHT_DAYS_AGO,
        assigned_to: 'group:default/team-y',
      }),
      repo_url: repoUrl,
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const events = makeEventsService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: expect.objectContaining({ repoUrl }),
      }),
    );
  });

  it.each([
    ['raised', 'https://repo/pr/7'],
    ['completed', null],
  ] as const)('a %s PR is forwarded as prUrl %p', async (prStatus, prUrl) => {
    const acceptedCase: OwnershipEntityRow = {
      ...makeAcceptedEntityRow({
        accepted_at: EIGHT_DAYS_AGO,
        assigned_to: 'group:default/team-y',
      }),
      pr_status: prStatus,
      pr_url: 'https://repo/pr/7',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const events = makeEventsService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: expect.objectContaining({ prUrl }),
      }),
    );
  });

  // Accepted entity missing accepted_at → no publish
  it('handleRedetection skips publish when accepted_at is null', async () => {
    const acceptedCase = makeAcceptedEntityRow({
      accepted_at: null,
      assigned_to: 'group:default/team-y',
    });
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const events = makeEventsService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(events.publish).not.toHaveBeenCalled();
  });

  // Accepted entity missing assigned_to → no publish
  it('handleRedetection skips publish when assigned_to is null', async () => {
    const acceptedCase = makeAcceptedEntityRow({
      accepted_at: EIGHT_DAYS_AGO,
      assigned_to: null,
    });
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const events = makeEventsService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(events.publish).not.toHaveBeenCalled();
  });

  // No EventsService wired — no exception thrown
  it('no EventsService wired — processEntity completes without exception', async () => {
    const acceptedCase = makeAcceptedEntityRow({
      accepted_at: EIGHT_DAYS_AGO,
      assigned_to: 'group:default/team-y',
    });
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(acceptedCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      undefined, // No events service
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await expect(
      svc.processEntity(testEntity, checkCtx, 'scan-1', { ...emptyScanStats }),
    ).resolves.not.toThrow();
  });

  // Entity is NOT in accepted status → no publish even if fields present
  it('entity not in accepted status — no acceptance.pending publish', async () => {
    const openCase: OwnershipEntityRow = {
      ...makeAcceptedEntityRow({
        accepted_at: EIGHT_DAYS_AGO,
        assigned_to: 'group:default/team-y',
      }),
      current_status: 'open',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(openCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    });
    const events = makeEventsService();
    const proposalGen = makeProposalGenerationService();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      proposalGen,
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      events,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    const publishCalls = (events.publish as jest.Mock).mock.calls.filter(
      (c: unknown[]) =>
        (c[0] as any)?.topic === NotificationsTopic.AcceptancePending,
    );
    expect(publishCalls).toHaveLength(0);
  });
});

// ─── EscalationTrigger boundary calls ───────────────────

describe('EntityProcessingService — escalation trigger boundary', () => {
  const logger = mockServices.logger.mock();
  const checkCtx: OwnershipCheckContext = {
    entity: testEntity,
    liveGroupRegistry: new Set(),
    orphanedPlaceholders: new Set(['unknown']),
  };

  function buildSvc(
    overrides: {
      generateProposalsResult?: boolean;
      activeCase?: OwnershipEntityRow | undefined;
      activeProposals?: { id: string }[];
    } = {},
  ): {
    svc: EntityProcessingService;
    escalationTrigger: jest.Mocked<EscalationTrigger>;
    proposalGen: jest.Mocked<ProposalGenerationService>;
    store: OwnershipStore;
  } {
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(overrides.activeCase),
      listActiveProposalsByEntity: jest
        .fn()
        .mockResolvedValue(overrides.activeProposals ?? []),
      createEntity: jest.fn().mockResolvedValue('entity-1'),
    });
    const proposalGen = makeProposalGenerationService();
    proposalGen.generateProposals.mockResolvedValue(
      overrides.generateProposalsResult ?? false,
    );
    const escalationTrigger = createMockEscalationTrigger();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      proposalGen,
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      undefined,
      escalationTrigger,
      makeCatalogService(),
    );
    return { svc, escalationTrigger, proposalGen, store };
  }

  it('persists the SCM repo and passes it to proposal generation', async () => {
    const repo = {
      type: 'bitbucketServer',
      host: 'bb.example.com',
      path: 'PROJ/my-repo',
      webUrl: 'https://bb.example.com/projects/PROJ/repos/my-repo',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(undefined),
      createEntity: jest.fn().mockResolvedValue('entity-1'),
    });
    const proposalGen = makeProposalGenerationService();
    proposalGen.generateProposals.mockResolvedValue(true);
    const svc = new EntityProcessingService(
      makeScmRegistry(repo),
      proposalGen,
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      undefined,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(store.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({ repo }),
    );
    expect(proposalGen.generateProposals).toHaveBeenCalledWith(
      'entity-1',
      testEntity,
      expect.any(String),
      undefined,
      repo,
      'scan-1',
      undefined,
    );
  });

  it.each([
    [
      'updates the existing row when the repo moved to another SCM host',
      {
        type: 'gitlab',
        host: 'gitlab.com',
        path: 'acme/platform/my-repo',
        webUrl: 'https://gitlab.com/acme/platform/my-repo',
      },
    ],
    ['keeps the stored repo when it cannot be resolved this run', undefined],
  ])('re-detection %s', async (_label, repo) => {
    const openCase = makeAcceptedEntityRow({
      accepted_at: null,
      assigned_to: null,
    });
    openCase.current_status = 'open';
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(openCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const svc = new EntityProcessingService(
      makeScmRegistry(repo),
      makeProposalGenerationService(),
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      undefined,
      createMockEscalationTrigger(),
      makeCatalogService(),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(store.createEntity).not.toHaveBeenCalled();
    expect(store.updateEntityLastScanned).toHaveBeenCalledWith(
      openCase.id,
      'scan-1',
      repo,
    );
  });

  it('handleNewIssue calls triggerEscalation exactly once with the new entityId when generateProposals returns false', async () => {
    const { svc, escalationTrigger, proposalGen } = buildSvc({
      generateProposalsResult: false,
      activeCase: undefined,
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(proposalGen.generateProposals).toHaveBeenCalledTimes(1);
    expect(escalationTrigger.triggerEscalation).toHaveBeenCalledTimes(1);
    expect(escalationTrigger.triggerEscalation).toHaveBeenCalledWith(
      'entity-1',
    );
  });

  it('handleNewIssue does NOT call triggerEscalation when generateProposals returns true', async () => {
    const { svc, escalationTrigger } = buildSvc({
      generateProposalsResult: true,
      activeCase: undefined,
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(escalationTrigger.triggerEscalation).not.toHaveBeenCalled();
  });

  it('handleRedetection calls triggerEscalation when regen returns false', async () => {
    const openCase: OwnershipEntityRow = makeAcceptedEntityRow({
      accepted_at: null,
      assigned_to: null,
    });
    openCase.current_status = 'open';
    openCase.id = 'entity-existing';
    const { svc, escalationTrigger, proposalGen } = buildSvc({
      generateProposalsResult: false,
      activeCase: openCase,
      activeProposals: [],
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    expect(proposalGen.generateProposals).toHaveBeenCalledTimes(1);
    expect(escalationTrigger.triggerEscalation).toHaveBeenCalledTimes(1);
    expect(escalationTrigger.triggerEscalation).toHaveBeenCalledWith(
      'entity-existing',
    );
  });

  // Pin the skip-regen guard explicitly: assert
  // findActiveCase WAS called (so we're past the new-issue branch) AND
  // generateProposals was NOT.
  it('handleRedetection skip-regen guard prevents trigger AND generateProposals on escalated entity', async () => {
    const escalatedCase: OwnershipEntityRow = makeAcceptedEntityRow({
      accepted_at: null,
      assigned_to: null,
    });
    escalatedCase.current_status = 'escalated';
    escalatedCase.id = 'entity-escalated';
    const { svc, escalationTrigger, proposalGen, store } = buildSvc({
      activeCase: escalatedCase,
      activeProposals: [],
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-1', {
      ...emptyScanStats,
    });

    // Past the new-issue branch (active case lookup happened):
    expect(store.getActiveEntityByRef).toHaveBeenCalled();
    // Skip-regen guard fired — NEITHER regen NOR trigger ran:
    expect(proposalGen.generateProposals).not.toHaveBeenCalled();
    expect(escalationTrigger.triggerEscalation).not.toHaveBeenCalled();
  });

  // A to_archive entity had its proposals cancelled at archive time; a rescan
  // must not re-propose, re-notify teams, or overwrite assigned_to.
  it('handleRedetection skip-regen guard prevents regeneration, notifications and reassignment on to_archive entity', async () => {
    const toArchiveCase: OwnershipEntityRow = makeAcceptedEntityRow({
      accepted_at: null,
      assigned_to: 'group:default/team-y',
    });
    toArchiveCase.current_status = 'to_archive';
    toArchiveCase.id = 'entity-to-archive';
    const { svc, escalationTrigger, proposalGen, store } = buildSvc({
      activeCase: toArchiveCase,
      activeProposals: [],
    });
    // Mirror the real generateProposals side effects (fill the batch-notification
    // accumulator, reassign the case) so the assertions below fail without the guard.
    proposalGen.generateProposals.mockImplementation(
      async (entityId, _entity, _check, _owner, _repo, _scanId, acc) => {
        acc?.push({ proposalId: 'p-new', ownerRef: 'group:default/team-z' });
        await store.updateAssignee(entityId, 'group:default/team-z');
        return true;
      },
    );
    const persistedAccumulator: PersistedProposalRef[] = [];

    await svc.processEntity(
      testEntity,
      checkCtx,
      'scan-1',
      { ...emptyScanStats },
      persistedAccumulator,
    );

    expect(store.updateEntityLastScanned).toHaveBeenCalledWith(
      'entity-to-archive',
      'scan-1',
      undefined,
    );
    expect(proposalGen.generateProposals).not.toHaveBeenCalled();
    expect(escalationTrigger.triggerEscalation).not.toHaveBeenCalled();
    expect(store.updateAssignee).not.toHaveBeenCalled();
    expect(persistedAccumulator).toEqual([]);
  });
});

describe('EntityProcessingService — unresolved self-heal on redetection', () => {
  const logger = mockServices.logger.mock();
  const checkCtx: OwnershipCheckContext = {
    entity: testEntity,
    liveGroupRegistry: new Set(),
    orphanedPlaceholders: new Set(['unknown']),
  };
  const REASON_AT = new Date('2026-09-01T06:00:00Z');

  function unresolvedCase(
    status: OwnershipEntityRow['current_status'] = 'unresolved',
  ): OwnershipEntityRow {
    const row = makeAcceptedEntityRow({ accepted_at: null, assigned_to: null });
    row.id = 'entity-unresolved';
    row.current_status = status;
    row.version = 7;
    return row;
  }

  function buildSvc(opts: {
    activeCase: OwnershipEntityRow;
    generateProposalsResult?: boolean;
    activeProposals?: { id: string }[];
    reasonRow?: { action: string; details: unknown } | undefined;
    proposals?: {
      proposed_owner_ref: string;
      confidence_score: number;
      status: string;
    }[];
    activeQueueEntry?: { id: string } | null;
  }) {
    const tx = {
      entityStore: {
        getEntityByIdForUpdate: jest.fn().mockResolvedValue(opts.activeCase),
        reopenEntity: jest.fn(),
      },
      historyStore: {
        getLatestHistoryActionIn: jest
          .fn()
          .mockResolvedValue(
            opts.reasonRow
              ? { ...opts.reasonRow, created_at: REASON_AT }
              : undefined,
          ),
        appendHistory: jest.fn(),
      },
      proposalStore: {
        listProposalsByEntity: jest.fn().mockResolvedValue(
          opts.proposals ?? [
            {
              proposed_owner_ref: 'group:default/team-a',
              confidence_score: 0.6,
              status: 'pending',
            },
            {
              proposed_owner_ref: 'group:default/team-b',
              confidence_score: 0.24,
              status: 'possible_owner',
            },
            {
              proposed_owner_ref: 'group:default/team-old',
              confidence_score: 0.5,
              status: 'rejected',
            },
          ],
        ),
      },
      pendingDeadlineStore: { cancelDeadlinesForEntity: jest.fn() },
      escalationQueueStore: {
        findActiveEntry: jest
          .fn()
          .mockResolvedValue(opts.activeQueueEntry ?? null),
        markEntryCompleted: jest.fn(),
      },
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(opts.activeCase),
      listActiveProposalsByEntity: jest
        .fn()
        .mockResolvedValue(opts.activeProposals ?? []),
      withTransaction: jest.fn(async (cb: (t: any) => Promise<unknown>) =>
        cb(tx),
      ),
    } as Partial<OwnershipStore>);
    const proposalGen = makeProposalGenerationService();
    proposalGen.generateProposals.mockResolvedValue(
      opts.generateProposalsResult ?? true,
    );
    const escalationTrigger = createMockEscalationTrigger();
    const svc = new EntityProcessingService(
      makeScmRegistry(),
      proposalGen,
      store,
      [failingCheck],
      enabledCheckNames,
      logger,
      undefined,
      escalationTrigger,
      makeCatalogService(),
    );
    return { svc, tx, proposalGen, escalationTrigger };
  }

  it.each([
    [
      'no_candidates_found',
      { reason: 'no_proposals_generated' },
      'no_proposals_generated',
    ],
    [
      'no_candidates_after_retrigger',
      { reason: 'no_candidates_after_retrigger' },
      'no_candidates_after_retrigger',
    ],
    [
      'escalation_exhausted',
      { reason: 'all_escalation_paths' },
      'all_escalation_paths',
    ],
  ])(
    'reopens a case unresolved via %s when generation finds candidates',
    async (action, details, detail) => {
      const { svc, tx } = buildSvc({
        activeCase: unresolvedCase(),
        // Postgres returns json as an object, SQLite as a string — cover both.
        reasonRow: {
          action,
          details:
            action === 'escalation_exhausted'
              ? details
              : JSON.stringify(details),
        },
      });

      await svc.processEntity(testEntity, checkCtx, 'scan-9', {
        ...emptyScanStats,
      });

      expect(tx.entityStore.reopenEntity).toHaveBeenCalledWith(
        'entity-unresolved',
        7,
      );
      expect(tx.historyStore.appendHistory).toHaveBeenCalledWith({
        entity_id: 'entity-unresolved',
        scan_id: 'scan-9',
        action: 'reopened_candidates_found',
        actor: 'system',
        details: {
          entityRef: 'component:default/svc-alpha',
          previousReason: action,
          previousReasonDetail: detail,
          previousReasonAt: REASON_AT.toISOString(),
          // Only notified candidates — possible owners and the rejected row
          // are not listed.
          candidates: [
            {
              ownerRef: 'group:default/team-a',
              score: 0.6,
              status: 'pending',
            },
          ],
        },
      });
    },
  );

  // Unlike to_archive, unresolved is intentionally NOT in the skip-regen guard:
  // regeneration is what drives this self-heal.
  it('still regenerates proposals for an unresolved case with no active proposals', async () => {
    const { svc, proposalGen } = buildSvc({
      activeCase: unresolvedCase(),
      activeProposals: [],
      reasonRow: { action: 'no_candidates_found', details: null },
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(proposalGen.generateProposals).toHaveBeenCalledTimes(1);
    expect(proposalGen.generateProposals.mock.calls[0][0]).toBe(
      'entity-unresolved',
    );
  });

  it('cleans up escalation leftovers but keeps proposal-level deadlines', async () => {
    const { svc, tx } = buildSvc({
      activeCase: unresolvedCase(),
      reasonRow: {
        action: 'escalation_exhausted',
        details: { reason: 'all_escalation_paths' },
      },
      activeQueueEntry: { id: 'queue-1' },
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(
      tx.pendingDeadlineStore.cancelDeadlinesForEntity,
    ).toHaveBeenCalledWith('entity-unresolved', [
      'escalation_timeout',
      'redecision_expiry',
    ]);
    expect(tx.escalationQueueStore.markEntryCompleted).toHaveBeenCalledWith(
      'queue-1',
    );
  });

  it('reopens when pending proposals already exist (generation skipped)', async () => {
    const { svc, tx, proposalGen } = buildSvc({
      activeCase: unresolvedCase(),
      activeProposals: [{ id: 'p-1' }],
      reasonRow: { action: 'no_candidates_found', details: null },
      proposals: [
        {
          proposed_owner_ref: 'group:default/team-a',
          confidence_score: 0.7,
          status: 'pending',
        },
      ],
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(proposalGen.generateProposals).not.toHaveBeenCalled();
    expect(tx.entityStore.reopenEntity).toHaveBeenCalledTimes(1);
    const details = tx.historyStore.appendHistory.mock.calls[0][0].details;
    expect(details).not.toHaveProperty('previousReasonDetail');
    expect(details.candidates).toEqual([
      { ownerRef: 'group:default/team-a', score: 0.7, status: 'pending' },
    ]);
  });

  it('does not reopen when generation finds no candidates', async () => {
    const { svc, tx, escalationTrigger } = buildSvc({
      activeCase: unresolvedCase(),
      generateProposalsResult: false,
      reasonRow: { action: 'no_candidates_found', details: null },
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(escalationTrigger.triggerEscalation).toHaveBeenCalledWith(
      'entity-unresolved',
    );
    expect(tx.entityStore.reopenEntity).not.toHaveBeenCalled();
  });

  it('stays unresolved when only possible owners are found', async () => {
    const { svc, tx } = buildSvc({
      activeCase: unresolvedCase(),
      reasonRow: { action: 'no_candidates_found', details: null },
      proposals: [
        {
          proposed_owner_ref: 'group:default/team-a',
          confidence_score: 0.24,
          status: 'possible_owner',
        },
      ],
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(tx.entityStore.reopenEntity).not.toHaveBeenCalled();
    expect(tx.historyStore.appendHistory).not.toHaveBeenCalled();
  });

  it('does not reopen a legacy unresolved case with no recorded reason', async () => {
    const { svc, tx } = buildSvc({
      activeCase: unresolvedCase(),
      reasonRow: undefined,
    });

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(tx.entityStore.reopenEntity).not.toHaveBeenCalled();
    expect(tx.historyStore.appendHistory).not.toHaveBeenCalled();
  });

  it('does not touch a case that is not unresolved', async () => {
    const { svc } = buildSvc({
      activeCase: unresolvedCase('open'),
      reasonRow: { action: 'no_candidates_found', details: null },
    });
    const withTransaction = (svc as any).store.withTransaction as jest.Mock;

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('does not reopen when the case changed status inside the transaction', async () => {
    const { svc, tx } = buildSvc({
      activeCase: unresolvedCase(),
      reasonRow: { action: 'no_candidates_found', details: null },
    });
    tx.entityStore.getEntityByIdForUpdate.mockResolvedValue(
      unresolvedCase('closed'),
    );

    await svc.processEntity(testEntity, checkCtx, 'scan-9', {
      ...emptyScanStats,
    });

    expect(tx.entityStore.reopenEntity).not.toHaveBeenCalled();
  });
});
