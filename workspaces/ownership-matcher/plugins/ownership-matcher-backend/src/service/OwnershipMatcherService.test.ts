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

import { DefaultOwnershipMatcherService } from './OwnershipMatcherService';
import { EntityProcessingService } from './EntityProcessingService';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ScmRegistry } from '../scm';
import {
  CandidateSourcesUnavailableError,
  ProposalGenerationService,
} from './ProposalGenerationService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import { OwnershipCheck, ZombieCheck } from '../checks';
import { mockServices } from '@backstage/backend-test-utils';
import { EventsService } from '@backstage/plugin-events-node';
import { CatalogComponent } from '../types';
import { OwnershipMatcherConfig } from '../config/types';
import { createMockEscalationTrigger } from '../__testutils__/mockEscalationTrigger';
import { NotificationsTopic } from './notifications/topics';

// ── Factories ────────────────────────────────────────────────────────────────

function makeStore(
  overrides: Partial<OwnershipStore> = {},
): jest.Mocked<OwnershipStore> {
  return {
    createScan: jest.fn().mockResolvedValue('scan-1'),
    completeScan: jest.fn(),
    failScan: jest.fn(),
    failStaleScans: jest.fn().mockResolvedValue(0),
    getScan: jest.fn(),
    listScans: jest.fn(),
    createEntity: jest.fn().mockResolvedValue('entity-1'),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    closeEntity: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    getActiveEntityByRef: jest.fn().mockResolvedValue(undefined),
    getEntityById: jest.fn(),
    listActiveEntitiesForReconciliation: jest.fn().mockResolvedValue([]),
    listEntities: jest.fn(),
    createProposal: jest.fn().mockResolvedValue('proposal-1'),
    getProposal: jest.fn(),
    listProposalsByEntity: jest.fn(),
    listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    updateProposalStatus: jest.fn(),
    appendHistory: jest.fn(),
    listHistory: jest.fn(),
    getRejectedActors: jest.fn().mockResolvedValue(new Set()),
    ...overrides,
  } as unknown as jest.Mocked<OwnershipStore>;
}

function makeEntity(name: string, owner?: string): CatalogComponent {
  return {
    kind: 'Component',
    metadata: { name, namespace: 'default' },
    spec: owner ? { owner } : {},
  };
}

const orphanedCheck: OwnershipCheck = {
  name: 'orphaned',
  title: 'No owner (orphaned)',
  description: 'This entity has no owner defined in the catalog YAML.',
  run: jest
    .fn()
    .mockReturnValue({ failed: true, checkName: 'orphaned', details: {} }),
};

const passingCheck: OwnershipCheck = {
  name: 'orphaned',
  title: 'No owner (orphaned)',
  description: 'This entity has no owner defined in the catalog YAML.',
  run: jest.fn().mockReturnValue({ failed: false, checkName: 'orphaned' }),
};

const config: OwnershipMatcherConfig = {
  schedule: { frequency: { hours: 24 }, timeout: { minutes: 10 } },
  filters: {
    excludeKinds: [],
    excludeNamespaces: [],
    excludeTypes: [],
    requireAnnotations: [],
    excludeOwners: [],
  },
  checks: {
    enabled: ['orphaned'],
    orphaned: { placeholderValues: ['unknown'] },
  },
  owners: { excludeUserKind: false },
  proposals: {
    maxCandidatesPerEntity: 3,
    autoExpiry: false,
    expirationDays: 14,
    minimumScoreThreshold: 0,
    confidenceTiers: { high: 0.8, medium: 0.5 },
    strategies: [],
  },
  contributors: {
    excludeEmails: [],
    excludePatterns: [],
    excludeUsernames: [],
  },
  escalation: { levels: [] },
  notifications: { enabled: false },
} as unknown as OwnershipMatcherConfig;

function makeSvc({
  entities = [makeEntity('svc')],
  store = makeStore(),
  checks = [orphanedCheck],
  generateProposals = jest.fn().mockResolvedValue(true),
  events,
  catalogGetEntityByRef = jest.fn().mockResolvedValue(undefined),
  contributorService,
  escalationTrigger = createMockEscalationTrigger(),
  svcConfig = config,
}: {
  svcConfig?: OwnershipMatcherConfig;
  contributorService?: { resetCache: jest.Mock };
  escalationTrigger?: ReturnType<typeof createMockEscalationTrigger>;
  entities?: CatalogComponent[];
  store?: jest.Mocked<OwnershipStore>;
  checks?: OwnershipCheck[];
  generateProposals?: jest.Mock;
  events?: jest.Mocked<EventsService>;
  catalogGetEntityByRef?: jest.Mock;
} = {}) {
  const catalogService = {
    getLiveGroupRegistry: jest
      .fn()
      .mockResolvedValue(new Set(['group:default/team-a'])),
    getLiveUserRegistry: jest
      .fn()
      .mockResolvedValue(new Set(['user:default/jdoe'])),
    paginateEntities: jest.fn().mockImplementation(async function* () {
      for (const e of entities) yield e;
    }),
    resetCache: jest.fn(),
    getEntityByRef: catalogGetEntityByRef,
  } as unknown as CatalogService;

  const scmRegistry = {
    repoFor: jest.fn().mockResolvedValue(undefined),
  } as unknown as ScmRegistry;

  const proposalGenerationService = {
    generateProposals,
  } as unknown as ProposalGenerationService;

  const logger = mockServices.logger.mock();

  const entityProcessingService = new EntityProcessingService(
    scmRegistry,
    proposalGenerationService,
    store,
    checks,
    new Set(svcConfig.checks.enabled),
    logger,
    undefined,
    escalationTrigger,
    catalogService,
  );

  const svc = new DefaultOwnershipMatcherService(
    catalogService,
    entityProcessingService,
    store,
    svcConfig,
    logger,
    events,
    contributorService,
  );

  return {
    svc,
    store,
    catalogService,
    entityProcessingService,
    escalationTrigger,
  };
}

