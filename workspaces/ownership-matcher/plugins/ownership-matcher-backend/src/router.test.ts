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
  mockCredentials,
  mockErrorHandler,
  mockServices,
} from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { createRouter } from './router';
import { OwnershipStore } from './service/DatabaseOwnershipStore';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';
import { OwnershipMatcherService } from './service/OwnershipMatcherService';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { NotFoundError, ConflictError } from '@backstage/errors';

const mockEscalationConfig = {
  levels: [
    {
      groupFilter: 'Group:domain',
      timeoutDays: 7,
      titlePatterns: ['^Director'],
    },
    {
      groupFilter: 'Group:portfolio',
      timeoutDays: 14,
      titlePatterns: ['^VP'],
    },
  ],
};

// Stub trigger — every reject path that drains its proposals invokes this.
// Tests in this file mock at the lifecycle layer, so we only need the boundary
// to be callable; behavior is asserted in EscalationTrigger.test.ts and the
// integration suites.
const mockEscalationTrigger = {
  triggerEscalation: jest.fn().mockResolvedValue(undefined),
};

// ─── Entities ─────────────────────────────────────────────────────────────────

describe('GET /entities', () => {
  const mockStore = {
    listEntities: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      limit: 50,
    }),
    getEntityById: jest.fn(),
    listProposalsByEntity: jest.fn().mockResolvedValue([]),
    listHistory: jest.fn().mockResolvedValue([]),
    listScans: jest.fn().mockResolvedValue([]),
    getScan: jest.fn(),
    createScan: jest.fn(),
    completeScan: jest.fn(),
    createEntity: jest.fn(),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    getActiveEntityByRef: jest.fn(),
    createProposal: jest.fn(),
    getProposal: jest.fn(),
    listActiveProposalsByEntity: jest.fn(),
    updateProposalStatus: jest.fn(),
    appendHistory: jest.fn(),
    getRejectedActors: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;

  const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  let app: express.Express;

  beforeEach(async () => {
    jest.clearAllMocks();
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
    });
    app = express().use(router).use(mockErrorHandler());
  });

  it('returns paginated entity list', async () => {
    const response = await request(app).get('/entities');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ items: [], total: 0 });
    expect(mockStore.listEntities).toHaveBeenCalledWith(
      {},
      { page: 1, limit: 50 },
    );
  });

  it('forwards status filter to store', async () => {
    await request(app).get('/entities?status=open&kind=Component');
    expect(mockStore.listEntities).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['open'], kind: 'Component' }),
      expect.anything(),
    );
  });

  it('returns entity detail with proposals and history', async () => {
    const mockEntity = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
    };
    mockStore.getEntityById.mockResolvedValue(mockEntity as any);
    mockStore.listProposalsByEntity.mockResolvedValue([]);
    mockStore.listHistory.mockResolvedValue([]);

    const response = await request(app).get('/entities/entity-1');
    expect(response.status).toBe(200);
    expect(response.body.entity.id).toBe('entity-1');
  });

  it('returns 404 for unknown entity', async () => {
    mockStore.getEntityById.mockResolvedValue(undefined);
    const response = await request(app).get('/entities/unknown');
    expect(response.status).toBe(404);
  });

  it('forwards check filter to store', async () => {
    await request(app).get('/entities?check=orphaned');
    expect(mockStore.listEntities).toHaveBeenCalledWith(
      expect.objectContaining({ check: 'orphaned' }),
      expect.anything(),
    );
  });

  // 2.4.1 — GET /entities/:id/proposals returns proposals list
  it('returns proposals list for a specific entity', async () => {
    const mockEntity = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
    };
    mockStore.getEntityById.mockResolvedValue(mockEntity as any);
    mockStore.listProposalsByEntity.mockResolvedValue([
      {
        id: 'p-1',
        proposed_owner_ref: 'group:default/team-a',
        status: 'pending',
      },
    ] as any);

    const response = await request(app).get('/entities/entity-1/proposals');
    expect(response.status).toBe(200);
    expect(response.body.proposals).toHaveLength(1);
    expect(response.body.proposals[0].id).toBe('p-1');
  });

  // Endpoint returns both active proposals and possible owners,
  // distinguished by status, so the frontend can render each group.
  it('returns both active proposals and possible owners with distinguishing status', async () => {
    const mockEntity = {
      id: 'entity-1',
      entity_ref: 'component:default/svc',
      current_status: 'open',
    };
    mockStore.getEntityById.mockResolvedValue(mockEntity as any);
    mockStore.listProposalsByEntity.mockResolvedValue([
      {
        id: 'p-1',
        proposed_owner_ref: 'group:default/team-a',
        status: 'pending',
      },
      {
        id: 'p-2',
        proposed_owner_ref: 'group:default/team-b',
        status: 'possible_owner',
      },
    ] as any);

    const response = await request(app).get('/entities/entity-1/proposals');
    expect(response.status).toBe(200);
    expect(response.body.proposals).toHaveLength(2);
    expect(response.body.proposals.map((p: any) => p.status)).toEqual([
      'pending',
      'possible_owner',
    ]);
  });

  // 2.4.1 continued — 404 for unknown entity on proposals endpoint
  it('returns 404 for proposals of unknown entity', async () => {
    mockStore.getEntityById.mockResolvedValue(undefined);
    const response = await request(app).get('/entities/unknown/proposals');
    expect(response.status).toBe(404);
  });
});

