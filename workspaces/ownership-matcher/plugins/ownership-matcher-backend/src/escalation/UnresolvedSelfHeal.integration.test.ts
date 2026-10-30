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
 * Integration tests for unresolved self-heal: an `unresolved` case must not stay locked
 * after a transient zero-candidate scan.
 *
 * - A failing candidate source no longer escalates the case (it stays `open`).
 * - A scan that finds only possible owners (never notified) leaves the case
 *   `unresolved` — nobody would act on it otherwise.
 * - A later scan that produces a notified (`pending`) proposal reopens an
 *   `unresolved` case, whatever the unresolved reason, with a self-explanatory
 *   `reopened_candidates_found` history row.
 *
 * Uses POSTGRES_16 — the partial UNIQUE on `escalation_queue_entries`
 * requires Postgres semantics that SQLite cannot reproduce.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { randomUUID } from 'crypto';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { DefaultEscalationService } from './EscalationService';
import { createStandardOrgHierarchy } from './__fixtures__/createMockCatalog';
import { buildValidEscalationConfig } from './__fixtures__/buildEscalationConfig';
import { TestClock } from './__fixtures__/Clock';
import {
  seedDeadlineRow,
  seedEntityRow,
  seedProposalRow,
  seedQueueEntry,
} from './__fixtures__/seedEntity';
import { EntityProcessingService } from '../service/EntityProcessingService';
import { ProposalGenerationService } from '../service/ProposalGenerationService';
import { ProposalStrategy } from '../proposals/types';
import { ProposalsConfig } from '../config/types';
import { ScmRegistry } from '../scm';
import { OwnershipCheck, OwnershipCheckContext } from '../checks';
import { CatalogComponent } from '../types';
import { ScanStats } from '../service/OwnershipMatcherService';

const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

const TEAM = 'group:default/team-a';

const proposalsConfig: ProposalsConfig = {
  maxCandidatesPerEntity: 5,
  autoExpiry: false,
  expirationDays: 14,
  minimumScoreThreshold: 0,
  // 0.3 → the 0.12 candidate below is stored as possible_owner (never
  // notified); the 0.5 one becomes a pending proposal.
  notificationThreshold: 0.3,
  confidenceTiers: { high: 0.6, medium: 0.3 },
  strategies: [{ name: 'top-contributor', weight: 1 }],
};

const orphanedCheck: OwnershipCheck = {
  name: 'orphaned',
  title: 'Orphaned',
  description: 'no owner',
  run: (_ctx: OwnershipCheckContext) => ({
    failed: true,
    checkName: 'orphaned',
    details: {},
  }),
};

const emptyStats = (): ScanStats => ({
  newIssuesFound: 0,
  existingIssuesUpdated: 0,
  issuesAutoResolved: 0,
  totalScanned: 0,
});

async function setup() {
  const knex = await databases.init('POSTGRES_16');
  const store = await DatabaseOwnershipStore.create({
    database: {
      getClient: async () => knex,
      migrations: { skip: false },
    } as any,
  });
  const logger = mockServices.logger.mock();

  const strategy: ProposalStrategy & { findCandidates: jest.Mock } = {
    name: 'top-contributor',
    signalDefinitions: [],
    findCandidates: jest.fn(),
  };
  const teamRegistry = jest.fn().mockResolvedValue(new Set([TEAM]));
  const pgs = new ProposalGenerationService(
    store,
    [strategy],
    proposalsConfig,
    logger,
    { getTeamGroupRegistry: teamRegistry } as unknown as CatalogService,
  );

  const escalation = new DefaultEscalationService(
    store,
    createStandardOrgHierarchy(),
    buildValidEscalationConfig(),
    new TestClock(),
    { runScan: jest.fn(), scanEntity: jest.fn() } as any,
    pgs,
    logger,
  );

  const eps = new EntityProcessingService(
    {
      repoFor: jest.fn().mockResolvedValue(undefined),
    } as unknown as ScmRegistry,
    pgs,
    store,
    [orphanedCheck],
    new Set(['orphaned']),
    logger,
    undefined,
    escalation,
    { getEntityByRef: jest.fn() } as unknown as CatalogService,
  );

  async function scan(entityName: string) {
    const scanId = randomUUID();
    await knex('ownership_scans').insert({ id: scanId });
    const entity: CatalogComponent = {
      kind: 'Component',
      metadata: { name: entityName, namespace: 'default' },
      spec: {},
    };
    await eps.processEntity(
      entity,
      {} as OwnershipCheckContext,
      scanId,
      emptyStats(),
    );
    return scanId;
  }

  return { knex, store, strategy, teamRegistry, scan, escalation };
}