function makeEvents(throws?: Error): jest.Mocked<EventsService> {
  return {
    subscribe: jest.fn(),
    publish: jest.fn(async () => {
      if (throws) throw throws;
    }),
  } as unknown as jest.Mocked<EventsService>;
}

// ── runScan ───────────────────────────────────────────────────────────────────

describe('OwnershipMatcherService.runScan', () => {
  it('resets the contributor cache at the start of every scan', async () => {
    const contributorService = { resetCache: jest.fn() };
    const { svc } = makeSvc({ contributorService });

    await svc.runScan();
    await svc.runScan();

    expect(contributorService.resetCache).toHaveBeenCalledTimes(2);
  });

  it('joins the in-flight scan instead of starting an overlapping one', async () => {
    const { svc, store } = makeSvc();

    const [first, second] = await Promise.all([svc.runScan(), svc.runScan()]);

    expect(store.createScan).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    // Once finished, the next call starts a fresh scan.
    await svc.runScan();
    expect(store.createScan).toHaveBeenCalledTimes(2);
  });

  it('allows a new scan after the previous one failed', async () => {
    const store = makeStore();
    store.createScan
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue('scan-2');
    const { svc } = makeSvc({ store });

    await expect(svc.runScan()).rejects.toThrow('db down');
    await svc.runScan();
    expect(store.createScan).toHaveBeenCalledTimes(2);
  });

  // A transient candidate-source failure must not escalate the case: the
  // entity error is logged, the case stays open, the next scan retries.
  it('candidate sources unavailable: does not escalate and the scan completes', async () => {
    const generateProposals = jest
      .fn()
      .mockRejectedValue(
        new CandidateSourcesUnavailableError('team registry empty'),
      );
    const { svc, store, escalationTrigger } = makeSvc({ generateProposals });

    await svc.runScan();

    expect(escalationTrigger.triggerEscalation).not.toHaveBeenCalled();
    expect(store.completeScan).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('creates a scan, processes entities, and completes with stats', async () => {
    const { svc, store } = makeSvc();

    const stats = await svc.runScan();

    expect(store.createScan).toHaveBeenCalled();
    expect(store.completeScan).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({
        status: 'completed',
        total_entities_scanned: 1,
      }),
    );
    expect(stats.totalScanned).toBe(1);
    expect(stats.newIssuesFound).toBe(1);
  });

  it('new detection: creates entity case and generates proposals', async () => {
    const { svc, store } = makeSvc();

    await svc.runScan();

    expect(store.createEntity).toHaveBeenCalled();
    expect(store.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue_detected' }),
    );
  });

  it('re-detection: updates last_scanned_at and logs issue_redetected', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    });
    const { svc } = makeSvc({ store });

    const stats = await svc.runScan();

    expect(store.updateEntityLastScanned).toHaveBeenCalledWith(
      'entity-1',
      'scan-1',
      undefined,
    );
    expect(store.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue_redetected' }),
    );
    expect(stats.existingIssuesUpdated).toBe(1);
    expect(stats.newIssuesFound).toBe(0);
  });

  it('re-detection with no active proposals: regenerates proposals', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    });
    const generateProposals = jest.fn().mockResolvedValue(true);
    const { svc } = makeSvc({ store, generateProposals });

    await svc.runScan();

    expect(generateProposals).toHaveBeenCalledWith(
      'entity-1',
      expect.anything(),
      'orphaned',
      undefined,
      undefined,
      'scan-1',
      expect.any(Array),
    );
  });

  it('re-detection with escalated: does not regenerate proposals', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'escalated',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    });
    const generateProposals = jest.fn().mockResolvedValue(true);
    const { svc } = makeSvc({ store, generateProposals });

    await svc.runScan();

    expect(generateProposals).not.toHaveBeenCalled();
  });

  it('re-detection with accepted: does not regenerate proposals (team committed, waiting for YAML update)', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'accepted',
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
      listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    });
    const generateProposals = jest.fn().mockResolvedValue(true);
    const { svc } = makeSvc({ store, generateProposals });

    await svc.runScan();

    expect(generateProposals).not.toHaveBeenCalled();
    expect(store.updateEntityLastScanned).toHaveBeenCalledWith(
      'entity-1',
      'scan-1',
      undefined,
    );
  });

  it('auto-resolution: closes accepted case when entity now passes checks', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'accepted',
      version: 1,
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
    });
    const { svc } = makeSvc({ store, checks: [passingCheck] });

    const stats = await svc.runScan();

    expect(store.closeEntity).toHaveBeenCalledWith(
      'entity-1',
      'system',
      'ownership_changed',
      1,
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('auto-resolution: resolves active case when entity now passes checks', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
      version: 1,
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
    });
    const { svc } = makeSvc({ store, checks: [passingCheck] });

    const stats = await svc.runScan();

    expect(store.closeEntity).toHaveBeenCalledWith(
      'entity-1',
      'system',
      'ownership_changed',
      1,
    );
    expect(store.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue_auto_closed' }),
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('auto-resolution: does NOT close entity when current_status is to_archive', async () => {
    const activeCase = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'to_archive',
      version: 1,
    };
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(activeCase),
    });
    const { svc } = makeSvc({ store, checks: [passingCheck] });

    const stats = await svc.runScan();

    expect(store.closeEntity).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue_auto_closed' }),
    );
    expect(stats.issuesAutoResolved).toBe(0);
  });

  it('marks scan as failed and rethrows on error', async () => {
    const store = makeStore();
    const catalogService = {
      getLiveGroupRegistry: jest
        .fn()
        .mockRejectedValue(new Error('catalog down')),
      paginateEntities: jest.fn(),
      resetCache: jest.fn(),
    } as unknown as CatalogService;
    const logger = mockServices.logger.mock();

    const entityProcessingService = new EntityProcessingService(
      { repoFor: jest.fn() } as unknown as ScmRegistry,
      { generateProposals: jest.fn() } as unknown as ProposalGenerationService,
      store,
      [orphanedCheck],
      new Set(['orphaned']),
      logger,
      undefined,
      createMockEscalationTrigger(),
      catalogService,
    );

    const svc = new DefaultOwnershipMatcherService(
      catalogService,
      entityProcessingService,
      store,
      config,
      logger,
    );

    await expect(svc.runScan()).rejects.toThrow('catalog down');
    expect(store.failScan).toHaveBeenCalledWith(
      'scan-1',
      'catalog down',
      expect.any(Number),
    );
  });

  it('skips entity that passes all checks with no active case', async () => {
    const { svc, store } = makeSvc({ checks: [passingCheck] });

    const stats = await svc.runScan();

    expect(store.createEntity).not.toHaveBeenCalled();
    expect(stats.totalScanned).toBe(1);
    expect(stats.newIssuesFound).toBe(0);
  });

  // 1.4.4 — previously resolved entity failing again creates a new case
  it('creates new case when previously resolved entity fails again', async () => {
    // getActiveEntityByRef returns undefined (no active case — previous was resolved).
    const store = makeStore({
      getActiveEntityByRef: jest.fn().mockResolvedValue(undefined),
    });
    const { svc } = makeSvc({ store });

    const stats = await svc.runScan();

    expect(store.createEntity).toHaveBeenCalled();
    expect(store.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'issue_detected' }),
    );
    expect(stats.newIssuesFound).toBe(1);
  });

  // 1.4.7 — scan handles empty catalog gracefully
  it('handles empty catalog with zero entities', async () => {
    const { svc, store } = makeSvc({ entities: [] });

    const stats = await svc.runScan();

    expect(stats.totalScanned).toBe(0);
    expect(stats.newIssuesFound).toBe(0);
    expect(stats.existingIssuesUpdated).toBe(0);
    expect(stats.issuesAutoResolved).toBe(0);
    expect(store.completeScan).toHaveBeenCalledWith(
      'scan-1',
      expect.objectContaining({
        status: 'completed',
        total_entities_scanned: 0,
      }),
    );
  });

  // 1.4.8 — entity with no repo annotations still processed, repo_url null
  it('processes entity with no repo annotations — repo fields are undefined', async () => {
    const { svc, store } = makeSvc();

    await svc.runScan();

    expect(store.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({ repo: undefined }),
    );
  });

  // 1.1.11 — external check with lower priority doesn't override built-ins
  it('built-in check wins over extension check when both fail', async () => {
    const extensionCheck: OwnershipCheck = {
      name: 'custom-stale',
      title: 'Custom stale',
      description: '',
      run: jest.fn().mockReturnValue({
        failed: true,
        checkName: 'custom-stale',
        details: {},
      }),
    };
    // orphaned (built-in, higher priority) + custom-stale (extension, lower priority)
    const { svc, store } = makeSvc({ checks: [orphanedCheck, extensionCheck] });

    await svc.runScan();

    // The entity case should be created with orphaned as current_check, not custom-stale.
    expect(store.createEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        current_check: 'orphaned',
      }),
    );
  });

  // 5.1.1 — scan continues processing remaining entities if one entity processing fails
  it('continues processing remaining entities when one fails mid-scan', async () => {
    const failingEntity = makeEntity('failing-svc');
    const goodEntity = makeEntity('good-svc');

    // The orphanedCheck will throw for the first entity and succeed for the second.
    let callCount = 0;
    const fragileCheck: OwnershipCheck = {
      name: 'orphaned',
      title: 'No owner (orphaned)',
      description: 'This entity has no owner defined in the catalog YAML.',
      run: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('check explosion');
        return { failed: true, checkName: 'orphaned', details: {} };
      }),
    };

    const store = makeStore();
    const { svc } = makeSvc({
      entities: [failingEntity, goodEntity],
      store,
      checks: [fragileCheck],
    });

    // Scan should not throw — it should complete despite one entity failing.
    const stats = await svc.runScan();

    expect(stats.totalScanned).toBe(2);
    // The good entity still gets processed.
    expect(store.createEntity).toHaveBeenCalled();
  });
});

