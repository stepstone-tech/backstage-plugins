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

import {
  CandidateSourcesUnavailableError,
  ProposalGenerationService,
} from './ProposalGenerationService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import {
  ProposalStrategy,
  ProposalStrategyContext,
  ProposalCandidate,
} from '../proposals/types';
import { FallbackStrategy } from '../proposals/FallbackStrategy';
import { mockServices } from '@backstage/backend-test-utils';
import { CatalogComponent } from '../types';
import { ProposalsConfig } from '../config/types';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

const entity: CatalogComponent = {
  kind: 'Component',
  metadata: { name: 'svc', namespace: 'default' },
  spec: {},
};

const config: ProposalsConfig = {
  maxCandidatesPerEntity: 5,
  autoExpiry: false,
  expirationDays: 14,
  minimumScoreThreshold: 0,
  // 0 here means every survivor is treated as an active proposal — the
  // dedicated "possible owner" describe block below raises it to exercise the
  // below-threshold split.
  notificationThreshold: 0,
  confidenceTiers: { high: 0.6, medium: 0.3 },
  strategies: [
    { name: 'top-contributor', weight: 0.5 },
    { name: 'org-proximity', weight: 0.3 },
  ],
};

type MakeStoreReturn = OwnershipStore & {
  writeDeadline: jest.Mock;
  cancelDeadlinesForEntity: jest.Mock;
};

function makeStore(overrides: Partial<OwnershipStore> = {}): MakeStoreReturn {
  const store: any = {
    createScan: jest.fn(),
    completeScan: jest.fn(),
    failScan: jest.fn(),
    failStaleScans: jest.fn().mockResolvedValue(0),
    getScan: jest.fn(),
    listScans: jest.fn(),
    createEntity: jest.fn(),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    closeEntity: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    getActiveEntityByRef: jest.fn(),
    listEntities: jest.fn(),
    getEntityById: jest.fn().mockResolvedValue({
      id: 'entity-1',
      current_status: 'open',
      version: 1,
    }),
    createProposal: jest.fn().mockResolvedValue('proposal-id'),
    deletePossibleOwnersByEntity: jest.fn().mockResolvedValue(0),
    getProposal: jest.fn(),
    listProposalsByEntity: jest.fn().mockResolvedValue([]),
    listActiveProposalsByEntity: jest.fn(),
    updateProposalStatus: jest.fn(),
    appendHistory: jest.fn(),
    listHistory: jest.fn(),
    getRejectedActors: jest.fn().mockResolvedValue(new Set()),
    ...overrides,
  };
  store.writeDeadline = jest.fn();
  store.cancelDeadlinesForEntity = jest.fn();
  store.withTransaction = jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
    cb({
      proposalStore: store,
      entityStore: store,
      historyStore: store,
      escalationQueueStore: store,
      pendingDeadlineStore: {
        writeDeadline: store.writeDeadline,
        cancelDeadlinesForEntity: store.cancelDeadlinesForEntity,
      },
    }),
  );
  return store as MakeStoreReturn;
}

function makeStrategy(
  name: string,
  candidates: ProposalCandidate[],
): ProposalStrategy {
  return {
    name,
    signalDefinitions: [],
    findCandidates: jest.fn().mockResolvedValue(candidates),
  };
}

const ALL_TEST_REFS = [
  'group:default/team-a',
  'group:default/team-b',
  'group:default/team-x',
  'group:default/a',
  'group:default/b',
  'group:default/c',
  'group:default/d',
  'group:default/platform',
];

function makeCatalogService(
  teamRefs: string[] = ALL_TEST_REFS,
): CatalogService {
  return {
    getTeamGroupRegistry: jest.fn().mockResolvedValue(new Set(teamRefs)),
  } as unknown as CatalogService;
}