const lowConfidence = [
  {
    ownerRef: TEAM,
    confidenceScore: 0.12,
    confidenceReason: ['top_contributor'],
  },
];

const highConfidence = [
  {
    ownerRef: TEAM,
    confidenceScore: 0.5,
    confidenceReason: ['top_contributor'],
  },
];

async function statusOf(knex: any, id: string): Promise<string> {
  return (await knex('ownership_entities').where({ id }).first())
    .current_status;
}

async function reopenRows(knex: any, id: string) {
  const rows = await knex('ownership_history').where({
    entity_id: id,
    action: 'reopened_candidates_found',
  });
  return rows.map((r: any) => ({
    ...r,
    details: typeof r.details === 'string' ? JSON.parse(r.details) : r.details,
  }));
}

describe('unresolved self-heal', () => {
  it('a failing candidate source does not escalate a new case to unresolved', async () => {
    const { knex, strategy, scan } = await setup();
    strategy.findCandidates.mockRejectedValue(new Error('bitbucket timeout'));

    await expect(scan('svc-transient')).rejects.toThrow(
      /Candidate sources unavailable/,
    );

    const row = await knex('ownership_entities')
      .where({ entity_ref: 'component:default/svc-transient' })
      .first();
    expect(row.current_status).toBe('open');
    const noCandidates = await knex('ownership_history').where({
      entity_id: row.id,
      action: 'no_candidates_found',
    });
    expect(noCandidates).toHaveLength(0);

    // Next scan succeeds → pending proposal stored, still open.
    strategy.findCandidates.mockResolvedValue(highConfidence);
    await scan('svc-transient');
    expect(await statusOf(knex, row.id)).toBe('open');
  });

  it('an empty team registry (catalog error) does not escalate', async () => {
    const { knex, strategy, teamRegistry, scan } = await setup();
    strategy.findCandidates.mockResolvedValue(lowConfidence);
    teamRegistry.mockResolvedValueOnce(new Set());

    await expect(scan('svc-registry')).rejects.toThrow(/team registry empty/);

    const row = await knex('ownership_entities')
      .where({ entity_ref: 'component:default/svc-registry' })
      .first();
    expect(row.current_status).toBe('open');
  });

  it('a new case with only possible owners goes unresolved, keeping them claimable', async () => {
    const { knex, strategy, scan } = await setup();
    strategy.findCandidates.mockResolvedValue(lowConfidence);

    await scan('svc-low');

    const row = await knex('ownership_entities')
      .where({ entity_ref: 'component:default/svc-low' })
      .first();
    expect(row.current_status).toBe('unresolved');
    expect(row.assigned_to).toBeNull();
    const proposals = await knex('ownership_proposals').where({
      entity_id: row.id,
    });
    expect(proposals).toEqual([
      expect.objectContaining({
        proposed_owner_ref: TEAM,
        status: 'possible_owner',
      }),
    ]);
    const history = await knex('ownership_history')
      .where({ entity_id: row.id, action: 'no_candidates_found' })
      .first();
    const details =
      typeof history.details === 'string'
        ? JSON.parse(history.details)
        : history.details;
    expect(details).toEqual({ reason: 'only_possible_owners' });

    // Rescans that still find only possible owners keep it unresolved.
    await scan('svc-low');
    expect(await statusOf(knex, row.id)).toBe('unresolved');
    expect(await reopenRows(knex, row.id)).toHaveLength(0);
  });

  it('a no_candidates_found blip is healed by the next scan that finds a notified candidate', async () => {
    const { knex, strategy, scan } = await setup();

    // Day 1: legitimate zero → unresolved via no_candidates_found.
    strategy.findCandidates.mockResolvedValue([]);
    await scan('svc-blip');
    const row = await knex('ownership_entities')
      .where({ entity_ref: 'component:default/svc-blip' })
      .first();
    expect(row.current_status).toBe('unresolved');

    // Day 2: the candidate is back, but only at low confidence → still unresolved.
    strategy.findCandidates.mockResolvedValue(lowConfidence);
    await scan('svc-blip');
    expect(await statusOf(knex, row.id)).toBe('unresolved');
    expect(await reopenRows(knex, row.id)).toHaveLength(0);

    // Day 3: the candidate clears the notification threshold.
    strategy.findCandidates.mockResolvedValue(highConfidence);
    const scanId = await scan('svc-blip');

    expect(await statusOf(knex, row.id)).toBe('open');
    const reopened = await reopenRows(knex, row.id);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].scan_id).toBe(scanId);
    expect(reopened[0].actor).toBe('system');
    expect(reopened[0].details).toMatchObject({
      entityRef: 'component:default/svc-blip',
      previousReason: 'no_candidates_found',
      previousReasonDetail: 'no_proposals_generated',
      candidates: [{ ownerRef: TEAM, score: 0.5, status: 'pending' }],
    });
    expect(typeof reopened[0].details.previousReasonAt).toBe('string');

    // Day 4: steady state — no further reopen rows.
    await scan('svc-blip');
    expect(await reopenRows(knex, row.id)).toHaveLength(1);
    expect(await statusOf(knex, row.id)).toBe('open');
  });

  it('reopens an escalation_exhausted case and clears escalation leftovers', async () => {
    const { knex, strategy, scan, escalation } = await setup();
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc-exhausted',
      current_status: 'unresolved',
    });
    await seedProposalRow(knex, entity.id, {
      proposed_owner_ref: 'group:default/team-b',
      status: 'rejected',
      proposal_order: 1,
    });
    await seedQueueEntry(knex, entity.id, {
      group_ref: 'group:default/domain-search',
      escalation_level: 1,
      position: 1,
      status: 'active',
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'escalation_timeout',
    });
    await knex('ownership_history').insert({
      entity_id: entity.id,
      action: 'escalation_exhausted',
      actor: 'system',
      details: JSON.stringify({ reason: 'all_escalation_paths' }),
    });

    strategy.findCandidates.mockResolvedValue(highConfidence);
    await scan('svc-exhausted');

    expect(await statusOf(knex, entity.id)).toBe('open');
    const [reopened] = await reopenRows(knex, entity.id);
    expect(reopened.details).toMatchObject({
      previousReason: 'escalation_exhausted',
      previousReasonDetail: 'all_escalation_paths',
      candidates: [{ ownerRef: TEAM, score: 0.5, status: 'pending' }],
    });

    const activeQueue = await knex('escalation_queue_entries').where({
      entity_id: entity.id,
      status: 'active',
    });
    expect(activeQueue).toHaveLength(0);
    const liveDeadlines = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    expect(liveDeadlines).toHaveLength(0);

    // Re-escalation after the reopen (once the new proposal is rejected)
    // rebuilds the BFS queue cleanly over the completed rows (no
    // partial-unique collision).
    await knex('ownership_proposals')
      .where({ entity_id: entity.id, status: 'pending' })
      .update({ status: 'rejected' });
    await expect(
      escalation.triggerEscalation(entity.id),
    ).resolves.toBeUndefined();
    expect(await statusOf(knex, entity.id)).toBe('escalated');
  });

  it('reopens a no_candidates_after_retrigger case', async () => {
    const { knex, strategy, scan } = await setup();
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc-retriggered',
      current_status: 'unresolved',
    });
    await knex('ownership_history').insert({
      entity_id: entity.id,
      action: 'no_candidates_after_retrigger',
      actor: 'system',
      details: JSON.stringify({ reason: 'no_candidates_after_retrigger' }),
    });

    strategy.findCandidates.mockResolvedValue(highConfidence);
    await scan('svc-retriggered');

    expect(await statusOf(knex, entity.id)).toBe('open');
    const [reopened] = await reopenRows(knex, entity.id);
    expect(reopened.details.previousReason).toBe(
      'no_candidates_after_retrigger',
    );
  });

  it('leaves an unresolved case alone while the scan still finds nothing', async () => {
    const { knex, strategy, scan } = await setup();
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc-still-empty',
      current_status: 'unresolved',
    });
    await knex('ownership_history').insert({
      entity_id: entity.id,
      action: 'no_candidates_found',
      actor: 'system',
      details: JSON.stringify({ reason: 'no_proposals_generated' }),
    });

    strategy.findCandidates.mockResolvedValue([]);
    await scan('svc-still-empty');

    expect(await statusOf(knex, entity.id)).toBe('unresolved');
    expect(await reopenRows(knex, entity.id)).toHaveLength(0);
  });
});