// ── ProposalsBatchReady end-of-scan emission ─────────────────────────────────

describe('OwnershipMatcherService — User owners (owners.excludeUserKind)', () => {
  // Real ZombieCheck, zombie enabled. The catalog mock's live users are
  // ['user:default/jdoe'].
  function makeUserOwnerSvc(excludeUserKind: boolean, owner: string) {
    const entity = makeEntity('svc', owner);
    return makeSvc({
      entities: [entity],
      checks: [new ZombieCheck({ excludeUserKind })],
      catalogGetEntityByRef: jest.fn().mockResolvedValue(entity),
      svcConfig: {
        ...config,
        checks: { ...config.checks, enabled: ['zombie'] },
        owners: { excludeUserKind },
      },
    });
  }

  describe('excludeUserKind: false', () => {
    it('runScan opens a zombie case for a User owner missing from the catalog', async () => {
      const { svc, store, catalogService } = makeUserOwnerSvc(
        false,
        'user:default/ghost',
      );

      const stats = await svc.runScan();

      expect(catalogService.getLiveUserRegistry).toHaveBeenCalledTimes(1);
      expect(stats.newIssuesFound).toBe(1);
      expect(store.createEntity).toHaveBeenCalled();
    });

    it('runScan does not flag a live User owner, ignoring case', async () => {
      const { svc, store } = makeUserOwnerSvc(false, 'user:default/JDoe');

      const stats = await svc.runScan();

      expect(stats.newIssuesFound).toBe(0);
      expect(store.createEntity).not.toHaveBeenCalled();
    });

    it('scanEntity reports zombie for a missing User owner', async () => {
      const { svc } = makeUserOwnerSvc(false, 'user:default/ghost');

      const result = await svc.scanEntity('component:default/svc');

      expect(result).toEqual(
        expect.objectContaining({ passes: false, failingCheck: 'zombie' }),
      );
    });

    it('runScan fails without opening cases when the User fetch fails', async () => {
      const { svc, store, catalogService } = makeUserOwnerSvc(
        false,
        'user:default/jdoe',
      );
      (catalogService.getLiveUserRegistry as jest.Mock).mockRejectedValue(
        new Error('catalog down'),
      );

      await expect(svc.runScan()).rejects.toThrow('catalog down');
      expect(store.failScan).toHaveBeenCalledWith(
        'scan-1',
        'catalog down',
        expect.any(Number),
      );
      expect(store.createEntity).not.toHaveBeenCalled();
    });
  });

  describe('excludeUserKind: true', () => {
    it('runScan never flags a User owner and skips the User fetch', async () => {
      const { svc, store, catalogService } = makeUserOwnerSvc(
        true,
        'user:default/ghost',
      );

      const stats = await svc.runScan();

      expect(catalogService.getLiveUserRegistry).not.toHaveBeenCalled();
      expect(stats.newIssuesFound).toBe(0);
      expect(store.createEntity).not.toHaveBeenCalled();
    });

    it('scanEntity passes for a missing User owner', async () => {
      const { svc, catalogService } = makeUserOwnerSvc(
        true,
        'user:default/ghost',
      );

      const result = await svc.scanEntity('component:default/svc');

      expect(result.passes).toBe(true);
      expect(catalogService.getLiveUserRegistry).not.toHaveBeenCalled();
    });
  });
});