// ─── Proposals ────────────────────────────────────────────────────────────────

describe('GET /proposals (admin)', () => {
  const mockStore = {
    listEntities: jest.fn(),
    getEntityById: jest.fn(),
    listProposalsByEntity: jest.fn(),
    listAllProposals: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
    listHistory: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;

  const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  let app: express.Express;

  beforeEach(async () => {
    jest.clearAllMocks();
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
    });
    app = express().use(router).use(mockErrorHandler());
  });

  it('accepts possible_owner as a valid status filter', async () => {
    const response = await request(app).get('/proposals?status=possible_owner');
    expect(response.status).toBe(200);
    expect(mockStore.listAllProposals).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: ['possible_owner'] }),
    );
  });

  it('returns 400 for an unknown status value', async () => {
    const response = await request(app).get('/proposals?status=bogus');
    expect(response.status).toBe(400);
  });
});

describe('POST /proposals/:id/accept', () => {
  let app: express.Express;
  const mockStore = {
    listEntities: jest.fn(),
    getEntityById: jest.fn(),
    getProposal: jest.fn().mockResolvedValue({
      id: 'p-1',
      proposed_owner_ref: 'group:default/team-a',
      status: 'pending',
    }),
    listProposalsByEntity: jest.fn(),
    // Reject path queries remaining proposals to decide whether to escalate;
    // default to one remaining so the trigger does NOT fire in the unit tests
    // (escalation behavior is asserted in EscalationTrigger.test.ts).
    listActiveProposalsByEntity: jest.fn().mockResolvedValue([{ id: 'p-2' }]),
    listHistory: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;

  const mockLifecycle = {
    acceptProposal: jest.fn().mockResolvedValue({
      proposal: { id: 'p-1', status: 'accepted' },
      entity: { id: 'e-1', current_status: 'accepted', version: 1 },
    }),
    rejectProposal: jest.fn().mockResolvedValue({
      proposal: { id: 'p-1', status: 'rejected' },
      entity: { id: 'e-1', current_status: 'open', version: 1 },
    }),
  } as unknown as jest.Mocked<ProposalLifecycleService>;

  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
    });
    app = express().use(router).use(mockErrorHandler());
  });

  it('accepts a proposal and returns status=accepted', async () => {
    const response = await request(app).post('/proposals/p-1/accept').send();
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('accepted');
    expect(mockLifecycle.acceptProposal).toHaveBeenCalledWith(
      'p-1',
      mockCredentials.user().principal.userEntityRef,
    );
  });

  it('rejects accept body with extra fields', async () => {
    const response = await request(app)
      .post('/proposals/p-1/accept')
      .send({ note: 'Confirmed with team lead' });
    expect(response.status).toBe(400);
  });

  it('rejects with 401 when unauthenticated', async () => {
    const response = await request(app)
      .post('/proposals/p-1/accept')
      .set('Authorization', mockCredentials.none.header())
      .send();
    expect(response.status).toBe(401);
  });

  it('rejects proposal-level reject without reason', async () => {
    const response = await request(app).post('/proposals/p-1/reject').send({});
    expect(response.status).toBe(400);
  });

  it('rejects proposal-level reject with empty reason', async () => {
    const response = await request(app)
      .post('/proposals/p-1/reject')
      .send({ reason: '' });
    expect(response.status).toBe(400);
  });

  it('rejects a proposal with reason', async () => {
    const response = await request(app)
      .post('/proposals/p-1/reject')
      .send({ reason: 'not our team' });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
    expect(mockLifecycle.rejectProposal).toHaveBeenCalledWith(
      'p-1',
      expect.any(String),
      'not our team',
    );
  });

  it('returns 404 when lifecycle throws NotFoundError', async () => {
    mockLifecycle.acceptProposal.mockRejectedValue(
      new NotFoundError('Proposal not found'),
    );
    const response = await request(app).post('/proposals/p-2/accept').send();
    expect(response.status).toBe(404);
  });

  it('returns 409 when proposal already responded', async () => {
    mockLifecycle.acceptProposal.mockRejectedValue(
      new ConflictError('already accepted'),
    );
    const response = await request(app).post('/proposals/p-2/accept').send();
    expect(response.status).toBe(409);
  });
});