describe('ProposalGenerationService', () => {
  const logger = mockServices.logger.mock();

  it('runs all strategies and merges candidates by ownerRef', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.3,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(s1.findCandidates).toHaveBeenCalled();
    expect(s2.findCandidates).toHaveBeenCalled();
    expect(store.createProposal).toHaveBeenCalledTimes(2);

    // totalWeight = 0.5 + 0.3 = 0.8
    // team-a: 0.8 * 0.5 = 0.40 → normalized 0.40/0.8 = 0.5
    // team-b: (0.3 * 0.5) + (0.6 * 0.3) = 0.15 + 0.18 = 0.33 → normalized 0.33/0.8 = 0.4125
    expect(store.createProposal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        proposed_owner_ref: 'group:default/team-a',
        proposal_order: 1,
        confidence_score: 0.5,
      }),
    );
    expect(store.createProposal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        proposed_owner_ref: 'group:default/team-b',
        proposal_order: 2,
        confidence_score: expect.closeTo(0.4125, 4),
        confidence_reason: JSON.stringify([
          'top_contributor',
          'org_proximity_system',
        ]),
      }),
    );
  });

  it('autoExpiry=false — no proposal_expiry deadline written', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.5,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const clock = {
      now: jest.fn().mockReturnValue(new Date('2026-01-01T00:00:00.000Z')),
    };
    const svc = new ProposalGenerationService(
      store,
      [s1],
      { ...config, autoExpiry: false },
      logger,
      makeCatalogService(),
      clock,
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.writeDeadline).not.toHaveBeenCalled();
  });

  it('autoExpiry=true — writes proposal_expiry deadline using expirationDays from config', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.5,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const fixedNow = new Date('2026-01-01T00:00:00.000Z');
    const clock = { now: jest.fn().mockReturnValue(fixedNow) };
    const svc = new ProposalGenerationService(
      store,
      [s1],
      { ...config, autoExpiry: true, expirationDays: 14 },
      logger,
      makeCatalogService(),
      clock,
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    // Broadcast: both above-threshold candidates are activated, so
    // each gets its own proposal_expiry deadline.
    expect(store.writeDeadline).toHaveBeenCalledTimes(2);
    expect(store.writeDeadline).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: 'entity-1',
        deadline_type: 'proposal_expiry',
        proposal_id: 'proposal-id',
        fire_at: new Date(fixedNow.getTime() + 14 * 24 * 60 * 60 * 1000),
      }),
    );
  });

  it('autoExpiry=true — custom expirationDays is respected', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const fixedNow = new Date('2026-01-01T00:00:00.000Z');
    const clock = { now: jest.fn().mockReturnValue(fixedNow) };
    const svc = new ProposalGenerationService(
      store,
      [s1],
      { ...config, autoExpiry: true, expirationDays: 30 },
      logger,
      makeCatalogService(),
      clock,
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.writeDeadline).toHaveBeenCalledWith(
      expect.objectContaining({
        deadline_type: 'proposal_expiry',
        fire_at: new Date(fixedNow.getTime() + 30 * 24 * 60 * 60 * 1000),
      }),
    );
  });

  it('sets assignee to top candidate after generating proposals', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.3,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    // team-a has highest score → should be the assignee
    expect(store.updateAssignee).toHaveBeenCalledWith(
      'entity-1',
      'group:default/team-a',
    );
  });

  it('normalizes scores to 0-1 range', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.6,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    // totalWeight = 0.5 + 0.3 = 0.8
    // (0.6 * 0.5) + (0.6 * 0.3) = 0.48 → normalized 0.48/0.8 = 0.6
    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence_score: 0.6,
      }),
    );
  });

  it('respects maxCandidatesPerEntity', async () => {
    const candidates: ProposalCandidate[] = [
      {
        ownerRef: 'group:default/a',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/b',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/c',
        confidenceScore: 0.7,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/d',
        confidenceScore: 0.6,
        confidenceReason: ['top_contributor'],
      },
    ];
    const s1 = makeStrategy('top-contributor', candidates);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1],
      { ...config, maxCandidatesPerEntity: 2 },
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.createProposal).toHaveBeenCalledTimes(2);
  });

  it('applies minimum score threshold but always keeps the top candidate', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/team-b',
        confidenceScore: 0.1,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const thresholdConfig = { ...config, minimumScoreThreshold: 0.5 };
    const svc = new ProposalGenerationService(
      store,
      [s1],
      thresholdConfig,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    // totalWeight = 0.5 + 0.3 = 0.8
    // team-a: 0.8*0.5=0.40 → normalized 0.5 (above 0.5 threshold)
    // team-b: 0.1*0.5=0.05 → normalized 0.0625 (below 0.5 threshold, dropped)
    expect(store.createProposal).toHaveBeenCalledTimes(1);
    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposed_owner_ref: 'group:default/team-a',
      }),
    );
  });

  it('keeps the top candidate even if all scores are below threshold', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.1,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const thresholdConfig = { ...config, minimumScoreThreshold: 0.9 };
    const svc = new ProposalGenerationService(
      store,
      [s1],
      thresholdConfig,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(store.createProposal).toHaveBeenCalledTimes(1);
  });

  it('passes rejectedActors from store to strategy context', async () => {
    const rejected = new Set(['group:default/team-x']);
    const store = makeStore({
      getRejectedActors: jest.fn().mockResolvedValue(rejected),
    });
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const svc = new ProposalGenerationService(
      store,
      [s1],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    const ctx: ProposalStrategyContext = (s1.findCandidates as jest.Mock).mock
      .calls[0][0];
    expect(ctx.rejectedActors).toBe(rejected);
  });

  it('returns false when no strategy returns candidates and fallback is escalated; the escalation side effects belong to the EscalationTrigger boundary, not PGS', async () => {
    const s1 = makeStrategy('top-contributor', []);
    const fallback = new FallbackStrategy('escalated');
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, fallback],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(false);
    // Status flip + history happen in EscalationTrigger.
    expect(store.setEntityEscalated).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'escalation_triggered' }),
    );
    expect(store.createProposal).not.toHaveBeenCalled();
  });

  it('persists FallbackStrategy fixed-owner when no other candidates exist', async () => {
    const s1 = makeStrategy('top-contributor', []);
    const fallback = new FallbackStrategy(
      'fixed-owner',
      'group:default/platform',
    );
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, fallback],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposed_owner_ref: 'group:default/platform',
      }),
    );
  });

  it('does not trigger fallback when regular strategies return candidates', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.1,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const fallback = new FallbackStrategy('escalated');
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, fallback],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(store.setEntityEscalated).not.toHaveBeenCalled();
  });

  it('logs proposal_created history for each created proposal', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'proposal_created' }),
    );
  });

  it('continues to next strategy when one throws', async () => {
    const s1 = makeStrategy('top-contributor', []);
    (s1.findCandidates as jest.Mock).mockRejectedValue(
      new Error('network error'),
    );
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(store.createProposal).toHaveBeenCalledTimes(1);
  });

  it('sets proposal_order sequentially starting from 1, sorted by score', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/c',
        confidenceScore: 0.3,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/a',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
      {
        ownerRef: 'group:default/b',
        confidenceScore: 0.6,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.createProposal).toHaveBeenCalledTimes(3);
    expect(store.createProposal).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        proposal_order: 1,
        proposed_owner_ref: 'group:default/a',
      }),
    );
    expect(store.createProposal).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        proposal_order: 2,
        proposed_owner_ref: 'group:default/b',
      }),
    );
    expect(store.createProposal).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        proposal_order: 3,
        proposed_owner_ref: 'group:default/c',
      }),
    );
  });

  it('uses default weight of 1.0 for strategies without configured weight', async () => {
    const configNoWeight: ProposalsConfig = {
      ...config,
      strategies: [{ name: 'custom-strategy' }],
    };
    const s1 = makeStrategy('custom-strategy', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.5,
        confidenceReason: ['custom'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1],
      configNoWeight,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    // totalWeight = 1.0 (default for the single unweighted strategy)
    // 0.5 * 1.0 = 0.5 → normalized 0.5/1.0 = 0.5
    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence_score: 0.5,
      }),
    );
  });

  it('stores confidence_reason as JSON array', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.8,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(),
    );

    await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence_reason: JSON.stringify([
          'top_contributor',
          'org_proximity_system',
        ]),
      }),
    );
  });

  it('returns false when all strategies return empty and no fallback configured; escalation side effects belong to EscalationTrigger', async () => {
    const s1 = makeStrategy('top-contributor', []);
    const s2 = makeStrategy('org-proximity', []);
    const store = makeStore();
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(false);
    // Status flip + history happen at the EscalationTrigger boundary.
    expect(store.setEntityEscalated).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'escalation_triggered' }),
    );
    expect(store.createProposal).not.toHaveBeenCalled();
    // Stale possible owners from an earlier scan are cleared, so the boundary
    // can't mistake them for this scan's result.
    expect(store.deletePossibleOwnersByEntity).toHaveBeenCalledWith('entity-1');
  });

  it('filters out non-team group candidates and does not propose them', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/chapter-frontend',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/team-a',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    // Only team-a is a team; chapter-frontend is not.
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(['group:default/team-a']),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(true);
    expect(store.createProposal).toHaveBeenCalledTimes(1);
    expect(store.createProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposed_owner_ref: 'group:default/team-a',
      }),
    );
  });

  it('returns false when all candidates across all strategies are non-team groups; escalation side effects belong to EscalationTrigger', async () => {
    const s1 = makeStrategy('top-contributor', [
      {
        ownerRef: 'group:default/chapter-frontend',
        confidenceScore: 0.9,
        confidenceReason: ['top_contributor'],
      },
    ]);
    const s2 = makeStrategy('org-proximity', [
      {
        ownerRef: 'group:default/domain-commerce',
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ]);
    const store = makeStore();
    // Registry loaded, but neither candidate is a team.
    const svc = new ProposalGenerationService(
      store,
      [s1, s2],
      config,
      logger,
      makeCatalogService(['group:default/team-a']),
    );

    const result = await svc.generateProposals(
      'entity-1',
      entity,
      'orphaned',
      undefined,
      undefined,
      'scan-1',
    );

    expect(result).toBe(false);
    // Status flip + history happen at the EscalationTrigger boundary.
    expect(store.setEntityEscalated).not.toHaveBeenCalled();
    expect(store.appendHistory).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'escalation_triggered' }),
    );
    expect(store.createProposal).not.toHaveBeenCalled();
  });

  // ── source failures must not read as "zero candidates" ───────────────────
  // A false return makes the caller escalate (→ unresolved +
  // no_candidates_found). A transient failure must throw instead so the case
  // keeps its status and the next scan retries.

  describe('candidate source failures', () => {
    const fixedOwnerFallback = () =>
      new FallbackStrategy('fixed-owner', 'group:default/platform');

    it('throws CandidateSourcesUnavailableError when a strategy failed and nothing survived', async () => {
      const s1 = makeStrategy('top-contributor', []);
      (s1.findCandidates as jest.Mock).mockRejectedValue(
        new Error('bitbucket timeout'),
      );
      const s2 = makeStrategy('org-proximity', []);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1, s2],
        config,
        logger,
        makeCatalogService(),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).rejects.toBeInstanceOf(CandidateSourcesUnavailableError);
      expect(store.createProposal).not.toHaveBeenCalled();
    });

    it('throws when the team registry is empty but strategies found candidates (catalog error)', async () => {
      const s1 = makeStrategy('top-contributor', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.9,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1],
        config,
        logger,
        makeCatalogService([]),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).rejects.toBeInstanceOf(CandidateSourcesUnavailableError);
    });

    it('does not fall back to a fixed owner when the real signals were unavailable', async () => {
      const s1 = makeStrategy('top-contributor', []);
      (s1.findCandidates as jest.Mock).mockRejectedValue(new Error('boom'));
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1, fixedOwnerFallback()],
        config,
        logger,
        makeCatalogService(),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).rejects.toBeInstanceOf(CandidateSourcesUnavailableError);
      expect(store.createProposal).not.toHaveBeenCalled();
    });

    it('still returns true on partial success (one strategy failed, another found a team)', async () => {
      const s1 = makeStrategy('top-contributor', []);
      (s1.findCandidates as jest.Mock).mockRejectedValue(new Error('boom'));
      const s2 = makeStrategy('org-proximity', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.6,
          confidenceReason: ['org_proximity_system'],
        },
      ]);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1, s2],
        config,
        logger,
        makeCatalogService(),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).resolves.toBe(true);
    });

    it('still returns false for a legitimate zero (strategies succeeded, empty registry irrelevant)', async () => {
      const s1 = makeStrategy('top-contributor', []);
      const s2 = makeStrategy('org-proximity', []);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1, s2],
        config,
        logger,
        makeCatalogService([]),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).resolves.toBe(false);
    });
  });

  // ── accumulator: persistProposals reports new IDs grouped by owner ────────

  describe('proposal accumulator', () => {
    it('appends one accumulator entry per created proposal with proposalId and ownerRef', async () => {
      const s1 = makeStrategy('top-contributor', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.9,
          confidenceReason: ['top_contributor'],
        },
        {
          ownerRef: 'group:default/team-b',
          confidenceScore: 0.6,
          confidenceReason: ['org_proximity_system'],
        },
      ]);
      const store = makeStore({
        createProposal: jest
          .fn()
          .mockResolvedValueOnce('proposal-id-a')
          .mockResolvedValueOnce('proposal-id-b'),
      });
      const svc = new ProposalGenerationService(
        store,
        [s1],
        config,
        logger,
        makeCatalogService(),
      );

      const accumulator: Array<{ proposalId: string; ownerRef: string }> = [];
      await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
        accumulator,
      );

      expect(accumulator).toEqual([
        { proposalId: 'proposal-id-a', ownerRef: 'group:default/team-a' },
        { proposalId: 'proposal-id-b', ownerRef: 'group:default/team-b' },
      ]);
    });

    it('leaves accumulator empty when no candidates survive dedup (unique constraint)', async () => {
      const s1 = makeStrategy('top-contributor', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.9,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore({
        createProposal: jest
          .fn()
          .mockRejectedValue(new Error('UNIQUE constraint failed')),
      });
      const svc = new ProposalGenerationService(
        store,
        [s1],
        config,
        logger,
        makeCatalogService(),
      );

      const accumulator: Array<{ proposalId: string; ownerRef: string }> = [];
      await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
        accumulator,
      );

      expect(accumulator).toEqual([]);
    });

    it('omitting accumulator is allowed (back-compat for retrigger path)', async () => {
      const s1 = makeStrategy('top-contributor', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.9,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1],
        config,
        logger,
        makeCatalogService(),
      );

      await expect(
        svc.generateProposals(
          'entity-1',
          entity,
          'orphaned',
          undefined,
          undefined,
          'scan-1',
        ),
      ).resolves.not.toThrow();
      expect(store.createProposal).toHaveBeenCalledTimes(1);
    });
  });

  // ── notificationThreshold: below-threshold candidates → possible_owner ─────

  describe('notificationThreshold (possible owners)', () => {
    // totalWeight = 0.5 + 0.3 = 0.8 for the shared `config`.
    const thresholdConfig: ProposalsConfig = {
      ...config,
      notificationThreshold: 0.4,
      autoExpiry: true,
    };

    it('stores below-threshold candidates as possible_owner without notifying', async () => {
      const s1 = makeStrategy('top-contributor', [
        // 0.8 * 0.5 = 0.40 → normalized 0.40/0.5 = 0.80 (>= 0.4, active)
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.8,
          confidenceReason: ['top_contributor'],
        },
        // 0.15 * 0.5 = 0.075 → normalized 0.075/0.5 = 0.15 (< 0.4, possible_owner)
        {
          ownerRef: 'group:default/team-b',
          confidenceScore: 0.15,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore({
        createProposal: jest
          .fn()
          .mockResolvedValueOnce('proposal-id-a')
          .mockResolvedValueOnce('proposal-id-b'),
      });
      const svc = new ProposalGenerationService(
        store,
        [s1],
        thresholdConfig,
        logger,
        makeCatalogService(),
      );

      const accumulator: Array<{ proposalId: string; ownerRef: string }> = [];
      const result = await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
        accumulator,
      );

      expect(result).toBe(true);
      expect(store.createProposal).toHaveBeenCalledTimes(2);
      // Active candidate persisted without explicit status (defaults to pending on activation).
      expect(store.createProposal).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          proposed_owner_ref: 'group:default/team-a',
          proposal_order: 1,
        }),
      );
      // Below-threshold candidate persisted as possible_owner.
      expect(store.createProposal).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          proposed_owner_ref: 'group:default/team-b',
          proposal_order: 2,
          status: 'possible_owner',
        }),
      );
      // The single active proposal is activated (pending) — possible owner is not.
      expect(store.updateProposalStatus).toHaveBeenCalledTimes(1);
      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-id-a',
        'pending',
        expect.objectContaining({ notifiedAt: expect.any(Date) }),
      );
      // Only the active proposal feeds the notification accumulator.
      expect(accumulator).toEqual([
        { proposalId: 'proposal-id-a', ownerRef: 'group:default/team-a' },
      ]);
      // No expiry deadline for possible owners — exactly one (for the active one).
      expect(store.writeDeadline).toHaveBeenCalledTimes(1);
    });

    it('broadcast: activates ALL above-threshold candidates simultaneously', async () => {
      const s1 = makeStrategy('top-contributor', [
        // 0.9 * 0.5 = 0.45 → normalized 0.45/0.5 = 0.90 (>= 0.4, active)
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.9,
          confidenceReason: ['top_contributor'],
        },
        // 0.8 * 0.5 = 0.40 → normalized 0.40/0.5 = 0.80 (>= 0.4, active)
        {
          ownerRef: 'group:default/team-b',
          confidenceScore: 0.8,
          confidenceReason: ['top_contributor'],
        },
        // 0.5 * 0.5 = 0.25 → normalized 0.25/0.5 = 0.50 (>= 0.4, active)
        {
          ownerRef: 'group:default/team-x',
          confidenceScore: 0.5,
          confidenceReason: ['top_contributor'],
        },
        // 0.1 * 0.5 = 0.05 → normalized 0.05/0.5 = 0.10 (< 0.4, possible_owner)
        {
          ownerRef: 'group:default/d',
          confidenceScore: 0.1,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore({
        createProposal: jest
          .fn()
          .mockResolvedValueOnce('proposal-id-a')
          .mockResolvedValueOnce('proposal-id-b')
          .mockResolvedValueOnce('proposal-id-x')
          .mockResolvedValueOnce('proposal-id-d'),
      });
      const svc = new ProposalGenerationService(
        store,
        [s1],
        thresholdConfig,
        logger,
        makeCatalogService(),
      );

      const accumulator: Array<{ proposalId: string; ownerRef: string }> = [];
      const result = await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
        accumulator,
      );

      expect(result).toBe(true);
      expect(store.createProposal).toHaveBeenCalledTimes(4);

      // All three active candidates are flipped to pending + notified.
      expect(store.updateProposalStatus).toHaveBeenCalledTimes(3);
      for (const id of ['proposal-id-a', 'proposal-id-b', 'proposal-id-x']) {
        expect(store.updateProposalStatus).toHaveBeenCalledWith(
          id,
          'pending',
          expect.objectContaining({ notifiedAt: expect.any(Date) }),
        );
      }

      // Each active proposal gets its own expiry deadline.
      expect(store.writeDeadline).toHaveBeenCalledTimes(3);

      // Each active proposal feeds the notification accumulator; possible owner does not.
      expect(accumulator).toEqual([
        { proposalId: 'proposal-id-a', ownerRef: 'group:default/team-a' },
        { proposalId: 'proposal-id-b', ownerRef: 'group:default/team-b' },
        { proposalId: 'proposal-id-x', ownerRef: 'group:default/team-x' },
      ]);
    });

    it('stores every candidate as possible_owner and creates no active proposal when all are below threshold (strict)', async () => {
      const s1 = makeStrategy('top-contributor', [
        // 0.3 * 0.5 = 0.15 → normalized 0.15/0.5 = 0.30 (< 0.4, possible_owner)
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.3,
          confidenceReason: ['top_contributor'],
        },
        // 0.1 * 0.5 = 0.05 → normalized 0.05/0.5 = 0.10 (< 0.4, possible_owner)
        {
          ownerRef: 'group:default/team-b',
          confidenceScore: 0.1,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore({
        createProposal: jest
          .fn()
          .mockResolvedValueOnce('proposal-id-a')
          .mockResolvedValueOnce('proposal-id-b'),
      });
      const svc = new ProposalGenerationService(
        store,
        [s1],
        thresholdConfig,
        logger,
        makeCatalogService(),
      );

      const accumulator: Array<{ proposalId: string; ownerRef: string }> = [];
      const result = await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
        accumulator,
      );

      // No one to act → false, so the caller escalates the case to unresolved.
      expect(result).toBe(false);
      expect(store.createProposal).toHaveBeenCalledTimes(2);
      expect(store.createProposal).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          proposed_owner_ref: 'group:default/team-a',
          status: 'possible_owner',
        }),
      );
      expect(store.createProposal).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          proposed_owner_ref: 'group:default/team-b',
          status: 'possible_owner',
        }),
      );
      // No active proposal → no pending promotion, no notification, no deadline,
      // and no assignee is set.
      expect(store.updateProposalStatus).not.toHaveBeenCalled();
      expect(store.writeDeadline).not.toHaveBeenCalled();
      expect(store.updateAssignee).not.toHaveBeenCalled();
      expect(accumulator).toEqual([]);
    });

    it('clears stale possible_owner rows before regenerating (no duplicates on re-scan)', async () => {
      const s1 = makeStrategy('top-contributor', [
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.5,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1],
        thresholdConfig,
        logger,
        makeCatalogService(),
      );

      await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
      );

      expect(store.deletePossibleOwnersByEntity).toHaveBeenCalledWith(
        'entity-1',
      );
    });

    describe('history on re-scan', () => {
      const proposalCreatedOwners = (store: MakeStoreReturn) =>
        (store.appendHistory as jest.Mock).mock.calls
          .map(([h]) => h)
          .filter(h => h.action === 'proposal_created')
          .map(h => h.details.ownerRef);

      const existingPossibleOwners = (...refs: string[]) =>
        jest.fn().mockResolvedValue(
          refs.map((ref, i) => ({
            id: `old-${i}`,
            proposed_owner_ref: ref,
            status: 'possible_owner',
          })),
        );

      it('does not log proposal_created for possible owners that were already possible owners', async () => {
        const s1 = makeStrategy('top-contributor', [
          {
            ownerRef: 'group:default/team-a',
            confidenceScore: 0.3,
            confidenceReason: ['top_contributor'],
          },
          {
            ownerRef: 'group:default/team-b',
            confidenceScore: 0.1,
            confidenceReason: ['top_contributor'],
          },
        ]);
        const store = makeStore({
          listProposalsByEntity: existingPossibleOwners(
            'group:default/team-a',
            'group:default/team-b',
          ),
        });
        const svc = new ProposalGenerationService(
          store,
          [s1],
          thresholdConfig,
          logger,
          makeCatalogService(),
        );

        await svc.generateProposals(
          'entity-1',
          entity,
          'zombie',
          undefined,
          undefined,
          'scan-2',
        );

        // Rows are still refreshed so scores stay current.
        expect(store.deletePossibleOwnersByEntity).toHaveBeenCalledWith(
          'entity-1',
        );
        expect(store.createProposal).toHaveBeenCalledTimes(2);
        expect(proposalCreatedOwners(store)).toEqual([]);
      });

      it('logs proposal_created only for newly appearing possible owners', async () => {
        const s1 = makeStrategy('top-contributor', [
          {
            ownerRef: 'group:default/team-a',
            confidenceScore: 0.3,
            confidenceReason: ['top_contributor'],
          },
          {
            ownerRef: 'group:default/team-b',
            confidenceScore: 0.1,
            confidenceReason: ['top_contributor'],
          },
        ]);
        const store = makeStore({
          listProposalsByEntity: existingPossibleOwners('group:default/team-a'),
        });
        const svc = new ProposalGenerationService(
          store,
          [s1],
          thresholdConfig,
          logger,
          makeCatalogService(),
        );

        await svc.generateProposals(
          'entity-1',
          entity,
          'zombie',
          undefined,
          undefined,
          'scan-2',
        );

        expect(proposalCreatedOwners(store)).toEqual(['group:default/team-b']);
      });

      it('logs proposal_created when a previous possible owner is promoted to an active proposal', async () => {
        const s1 = makeStrategy('top-contributor', [
          {
            ownerRef: 'group:default/team-a',
            confidenceScore: 0.8,
            confidenceReason: ['top_contributor'],
          },
        ]);
        const store = makeStore({
          createProposal: jest.fn().mockResolvedValue('proposal-id-a'),
          listProposalsByEntity: existingPossibleOwners('group:default/team-a'),
        });
        const svc = new ProposalGenerationService(
          store,
          [s1],
          thresholdConfig,
          logger,
          makeCatalogService(),
        );

        await svc.generateProposals(
          'entity-1',
          entity,
          'zombie',
          undefined,
          undefined,
          'scan-2',
        );

        expect(store.updateProposalStatus).toHaveBeenCalledWith(
          'proposal-id-a',
          'pending',
          expect.objectContaining({ notifiedAt: expect.any(Date) }),
        );
        expect(proposalCreatedOwners(store)).toEqual(['group:default/team-a']);
      });

      it('ignores non-possible_owner rows when deciding what is new', async () => {
        const s1 = makeStrategy('top-contributor', [
          {
            ownerRef: 'group:default/team-a',
            confidenceScore: 0.3,
            confidenceReason: ['top_contributor'],
          },
        ]);
        const store = makeStore({
          listProposalsByEntity: jest.fn().mockResolvedValue([
            {
              id: 'old-0',
              proposed_owner_ref: 'group:default/team-a',
              status: 'expired',
            },
          ]),
        });
        const svc = new ProposalGenerationService(
          store,
          [s1],
          thresholdConfig,
          logger,
          makeCatalogService(),
        );

        await svc.generateProposals(
          'entity-1',
          entity,
          'zombie',
          undefined,
          undefined,
          'scan-2',
        );

        expect(proposalCreatedOwners(store)).toEqual(['group:default/team-a']);
      });
    });

    it('still drops candidates below minimumScoreThreshold before the notification split', async () => {
      const s1 = makeStrategy('top-contributor', [
        // 0.8 * 0.5 = 0.40 → normalized 0.50 (kept)
        {
          ownerRef: 'group:default/team-a',
          confidenceScore: 0.8,
          confidenceReason: ['top_contributor'],
        },
        // 0.1 * 0.5 = 0.05 → normalized 0.0625 (< minimumScoreThreshold 0.2, dropped)
        {
          ownerRef: 'group:default/team-b',
          confidenceScore: 0.1,
          confidenceReason: ['top_contributor'],
        },
      ]);
      const store = makeStore();
      const svc = new ProposalGenerationService(
        store,
        [s1],
        { ...thresholdConfig, minimumScoreThreshold: 0.2 },
        logger,
        makeCatalogService(),
      );

      await svc.generateProposals(
        'entity-1',
        entity,
        'orphaned',
        undefined,
        undefined,
        'scan-1',
      );

      // team-b is dropped by the floor and never persisted (not even as possible_owner).
      expect(store.createProposal).toHaveBeenCalledTimes(1);
      expect(store.createProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          proposed_owner_ref: 'group:default/team-a',
        }),
      );
    });
  });
});