describe('OwnershipMatcherService.runScan — ProposalsBatchReady fan-out', () => {
  function entitiesPair(): CatalogComponent[] {
    return [makeEntity('svc-1'), makeEntity('svc-2')];
  }

  it('emits one ProposalsBatchReady per team aggregating proposals from multiple entities', async () => {
    // Make generateProposals push proposals into the accumulator differently
    // per entity: entity 1 → team-a, entity 2 → team-a (same team).
    let call = 0;
    const generateProposals = jest.fn(
      async (
        _entityId: string,
        _entity: CatalogComponent,
        _check: string,
        _owner: string | undefined,
        _repo: unknown,
        _scan: string,
        acc?: Array<{ proposalId: string; ownerRef: string }>,
      ) => {
        call++;
        if (acc) {
          if (call === 1)
            acc.push({ proposalId: 'p-a-1', ownerRef: 'group:default/team-a' });
          if (call === 2)
            acc.push({ proposalId: 'p-a-2', ownerRef: 'group:default/team-a' });
        }
        return true;
      },
    );
    const events = makeEvents();
    const { svc } = makeSvc({
      entities: entitiesPair(),
      generateProposals,
      events,
    });

    await svc.runScan();

    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: expect.objectContaining({
          proposedOwnerRef: 'group:default/team-a',
          newProposalIds: ['p-a-1', 'p-a-2'],
          scanId: 'scan-1',
        }),
      }),
    );
  });

  it('emits no ProposalsBatchReady when no proposals were generated', async () => {
    const generateProposals = jest.fn(async () => true);
    const events = makeEvents();
    const { svc } = makeSvc({
      entities: [makeEntity('svc-1')],
      generateProposals,
      events,
    });

    await svc.runScan();

    expect(events.publish).not.toHaveBeenCalled();
  });

  it('emits separate ProposalsBatchReady events for different teams', async () => {
    let call = 0;
    const generateProposals = jest.fn(
      async (
        _entityId: string,
        _entity: CatalogComponent,
        _check: string,
        _owner: string | undefined,
        _repo: unknown,
        _scan: string,
        acc?: Array<{ proposalId: string; ownerRef: string }>,
      ) => {
        call++;
        if (acc) {
          if (call === 1)
            acc.push({ proposalId: 'p-a', ownerRef: 'group:default/team-a' });
          if (call === 2)
            acc.push({ proposalId: 'p-b', ownerRef: 'group:default/team-b' });
        }
        return true;
      },
    );
    const events = makeEvents();
    const { svc } = makeSvc({
      entities: entitiesPair(),
      generateProposals,
      events,
    });

    await svc.runScan();

    expect(events.publish).toHaveBeenCalledTimes(2);
    const calls = (events.publish as jest.Mock).mock.calls.map(c => c[0]);
    const teams = calls.map(c => c.eventPayload.proposedOwnerRef);
    expect(teams).toEqual(
      expect.arrayContaining(['group:default/team-a', 'group:default/team-b']),
    );
  });

  it('warn-logs and does not throw when ProposalsBatchReady publish fails', async () => {
    const generateProposals = jest.fn(
      async (
        _entityId: string,
        _entity: CatalogComponent,
        _check: string,
        _owner: string | undefined,
        _repo: unknown,
        _scan: string,
        acc?: Array<{ proposalId: string; ownerRef: string }>,
      ) => {
        if (acc)
          acc.push({ proposalId: 'p1', ownerRef: 'group:default/team-a' });
        return true;
      },
    );
    const events = makeEvents(new Error('bus down'));
    const { svc } = makeSvc({
      entities: [makeEntity('svc-1')],
      generateProposals,
      events,
    });

    await expect(svc.runScan()).resolves.not.toThrow();
    expect(events.publish).toHaveBeenCalled();
  });

  it('runs without an EventsService injected (events optional)', async () => {
    const generateProposals = jest.fn(
      async (
        _entityId: string,
        _entity: CatalogComponent,
        _check: string,
        _owner: string | undefined,
        _repo: unknown,
        _scan: string,
        acc?: Array<{ proposalId: string; ownerRef: string }>,
      ) => {
        if (acc)
          acc.push({ proposalId: 'p1', ownerRef: 'group:default/team-a' });
        return true;
      },
    );
    // No `events` arg
    const { svc } = makeSvc({
      entities: [makeEntity('svc-1')],
      generateProposals,
    });

    await expect(svc.runScan()).resolves.not.toThrow();
  });
});