// ─── Escalation ───────────────────────────────────────────────────────────────
// Only covers the case where `escalationService` is NOT supplied to
// `createRouter` — `pass` and legacy assign/archive must respond with 404.

describe('POST /entities/:id/pr/retry', () => {
  const acceptedEntity = {
    id: 'e-1',
    current_status: 'accepted',
    assigned_to: 'group:default/team-a',
    pr_status: 'failed',
    version: 3,
  };
  const mockStore = {
    getEntityById: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn(),
  } as unknown as jest.Mocked<CatalogService>;
  const prCreationService = { requestRetry: jest.fn() };

  async function makeApp(withPr = true) {
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: {} as any,
      scanService: {} as any,
      catalogService: mockCatalogService,
      escalationTrigger: mockEscalationTrigger as any,
      prCreationService: withPr ? prCreationService : undefined,
      checks: [],
      strategies: [],
    });
    return express().use(router).use(mockErrorHandler());
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore.getEntityById.mockResolvedValue(acceptedEntity as any);
    mockCatalogService.isUserMemberOfGroup.mockResolvedValue(true);
    prCreationService.requestRetry.mockResolvedValue({
      ...acceptedEntity,
      pr_status: 'pending',
    });
  });

  it('re-enqueues for a member of the accepted owner team and returns 202 without version', async () => {
    const app = await makeApp();
    const response = await request(app).post('/entities/e-1/pr/retry').send();

    expect(response.status).toBe(202);
    expect(response.body.entity).toMatchObject({
      id: 'e-1',
      pr_status: 'pending',
    });
    expect(response.body.entity.version).toBeUndefined();
    const userRef = mockCredentials.user().principal.userEntityRef;
    expect(mockCatalogService.isUserMemberOfGroup).toHaveBeenCalledWith(
      userRef,
      'group:default/team-a',
    );
    expect(prCreationService.requestRetry).toHaveBeenCalledWith('e-1', userRef);
  });

  it('returns 403 for a non-member', async () => {
    mockCatalogService.isUserMemberOfGroup.mockResolvedValue(false);
    const app = await makeApp();
    const response = await request(app).post('/entities/e-1/pr/retry').send();

    expect(response.status).toBe(403);
    expect(prCreationService.requestRetry).not.toHaveBeenCalled();
  });

  it('returns 409 when the PR is not in a retryable state', async () => {
    prCreationService.requestRetry.mockRejectedValue(
      new ConflictError('not failed'),
    );
    const app = await makeApp();
    const response = await request(app).post('/entities/e-1/pr/retry').send();

    expect(response.status).toBe(409);
  });

  it('returns 404 for an unknown entity', async () => {
    mockStore.getEntityById.mockResolvedValue(undefined);
    const app = await makeApp();
    const response = await request(app).post('/entities/nope/pr/retry').send();

    expect(response.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const app = await makeApp();
    const response = await request(app)
      .post('/entities/e-1/pr/retry')
      .set('Authorization', mockCredentials.none.header())
      .send();

    expect(response.status).toBe(401);
  });

  it('returns 404 when PR automation is disabled', async () => {
    const app = await makeApp(false);
    const response = await request(app).post('/entities/e-1/pr/retry').send();

    expect(response.status).toBe(404);
  });
});

describe('escalation endpoints (legacy removed)', () => {
  let app: express.Express;
  const mockStore = {} as jest.Mocked<OwnershipStore>;
  const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
    });
    app = express().use(router).use(mockErrorHandler());
  });

  it('returns 404 for the removed legacy /escalation/pass route', async () => {
    const response = await request(app)
      .post('/entities/e-1/escalation/pass')
      .send({ fromRole: 'director', toRole: 'vp' });

    expect(response.status).toBe(404);
  });

  it('returns 404 for the removed legacy /escalation/assign route when escalationService is not wired', async () => {
    const response = await request(app)
      .post('/entities/e-1/escalation/assign')
      .send({ ownerRef: 'group:default/new-team' });

    expect(response.status).toBe(404);
  });

  it('returns 404 for the removed legacy /escalation/archive route when escalationService is not wired', async () => {
    const response = await request(app)
      .post('/entities/e-1/escalation/archive')
      .send();

    expect(response.status).toBe(404);
  });
});

// ─── Scans ────────────────────────────────────────────────────────────────────

describe('GET /scans', () => {
  let app: express.Express;
  const mockStore = {
    listScans: jest.fn().mockResolvedValue([]),
    getScan: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;
  const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
    });
    app = express().use(router).use(mockErrorHandler());
  });

  it('returns scan list', async () => {
    const response = await request(app).get('/scans');
    expect(response.status).toBe(200);
    expect(response.body.scans).toEqual([]);
  });

  it('returns 404 for unknown scan id', async () => {
    mockStore.getScan.mockResolvedValue(undefined);
    const response = await request(app).get('/scans/unknown-id');
    expect(response.status).toBe(404);
  });

  it('returns scan detail with stats for a valid scan id', async () => {
    const mockScan = {
      id: 'scan-1',
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      total_entities_scanned: 42,
      new_issues_found: 3,
      existing_issues_updated: 5,
      issues_auto_resolved: 1,
      status: 'completed',
      duration_ms: 12345,
    };
    mockStore.getScan.mockResolvedValue(mockScan as any);

    const response = await request(app).get('/scans/scan-1');
    expect(response.status).toBe(200);
    expect(response.body.scan.id).toBe('scan-1');
    expect(response.body.scan.total_entities_scanned).toBe(42);
    expect(response.body.scan.status).toBe('completed');
  });

  it('triggers a scan and returns 202', async () => {
    const response = await request(app).post('/scans/trigger').send();
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('scan_triggered');
  });

  // 5.1.4 — invalid status filter returns 400
  it('returns 400 for invalid scan status filter', async () => {
    const response = await request(app).get('/scans?status=invalid');
    expect(response.status).toBe(400);
  });

  // Invalid date filter
  it('returns 400 for invalid since date filter', async () => {
    const response = await request(app).get('/scans?since=not-a-date');
    expect(response.status).toBe(400);
  });
});

// ─── POST /email-digest/trigger ───────────────────────────────────────────────

describe('POST /email-digest/trigger', () => {
  const mockStore = {
    listEntities: jest.fn(),
    getEntityById: jest.fn(),
    listProposalsByEntity: jest.fn(),
    listHistory: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
  } as unknown as jest.Mocked<OwnershipStore>;

  const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<CatalogService>;

  const mockEmailRunResult = {
    periodKey: '2025-06',
    emailed: ['group:default/team-a'],
    skipped: [],
    unresolvableContact: [],
    failed: [],
    totalEntitiesFlagged: 3,
  };

  const mockOwnershipEmailTask = {
    run: jest.fn().mockResolvedValue(mockEmailRunResult),
  };

  it('returns 200 with result JSON when ownershipEmailTask is provided', async () => {
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
      ownershipEmailTask: mockOwnershipEmailTask as any,
    });
    const app = express().use(router).use(mockErrorHandler());

    const response = await request(app).post('/email-digest/trigger').send();

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('completed');
    expect(response.body.periodKey).toBe('2025-06');
    expect(response.body.emailed).toEqual(['group:default/team-a']);
    expect(response.body.totalEntitiesFlagged).toBe(3);
    expect(mockOwnershipEmailTask.run).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when ownershipEmailTask is not provided (route does not mount)', async () => {
    const router = await createRouter({
      httpAuth: mockServices.httpAuth(),
      userInfo: mockServices.userInfo(),
      store: mockStore,
      lifecycleService: mockLifecycle,
      scanService: mockScanService,
      catalogService: mockCatalogService,
      escalationConfig: mockEscalationConfig,
      escalationTrigger: mockEscalationTrigger as any,
      checks: [],
      strategies: [],
      // ownershipEmailTask intentionally omitted
    });
    const app = express().use(router).use(mockErrorHandler());

    const response = await request(app).post('/email-digest/trigger').send();

    expect(response.status).toBe(404);
  });
});