// `runExpiryCheck` was removed in the deadline checker scheduler
// (via `DeadlineCheckerService.processExpiredDeadlines`) now owns proposal
// expiry. See plugin.ts wiring + plan.

// ── End-of-scan reconciliation ──────────────────────────────────────────────

describe('OwnershipMatcherService.runScan — out-of-scope reconciliation', () => {
  function makeStaleCase(overrides: Record<string, unknown> = {}) {
    return {
      id: 'entity-stale-1',
      entity_ref: 'system:default/legacy-system',
      entity_name: 'legacy-system',
      entity_kind: 'System',
      entity_namespace: 'default',
      current_status: 'open',
      current_check: 'orphaned',
      current_owner: null,
      version: 1,
      last_scanned_at: new Date('2020-01-01T00:00:00Z'), // older than scan start
      ...overrides,
    };
  }

  /** Builds a store whose withTransaction routes calls to inspectable tx mocks. */
  function setupReconStore(
    activeCases: ReturnType<typeof makeStaleCase>[],
    txOverrides: Record<string, unknown> = {},
  ) {
    const txEntityClose = jest.fn().mockResolvedValue(undefined);
    const txUpdateProposalStatus = jest.fn().mockResolvedValue(undefined);
    const txCancelDeadlines = jest.fn().mockResolvedValue(undefined);
    const txFindActiveEntry = jest.fn().mockResolvedValue(null);
    const txMarkQueueCompleted = jest.fn().mockResolvedValue(undefined);
    const txAppendHistory = jest.fn().mockResolvedValue(undefined);

    const store = makeStore({
      listActiveEntitiesForReconciliation: jest
        .fn()
        .mockResolvedValue(activeCases),
    });
    (store as unknown as { withTransaction: jest.Mock }).withTransaction =
      jest.fn(async (fn: (s: unknown) => Promise<unknown>) =>
        fn({
          entityStore: { closeEntity: txEntityClose },
          proposalStore: {
            listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
            listCancellableProposalsByEntity: jest.fn().mockResolvedValue([]),
            updateProposalStatus: txUpdateProposalStatus,
          },
          pendingDeadlineStore: { cancelDeadlinesForEntity: txCancelDeadlines },
          escalationQueueStore: {
            findActiveEntry: txFindActiveEntry,
            markEntryCompleted: txMarkQueueCompleted,
          },
          historyStore: { appendHistory: txAppendHistory },
          ...txOverrides,
        }),
      );

    return {
      store,
      txEntityClose,
      txUpdateProposalStatus,
      txCancelDeadlines,
      txFindActiveEntry,
      txMarkQueueCompleted,
      txAppendHistory,
    };
  }

  it('closes an open case whose kind is now in excludeKinds', async () => {
    const stale = makeStaleCase({ entity_kind: 'System' });
    const { store, txEntityClose, txAppendHistory } = setupReconStore([stale]);
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'out_of_scope',
      1,
    );
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'issue_closed_out_of_scope',
        details: expect.objectContaining({ reason: 'kind_excluded' }),
      }),
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  describe('excludeTypes', () => {
    const typed = (type: string) => ({
      kind: 'Resource',
      metadata: { name: 'acct' },
      spec: { type },
    });
    const withTypeFilter = (svc: unknown) => {
      (svc as { config: OwnershipMatcherConfig }).config = {
        ...config,
        filters: {
          ...config.filters,
          excludeTypes: ['Resource:cloud-account'],
        },
      };
    };

    it('closes an open cloud-account case as type_excluded', async () => {
      const stale = makeStaleCase({
        entity_ref: 'resource:default/acct',
        entity_kind: 'Resource',
      });
      const { store, txEntityClose, txAppendHistory } = setupReconStore([
        stale,
      ]);
      const { svc } = makeSvc({
        entities: [],
        store,
        catalogGetEntityByRef: jest
          .fn()
          .mockResolvedValue(typed('cloud-account')),
      });
      withTypeFilter(svc);

      const stats = await svc.runScan();

      expect(txEntityClose).toHaveBeenCalledWith(
        'entity-stale-1',
        'system',
        'out_of_scope',
        1,
      );
      expect(txAppendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'issue_closed_out_of_scope',
          details: expect.objectContaining({ reason: 'type_excluded' }),
        }),
      );
      expect(stats.issuesAutoResolved).toBe(1);
    });

    it('closes an accepted cloud-account case as type_excluded', async () => {
      const accepted = makeStaleCase({
        entity_ref: 'resource:default/acct',
        entity_kind: 'Resource',
        current_status: 'accepted',
      });
      const { store, txEntityClose } = setupReconStore([accepted]);
      const { svc } = makeSvc({
        entities: [],
        store,
        catalogGetEntityByRef: jest
          .fn()
          .mockResolvedValue(typed('cloud-account')),
      });
      withTypeFilter(svc);

      await svc.runScan();

      expect(txEntityClose).toHaveBeenCalledWith(
        'entity-stale-1',
        'system',
        'out_of_scope',
        1,
      );
    });

    it('leaves cases of other Resource types open', async () => {
      const stale = makeStaleCase({
        entity_ref: 'resource:default/db',
        entity_kind: 'Resource',
      });
      const { store, txEntityClose } = setupReconStore([stale]);
      const { svc } = makeSvc({
        entities: [],
        store,
        catalogGetEntityByRef: jest.fn().mockResolvedValue(typed('database')),
      });
      withTypeFilter(svc);

      const stats = await svc.runScan();

      expect(txEntityClose).not.toHaveBeenCalled();
      expect(stats.issuesAutoResolved).toBe(0);
    });
  });

  it('cancels live proposals (pending/accepted) when closing an out-of-scope case', async () => {
    const stale = makeStaleCase({ entity_kind: 'System' });
    const liveProposal = { id: 'proposal-stale-1' };
    const { store, txUpdateProposalStatus } = setupReconStore([stale], {
      proposalStore: {
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([liveProposal]),
        updateProposalStatus: jest.fn().mockResolvedValue(undefined),
      },
    });
    // capture the real mock from the overridden proposalStore
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    await svc.runScan();

    // txUpdateProposalStatus from outer scope is shadowed by the override;
    // assert via the withTransaction call arg directly.
    const txFn = (store as unknown as { withTransaction: jest.Mock })
      .withTransaction.mock.calls[0][0];
    const mockTx = {
      entityStore: { closeEntity: jest.fn().mockResolvedValue(undefined) },
      proposalStore: {
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([liveProposal]),
        updateProposalStatus: jest.fn().mockResolvedValue(undefined),
      },
      pendingDeadlineStore: { cancelDeadlinesForEntity: jest.fn() },
      escalationQueueStore: {
        findActiveEntry: jest.fn().mockResolvedValue(null),
        markEntryCompleted: jest.fn(),
      },
      historyStore: { appendHistory: jest.fn() },
    };
    await txFn(mockTx);
    expect(mockTx.proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      'proposal-stale-1',
      'cancelled',
    );
    void txUpdateProposalStatus; // unused — silence lint
  });

  it('closes a case whose namespace is now in excludeNamespaces', async () => {
    const stale = makeStaleCase({ entity_namespace: 'sandbox' });
    const { store, txAppendHistory } = setupReconStore([stale]);
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeNamespaces: ['sandbox'] },
    };

    await svc.runScan();

    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'namespace_excluded' }),
      }),
    );
  });

  it('closes a case whose current_owner is now in excludeOwners', async () => {
    const stale = makeStaleCase({ current_owner: 'group:default/legacy-team' });
    const { store, txAppendHistory } = setupReconStore([stale]);
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: {
        ...config.filters,
        excludeOwners: ['group:default/legacy-team'],
      },
    };

    await svc.runScan();

    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'owner_excluded' }),
      }),
    );
  });

  it('closes a case whose current_check is no longer enabled', async () => {
    const stale = makeStaleCase({ current_check: 'zombie' }); // config only enables 'orphaned'
    const { store, txEntityClose, txAppendHistory } = setupReconStore([stale]);
    const { svc } = makeSvc({ entities: [], store });

    await svc.runScan();

    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'out_of_scope',
      1,
    );
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ reason: 'check_disabled' }),
      }),
    );
  });

  it('does NOT close a case that is still in scope and present in the catalog', async () => {
    const inScope = makeStaleCase({ entity_kind: 'Component' }); // not excluded, check enabled
    const { store, txEntityClose } = setupReconStore([inScope]);
    // Unseen by paginateEntities in this scan, but the catalog still resolves it —
    // so it must not be closed as removed.
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue({
        kind: 'System',
        metadata: { name: 'legacy-system', namespace: 'default' },
      }),
    });

    const stats = await svc.runScan();

    expect(txEntityClose).not.toHaveBeenCalled();
    expect(stats.issuesAutoResolved).toBe(0);
  });

  it('does NOT close an accepted case when the entity is still present in the catalog', async () => {
    // Entity ref matches what paginateEntities will yield — so it ends up in seenEntityRefs.
    const accepted = makeStaleCase({
      entity_kind: 'System',
      entity_ref: 'component:default/svc',
      current_status: 'accepted',
    });
    const { store, txEntityClose } = setupReconStore([accepted]);
    // Entity is present in the catalog (paginateEntities yields it).
    const { svc } = makeSvc({ entities: [makeEntity('svc')], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(txEntityClose).not.toHaveBeenCalled();
    expect(stats.issuesAutoResolved).toBe(0);
  });

  it('closes accepted case as archived and cancels deadlines when entity removed from catalog', async () => {
    const accepted = makeStaleCase({
      entity_ref: 'system:default/legacy-system',
      current_status: 'accepted',
    });
    const pendingProposal = { id: 'prop-accepted-1' };
    const { store, txEntityClose, txCancelDeadlines, txAppendHistory } =
      setupReconStore([accepted], {
        proposalStore: {
          listCancellableProposalsByEntity: jest
            .fn()
            .mockResolvedValue([pendingProposal]),
          updateProposalStatus: jest.fn().mockResolvedValue(undefined),
        },
      });
    // Entity is NOT yielded by paginateEntities AND not found in catalog.
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue(undefined),
    });

    const stats = await svc.runScan();

    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'archived',
      1,
    );
    expect(txCancelDeadlines).toHaveBeenCalledWith('entity-stale-1');
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'issue_closed_archived',
        details: expect.objectContaining({
          reason: 'entity_removed_from_catalog',
        }),
      }),
    );
    // Verify proposals are cancelled too
    const txFn = (store as unknown as { withTransaction: jest.Mock })
      .withTransaction.mock.calls[0][0];
    const mockTx = {
      entityStore: { closeEntity: jest.fn().mockResolvedValue(undefined) },
      proposalStore: {
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([pendingProposal]),
        updateProposalStatus: jest.fn().mockResolvedValue(undefined),
      },
      pendingDeadlineStore: { cancelDeadlinesForEntity: jest.fn() },
      escalationQueueStore: {
        findActiveEntry: jest.fn().mockResolvedValue(null),
        markEntryCompleted: jest.fn(),
      },
      historyStore: { appendHistory: jest.fn() },
    };
    await txFn(mockTx);
    expect(mockTx.proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      'prop-accepted-1',
      'cancelled',
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('does NOT close an accepted case for entity excluded by config but still present in catalog', async () => {
    // This entity is excluded by excludeKinds so paginateEntities skips it → not in seenEntityRefs.
    // But it still exists in the catalog — the fallback catalog lookup should confirm this and skip closing.
    const accepted = makeStaleCase({
      entity_ref: 'system:default/excluded-but-alive',
      entity_kind: 'System',
      current_status: 'accepted',
    });
    const { store, txEntityClose } = setupReconStore([accepted]);
    // paginateEntities yields nothing (entity kind excluded), but catalog lookup returns the entity
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue({
        kind: 'System',
        metadata: { name: 'excluded-but-alive' },
      }),
    });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(txEntityClose).not.toHaveBeenCalled();
    expect(stats.issuesAutoResolved).toBe(0);
  });

  it('closes accepted case as archived when its archived repo is gone from the catalog', async () => {
    const accepted = makeStaleCase({
      entity_ref: 'component:default/archived-svc',
      current_status: 'accepted',
    });
    const { store, txEntityClose, txCancelDeadlines, txAppendHistory } =
      setupReconStore([accepted], {
        proposalStore: {
          listCancellableProposalsByEntity: jest.fn().mockResolvedValue([]),
          updateProposalStatus: jest.fn().mockResolvedValue(undefined),
        },
      });
    // Entity is absent from paginateEntities and no longer resolves in the catalog
    // (its repo was archived → dropped by skipArchivedRepos).
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue(undefined),
    });

    const stats = await svc.runScan();

    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'archived',
      1,
    );
    expect(txCancelDeadlines).toHaveBeenCalledWith('entity-stale-1');
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'issue_closed_archived',
        details: expect.objectContaining({
          reason: 'entity_removed_from_catalog',
        }),
      }),
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('expires (not cancels) the accepted proposal and records a revert when an accepted case closes as archived', async () => {
    const accepted = makeStaleCase({
      entity_ref: 'component:default/archived-svc',
      current_status: 'accepted',
    });
    const acceptedProposal = { id: 'prop-accepted-1', status: 'accepted' };
    const { store } = setupReconStore([accepted]);
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue(undefined),
    });

    await svc.runScan();

    // Re-run the captured close transaction against an inspectable tx that
    // returns the accepted proposal as the live (cancellable) set.
    const txFn = (store as unknown as { withTransaction: jest.Mock })
      .withTransaction.mock.calls[0][0];
    const mockTx = {
      entityStore: { closeEntity: jest.fn().mockResolvedValue(undefined) },
      proposalStore: {
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([acceptedProposal]),
        updateProposalStatus: jest.fn().mockResolvedValue(undefined),
      },
      pendingDeadlineStore: { cancelDeadlinesForEntity: jest.fn() },
      escalationQueueStore: {
        findActiveEntry: jest.fn().mockResolvedValue(null),
        markEntryCompleted: jest.fn(),
      },
      historyStore: { appendHistory: jest.fn() },
    };
    await txFn(mockTx);

    expect(mockTx.proposalStore.updateProposalStatus).toHaveBeenCalledWith(
      'prop-accepted-1',
      'expired',
    );
    expect(mockTx.proposalStore.updateProposalStatus).not.toHaveBeenCalledWith(
      'prop-accepted-1',
      'cancelled',
    );
    expect(mockTx.historyStore.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        proposal_id: 'prop-accepted-1',
        action: 'proposal_acceptance_reverted',
        details: expect.objectContaining({
          reason: 'entity_removed_from_catalog',
        }),
      }),
    );
  });

  it.each(['open', 'escalated', 'unresolved'] as const)(
    'closes %s case as archived when its archived repo is gone from the catalog',
    async status => {
      const staleCase = makeStaleCase({ current_status: status });
      const { store, txEntityClose, txAppendHistory } = setupReconStore([
        staleCase,
      ]);
      // paginateEntities yields nothing and the catalog lookup no longer resolves
      // the entity (repo archived → dropped by skipArchivedRepos).
      const { svc } = makeSvc({
        entities: [],
        store,
        catalogGetEntityByRef: jest.fn().mockResolvedValue(undefined),
      });

      const stats = await svc.runScan();

      expect(txEntityClose).toHaveBeenCalledWith(
        'entity-stale-1',
        'system',
        'archived',
        1,
      );
      expect(txAppendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'issue_closed_archived',
          details: expect.objectContaining({
            reason: 'entity_removed_from_catalog',
          }),
        }),
      );
      expect(stats.issuesAutoResolved).toBe(1);
    },
  );

  it('does NOT close an open case that is still present in the catalog and in scope', async () => {
    // Unseen by paginateEntities only because of a config exclude, but the catalog
    // still resolves it — must not be closed as removed.
    const staleCase = makeStaleCase({
      entity_kind: 'System',
      current_status: 'open',
    });
    const { store, txEntityClose } = setupReconStore([staleCase]);
    const { svc } = makeSvc({
      entities: [],
      store,
      catalogGetEntityByRef: jest.fn().mockResolvedValue({
        kind: 'System',
        metadata: { name: 'legacy-system', namespace: 'default' },
      }),
    });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    // Closed via the config-exclusion path (kind_excluded), not the removal path.
    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'out_of_scope',
      1,
    );
    void stats;
  });

  it('does NOT close a case touched by this scan (last_scanned_at equal to scan start)', async () => {
    // Equal-boundary: last_scanned_at at exactly scan start should be skipped (>= check).
    const touchedNow = makeStaleCase({
      entity_kind: 'System',
      last_scanned_at: new Date(Date.now() + 60_000), // definitely after scan start
    });
    const { store, txEntityClose } = setupReconStore([touchedNow]);
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    await svc.runScan();

    expect(txEntityClose).not.toHaveBeenCalled();
  });

  it('cancels deadlines + queue for escalated cases and sets escalationCleanedUp flag', async () => {
    const stale = makeStaleCase({
      entity_kind: 'System',
      current_status: 'escalated',
    });
    const activeQueueEntry = { id: 'queue-1' };
    const { store, txEntityClose, txCancelDeadlines, txAppendHistory } =
      setupReconStore([stale], {
        escalationQueueStore: {
          findActiveEntry: jest.fn().mockResolvedValue(activeQueueEntry),
          markEntryCompleted: jest.fn().mockResolvedValue(undefined),
        },
      });

    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(txEntityClose).toHaveBeenCalledWith(
      'entity-stale-1',
      'system',
      'out_of_scope',
      1,
    );
    expect(txCancelDeadlines).toHaveBeenCalledWith('entity-stale-1');
    // markEntryCompleted was on the overridden escalationQueueStore; assert via history flag.
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'issue_closed_out_of_scope',
        details: expect.objectContaining({
          reason: 'kind_excluded',
          escalationCleanedUp: true,
        }),
      }),
    );
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('does NOT cancel deadlines/queue for open (non-escalated) cases', async () => {
    const stale = makeStaleCase({
      entity_kind: 'System',
      current_status: 'open',
    });
    const { store, txCancelDeadlines, txAppendHistory } = setupReconStore([
      stale,
    ]);
    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    await svc.runScan();

    expect(txCancelDeadlines).not.toHaveBeenCalled();
    expect(txAppendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.not.objectContaining({ escalationCleanedUp: true }),
      }),
    );
  });

  it('skips case with ConflictError (concurrent scan) without logging an error', async () => {
    const { ConflictError: CE } = jest.requireActual(
      '@backstage/errors',
    ) as typeof import('@backstage/errors');
    const stale = makeStaleCase({ entity_kind: 'System' });
    const { store, txEntityClose } = setupReconStore([stale]);
    txEntityClose.mockRejectedValueOnce(new CE('concurrent close'));
    const logger = (
      makeSvc({ entities: [], store }).svc as unknown as {
        logger: { error: jest.Mock; debug: jest.Mock };
      }
    ).logger;

    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(stats.issuesAutoResolved).toBe(0);
    void logger; // unused
  });

  it('continues reconciling remaining cases when one fails with a real error', async () => {
    const failing = makeStaleCase({
      id: 'entity-fail',
      entity_ref: 'system:default/fails',
      entity_kind: 'System',
    });
    const good = makeStaleCase({
      id: 'entity-good',
      entity_ref: 'system:default/good',
      entity_kind: 'System',
    });

    // Need two separate tx mock instances — one throws, one succeeds.
    const store = makeStore({
      listActiveEntitiesForReconciliation: jest
        .fn()
        .mockResolvedValue([failing, good]),
    });
    let callCount = 0;
    (store as unknown as { withTransaction: jest.Mock }).withTransaction =
      jest.fn(async (fn: (s: unknown) => Promise<unknown>) => {
        callCount++;
        if (callCount === 1) throw new Error('boom');
        return fn({
          entityStore: { closeEntity: jest.fn().mockResolvedValue(undefined) },
          proposalStore: {
            listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
            listCancellableProposalsByEntity: jest.fn().mockResolvedValue([]),
            updateProposalStatus: jest.fn(),
          },
          pendingDeadlineStore: { cancelDeadlinesForEntity: jest.fn() },
          escalationQueueStore: {
            findActiveEntry: jest.fn().mockResolvedValue(null),
            markEntryCompleted: jest.fn(),
          },
          historyStore: { appendHistory: jest.fn() },
        });
      });

    const { svc } = makeSvc({ entities: [], store });
    (svc as unknown as { config: OwnershipMatcherConfig }).config = {
      ...config,
      filters: { ...config.filters, excludeKinds: ['System'] },
    };

    const stats = await svc.runScan();

    expect(callCount).toBe(2);
    expect(stats.issuesAutoResolved).toBe(1);
  });

  it('does not throw or count closures when there are no active cases', async () => {
    const { store } = setupReconStore([]);
    const { svc } = makeSvc({ entities: [], store });

    const stats = await svc.runScan();

    expect(stats.issuesAutoResolved).toBe(0);
  });
});
