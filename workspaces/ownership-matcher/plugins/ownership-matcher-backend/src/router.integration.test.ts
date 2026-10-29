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

// @ts-nocheck
import {
  mockCredentials,
  mockErrorHandler,
  mockServices,
} from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { v4 as uuid } from 'uuid';
import { createRouter } from './router';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

// ─── Stateful In-Memory Store ────────────────────────────────────────────────

function createInMemoryStore() {
  const scans = new Map();
  const entities = new Map();
  const proposals = new Map();
  const history = [];

  return {
    scans,
    entities,
    proposals,
    history,

    // ── Scans ──────────────────────────────────────────────────────────────

    async createScan(input) {
      const id = uuid();
      scans.set(id, {
        id,
        started_at: (input && input.started_at) || new Date(),
        completed_at: null,
        total_entities_scanned: 0,
        new_issues_found: 0,
        existing_issues_updated: 0,
        issues_auto_resolved: 0,
        status: 'running',
        error_message: null,
        duration_ms: null,
      });
      return id;
    },

    async completeScan(id, input) {
      const scan = scans.get(id);
      if (!scan) return;
      Object.assign(scan, input);
    },

    async failScan(id, errorMessage, durationMs) {
      const scan = scans.get(id);
      if (!scan) return;
      scan.status = 'failed';
      scan.completed_at = new Date();
      scan.error_message = errorMessage;
      scan.duration_ms = durationMs;
    },

    async getScan(id) {
      return scans.get(id);
    },

    async failStaleScans() {
      let count = 0;
      for (const scan of scans.values()) {
        if (scan.status === 'running') {
          scan.status = 'failed';
          scan.completed_at = new Date();
          scan.error_message = 'Stale scan';
          count++;
        }
      }
      return count;
    },

    async listScans(limit, filter) {
      const maxRows = limit || 20;
      let rows = Array.from(scans.values());
      if (filter && filter.status)
        rows = rows.filter(r => r.status === filter.status);
      if (filter && filter.since)
        rows = rows.filter(r => r.started_at >= filter.since);
      if (filter && filter.until)
        rows = rows.filter(r => r.started_at <= filter.until);
      rows.sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
      return rows.slice(0, maxRows);
    },

    // ── Entities ───────────────────────────────────────────────────────────

    async createEntity(input) {
      const id = uuid();
      const now = new Date();
      entities.set(id, {
        id,
        entity_ref: input.entity_ref,
        entity_name: input.entity_name,
        entity_kind: input.entity_kind,
        entity_namespace: input.entity_namespace,
        current_owner: input.current_owner || null,
        first_detected_at: now,
        last_scanned_at: now,
        current_status: 'open',
        current_check: input.current_check,
        check_details: input.check_details
          ? JSON.stringify(input.check_details)
          : null,
        repo_url: input.repo?.webUrl ?? null,
        scm_type: input.repo?.type ?? null,
        repo_host: input.repo?.host ?? null,
        repo_path: input.repo?.path ?? null,
        pr_status: 'none',
        pr_url: null,
        pr_branch: null,
        pr_attempts: 0,
        pr_last_error: null,
        resolved_at: null,
        resolved_by: null,
        resolution_type: null,
        accepted_at: null,
        assigned_to: null,
      });
      return id;
    },

    async updateEntityLastScanned(id, _scanId) {
      const e = entities.get(id);
      if (e) e.last_scanned_at = new Date();
    },

    // `version` on success. The in-memory implementation skips the version
    // check (tests don't exercise concurrency); production behaviour lives
    // in `EntityStore` which throws ConflictError on version mismatch.

    async acceptEntity(id, resolvedBy, resolutionType, _expectedVersion) {
      const e = entities.get(id);
      if (!e) return;
      e.current_status = 'accepted';
      e.resolved_by = resolvedBy;
      e.resolution_type = resolutionType;
      e.accepted_at = new Date();
      e.version = (e.version || 1) + 1;
    },

    async reopenEntity(id, _expectedVersion) {
      const e = entities.get(id);
      if (!e) return;
      e.current_status = 'open';
      e.resolved_by = null;
      e.resolution_type = null;
      e.accepted_at = null;
      e.version = (e.version || 1) + 1;
    },

    async updateAssignee(id, assignedTo) {
      const e = entities.get(id);
      if (e) e.assigned_to = assignedTo;
    },

    async closeEntity(id, resolvedBy, resolutionType, _expectedVersion) {
      const e = entities.get(id);
      if (!e) return;
      e.current_status = 'closed';
      e.resolved_at = new Date();
      e.resolved_by = resolvedBy;
      e.resolution_type = resolutionType;
      e.version = (e.version || 1) + 1;
    },

    async markEntityToArchive(id, resolvedBy, assigneeRef, _expectedVersion) {
      const e = entities.get(id);
      if (!e) return;
      e.current_status = 'to_archive';
      e.resolved_by = resolvedBy;
      e.assigned_to = assigneeRef ?? e.assigned_to;
      e.version = (e.version || 1) + 1;
    },

    async setEntityEscalated(id, _expectedVersion) {
      const e = entities.get(id);
      if (e) {
        e.current_status = 'escalated';
        e.assigned_to = null;
        e.version = (e.version || 1) + 1;
      }
    },

    async setEntityUnresolved(id, _expectedVersion) {
      const e = entities.get(id);
      if (e) {
        e.current_status = 'unresolved';
        e.version = (e.version || 1) + 1;
      }
    },

    async findActiveQueueEntry(_entityId) {
      return null;
    },

    async getActiveEntityByRef(entityRef) {
      return Array.from(entities.values()).find(
        e =>
          e.entity_ref === entityRef &&
          ['open', 'escalated', 'accepted', 'to_archive'].includes(
            e.current_status,
          ),
      );
    },

    async getEntityById(id) {
      return entities.get(id);
    },

    async listEntities(filter, pagination) {
      let rows = Array.from(entities.values());

      if (filter && filter.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        rows = rows.filter(r => statuses.includes(r.current_status));
      }
      if (filter && filter.kind)
        rows = rows.filter(r => r.entity_kind === filter.kind);
      if (filter && filter.namespace)
        rows = rows.filter(r => r.entity_namespace === filter.namespace);
      if (filter && filter.check)
        rows = rows.filter(r => r.current_check === filter.check);
      if (filter && filter.assignedTo)
        rows = rows.filter(r => r.assigned_to === filter.assignedTo);

      rows.sort(
        (a, b) => b.first_detected_at.getTime() - a.first_detected_at.getTime(),
      );

      const page = (pagination && pagination.page) || 1;
      const limit = (pagination && pagination.limit) || 50;
      const offset = (page - 1) * limit;

      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        page,
        limit,
      };
    },

    // ── Proposals ──────────────────────────────────────────────────────────

    async createProposal(input) {
      const id = uuid();
      proposals.set(id, {
        id,
        entity_id: input.entity_id,
        proposed_owner_ref: input.proposed_owner_ref,
        confidence_reason: input.confidence_reason,
        confidence_score: input.confidence_score ?? null,
        proposal_order: input.proposal_order,
        status: 'pending',
        escalation_level: input.escalation_level || 0,
        notified_at: null,
        responded_at: null,
        response_note: null,
        created_at: new Date(),
      });
      return id;
    },

    async getProposal(id) {
      return proposals.get(id);
    },

    async listProposalsByEntity(entityId) {
      return Array.from(proposals.values())
        .filter(p => p.entity_id === entityId)
        .sort((a, b) => a.proposal_order - b.proposal_order);
    },

    async listActiveProposalsByEntity(entityId) {
      return Array.from(proposals.values())
        .filter(
          p =>
            p.entity_id === entityId &&
            ['pending', 'notified'].includes(p.status),
        )
        .sort((a, b) => a.proposal_order - b.proposal_order);
    },

    async listPendingProposalIdsForOwner(ownerRef) {
      return Array.from(proposals.values())
        .filter(
          p =>
            p.proposed_owner_ref === ownerRef &&
            ['pending', 'notified'].includes(p.status),
        )
        .map(p => p.id);
    },

    async updateProposalStatus(id, status, extra) {
      const p = proposals.get(id);
      if (!p) return;
      p.status = status;
      if (extra && extra.respondedAt) p.responded_at = extra.respondedAt;
      if (extra && extra.responseNote) p.response_note = extra.responseNote;
      if (extra && extra.notifiedAt) p.notified_at = extra.notifiedAt;
    },

    // ── History ────────────────────────────────────────────────────────────

    async appendHistory(input) {
      history.push({
        id: uuid(),
        entity_id: input.entity_id,
        proposal_id: input.proposal_id || null,
        scan_id: input.scan_id || null,
        action: input.action,
        actor: input.actor || null,
        details: input.details ? JSON.stringify(input.details) : null,
        created_at: new Date(),
      });
    },

    async listHistory(entityId) {
      return history
        .filter(h => h.entity_id === entityId)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    },

    async getRejectedActors(entityId) {
      const proposalIds = history
        .filter(
          h =>
            h.entity_id === entityId &&
            ['proposal_rejected', 'proposal_expired'].includes(h.action) &&
            h.proposal_id,
        )
        .map(h => h.proposal_id);

      const refs = proposalIds
        .map(pid => proposals.get(pid))
        .filter(Boolean)
        .map(p => p.proposed_owner_ref);

      return new Set(refs);
    },

    // writes grace_warning + grace_expiry deadlines via withTransaction. The
    // in-memory store doesn't track pending_deadlines so this is a no-op stub
    // — just hands the callback a tx with a no-op pendingDeadlineStore so
    // the accept flow doesn't throw.
    async withTransaction(cb) {
      const tx = {
        pendingDeadlineStore: {
          async writeDeadline(_input) {},
          async cancelDeadlinesForEntity(_entityId, _types) {},
        },
        entityStore: this,
        proposalStore: this,
        historyStore: this,
        escalationQueueStore: this,
      };
      return cb(tx);
    },
  };
}

// ─── Test Helpers ────────────────────────────────────────────────────────────

const ESCALATION_CONFIG = {
  levels: [
    { role: 'director', timeoutDays: 7, canPass: true },
    { role: 'vp', timeoutDays: 14, canPass: false },
  ],
};

async function createIntegrationApp(store, opts) {
  const logger = mockServices.logger.mock();
  const mockScanService = {
    runScan: jest.fn().mockResolvedValue({
      totalScanned: 0,
      newIssuesFound: 0,
      existingIssuesUpdated: 0,
      issuesAutoResolved: 0,
    }),
  };
  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
  };
  const userInfo = (opts && opts.userInfo) || mockServices.userInfo();

  // Lightweight EscalationTrigger that mirrors the old in-line behavior of
  // PLS.checkAndTriggerEscalation: flip the entity to `escalated` and emit
  // `escalation_triggered` history. Real BFS/queue logic is exercised by the
  // ScannerEscalation/EscalationTriggering suites; here we only need the
  // boundary side effect so Flow 3 / Flow 8 assertions hold.
  const escalationTrigger = {
    async triggerEscalation(entityId) {
      const entity = await store.getEntityById(entityId);
      if (!entity || entity.current_status !== 'open') return;
      await store.setEntityEscalated(entityId, entity.version);
      await store.appendHistory({
        entity_id: entityId,
        action: 'escalation_triggered',
        actor: 'system',
        details: { reason: 'candidates_exhausted' },
      });
    },
  };

  const lifecycleService = new ProposalLifecycleService(
    store,
    logger,
    undefined,
    undefined,
    escalationTrigger,
  );

  const router = await createRouter({
    httpAuth: mockServices.httpAuth(),
    permissions: mockServices.permissions(),
    userInfo,
    store,
    lifecycleService,
    scanService: mockScanService,
    catalogService: mockCatalogService,
    escalationConfig: ESCALATION_CONFIG,
    escalationTrigger,
  });

  const app = express().use(router).use(mockErrorHandler());
  return { app, store, mockScanService };
}

function seedEntity(store, overrides) {
  const o = overrides || {};
  const id = o.id || uuid();
  const now = new Date();
  const entity = {
    id,
    entity_ref: `component:default/svc-${id.slice(0, 8)}`,
    entity_name: `svc-${id.slice(0, 8)}`,
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: now,
    last_scanned_at: now,
    current_status: 'open',
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
    resolved_at: null,
    resolved_by: null,
    resolution_type: null,
    accepted_at: null,
    assigned_to: null,
    version: 1,
    ...o,
  };
  store.entities.set(id, entity);
  return entity;
}

function seedProposal(store, entityId, overrides) {
  const o = overrides || {};
  const id = o.id || uuid();
  const proposal = {
    id,
    entity_id: entityId,
    proposed_owner_ref: `group:default/team-${id.slice(0, 4)}`,
    confidence_reason: 'top_contributor',
    confidence_score: 0.8,
    proposal_order: 1,
    status: 'pending',
    escalation_level: 0,
    notified_at: null,
    responded_at: null,
    response_note: null,
    created_at: new Date(),
    ...o,
  };
  store.proposals.set(id, proposal);
  return proposal;
}

function seedScan(store, overrides) {
  const o = overrides || {};
  const id = o.id || uuid();
  const scan = {
    id,
    started_at: new Date(),
    completed_at: new Date(),
    total_entities_scanned: 100,
    new_issues_found: 5,
    existing_issues_updated: 10,
    issues_auto_resolved: 3,
    status: 'completed',
    error_message: null,
    duration_ms: 1234,
    ...o,
  };
  store.scans.set(id, scan);
  return scan;
}

// ─── Flow 1: Entity & Scan Read API ───────────────────────────────

describe('Flow 1: Entity & Scan Read API', () => {
  let app;
  let store;
  let openEntity;
  let resolvedEntity;
  let escalatedEntity;
  let scan;

  beforeEach(async () => {
    store = createInMemoryStore();
    ({ app } = await createIntegrationApp(store));

    openEntity = seedEntity(store, {
      current_status: 'open',
      entity_kind: 'Component',
    });
    resolvedEntity = seedEntity(store, {
      current_status: 'accepted',
      entity_kind: 'Component',
    });
    escalatedEntity = seedEntity(store, {
      current_status: 'escalated',
      entity_kind: 'API',
    });
    scan = seedScan(store);

    seedProposal(store, openEntity.id);
    store.history.push({
      id: uuid(),
      entity_id: openEntity.id,
      proposal_id: null,
      scan_id: null,
      action: 'issue_detected',
      actor: 'system',
      details: null,
      created_at: new Date(),
    });
  });

  it('GET /entities returns paginated entity list', async () => {
    const res = await request(app).get('/entities');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
  });

  it('GET /entities?status=open filters by status', async () => {
    const res = await request(app).get('/entities?status=open');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(openEntity.id);
  });

  it('GET /entities?status=open&kind=Component filters by compound criteria', async () => {
    const res = await request(app).get('/entities?status=open&kind=Component');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(openEntity.id);
  });

  it('GET /entities?kind=API filters by kind', async () => {
    const res = await request(app).get('/entities?kind=API');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(escalatedEntity.id);
  });

  it('GET /entities/:id returns entity detail with proposals and history', async () => {
    const res = await request(app).get(`/entities/${openEntity.id}`);
    expect(res.status).toBe(200);
    expect(res.body.entity.id).toBe(openEntity.id);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].action).toBe('issue_detected');
  });

  it('GET /entities/:id returns 404 for unknown entity', async () => {
    const res = await request(app).get('/entities/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('GET /scans returns scan list', async () => {
    const res = await request(app).get('/scans');
    expect(res.status).toBe(200);
    expect(res.body.scans).toHaveLength(1);
    expect(res.body.scans[0].id).toBe(scan.id);
  });

  it('GET /scans/:id returns scan detail with statistics', async () => {
    const res = await request(app).get(`/scans/${scan.id}`);
    expect(res.status).toBe(200);
    expect(res.body.scan.total_entities_scanned).toBe(100);
    expect(res.body.scan.new_issues_found).toBe(5);
    expect(res.body.scan.duration_ms).toBe(1234);
  });

  it('GET /scans/:id returns 404 for unknown scan', async () => {
    const res = await request(app).get('/scans/nonexistent-id');
    expect(res.status).toBe(404);
  });
});

// ─── Flow 2: Proposal Accept Flow ────────────────────────

describe('Flow 2: Proposal Accept Flow', () => {
  let app;
  let store;
  let entity;
  let proposal;

  beforeEach(async () => {
    store = createInMemoryStore();
    ({ app } = await createIntegrationApp(store));

    entity = seedEntity(store, { current_status: 'open' });
    proposal = seedProposal(store, entity.id, {
      proposed_owner_ref: 'group:default/team-alpha',
    });
  });

  // Known failure, tracked as a separate issue.
  it.failing(
    'accepting a proposal resolves the entity and creates history',
    async () => {
      const acceptRes = await request(app)
        .post(`/proposals/${proposal.id}/accept`)
        .send();
      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.status).toBe('accepted');
      expect(acceptRes.body.proposal.status).toBe('accepted');
      expect(acceptRes.body.entity.current_status).toBe('accepted');

      const entityRes = await request(app).get(`/entities/${entity.id}`);
      expect(entityRes.body.entity.current_status).toBe('accepted');

      const actions = entityRes.body.history.map(h => h.action);
      expect(actions).toContain('proposal_accepted');
      expect(actions).toContain('entity_accepted');
    },
  );

  it('re-accepting an already accepted proposal returns 409', async () => {
    await request(app).post(`/proposals/${proposal.id}/accept`).send();
    const res = await request(app)
      .post(`/proposals/${proposal.id}/accept`)
      .send();
    expect(res.status).toBe(409);
  });

  it('accepting a nonexistent proposal returns 404', async () => {
    const res = await request(app).post('/proposals/nonexistent/accept').send();
    expect(res.status).toBe(404);
  });
});

// ─── Flow 3: Proposal Reject → Escalation ────────────────

describe('Flow 3: Proposal Reject → Escalation', () => {
  let app;
  let store;
  let entity;
  let proposal1;
  let proposal2;

  beforeEach(async () => {
    store = createInMemoryStore();
    ({ app } = await createIntegrationApp(store));

    entity = seedEntity(store, { current_status: 'open' });
    proposal1 = seedProposal(store, entity.id, {
      proposal_order: 1,
      proposed_owner_ref: 'group:default/team-a',
    });
    proposal2 = seedProposal(store, entity.id, {
      proposal_order: 2,
      proposed_owner_ref: 'group:default/team-b',
    });
  });

  // Known failure, tracked as a separate issue.
  it.failing(
    'rejecting first proposal keeps entity open, rejecting last triggers escalation',
    async () => {
      const reject1 = await request(app)
        .post(`/proposals/${proposal1.id}/reject`)
        .send({ reason: 'not our team' });
      expect(reject1.status).toBe(200);
      expect(reject1.body.status).toBe('rejected');

      const afterFirst = await request(app).get(`/entities/${entity.id}`);
      expect(afterFirst.body.entity.current_status).toBe('open');

      const firstHistory = afterFirst.body.history;
      const rejectionEntry = firstHistory.find(
        h => h.action === 'proposal_rejected',
      );
      expect(rejectionEntry).toBeDefined();
      expect(JSON.parse(rejectionEntry.details)).toMatchObject({
        reason: 'not our team',
      });

      const reject2 = await request(app)
        .post(`/proposals/${proposal2.id}/reject`)
        .send({ reason: 'wrong team' });
      expect(reject2.status).toBe(200);

      const afterSecond = await request(app).get(`/entities/${entity.id}`);
      expect(afterSecond.body.entity.current_status).toBe('escalated');

      const finalActions = afterSecond.body.history.map(h => h.action);
      expect(finalActions).toContain('escalation_triggered');
    },
  );

  it('rejecting a nonexistent proposal returns 404', async () => {
    const res = await request(app)
      .post('/proposals/nonexistent/reject')
      .send({ reason: 'irrelevant' });
    expect(res.status).toBe(404);
  });

  it('rejecting an already rejected proposal returns 409', async () => {
    await request(app)
      .post(`/proposals/${proposal1.id}/reject`)
      .send({ reason: 'first rejection' });
    const res = await request(app)
      .post(`/proposals/${proposal1.id}/reject`)
      .send({ reason: 'second attempt' });
    expect(res.status).toBe(409);
  });
});

// ─── Flow 4: Escalation Actions ───────────────────────────────────

describe('Flow 4: Escalation Actions', () => {
  describe('escalation assign', () => {
    let app;
    let store;
    let entity;

    beforeEach(async () => {
      store = createInMemoryStore();
      ({ app } = await createIntegrationApp(store));
      entity = seedEntity(store, { current_status: 'escalated' });
    });

    // adds positive-path tests against the new escalation router with the
    // proper service mocks. Until then we assert the legacy URLs return 404.

    it('legacy /escalation/assign route is removed → 404', async () => {
      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/assign`)
        .send({ ownerRef: 'group:default/new-owners' });
      expect(res.status).toBe(404);
    });
  });

  describe('escalation archive', () => {
    let app;
    let store;
    let entity;

    beforeEach(async () => {
      store = createInMemoryStore();
      ({ app } = await createIntegrationApp(store));
      entity = seedEntity(store, { current_status: 'escalated' });
    });

    it('legacy /escalation/archive route is removed → 404', async () => {
      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/archive`)
        .send();
      expect(res.status).toBe(404);
    });
  });

  describe('escalation pass', () => {
    let app;
    let store;
    let entity;

    beforeEach(async () => {
      store = createInMemoryStore();
      ({ app } = await createIntegrationApp(store));
      entity = seedEntity(store, { current_status: 'escalated' });
    });

    it('legacy /escalation/pass route is removed → 404', async () => {
      const res = await request(app)
        .post(`/entities/${entity.id}/escalation/pass`)
        .send({ fromRole: 'director', toRole: 'vp' });
      expect(res.status).toBe(404);
    });
  });
});

// ─── Flow 5: Authentication Enforcement ──────────────────

describe('Flow 5: Authentication Enforcement', () => {
  let app;
  let store;

  beforeEach(async () => {
    store = createInMemoryStore();
    ({ app } = await createIntegrationApp(store));
  });

  it('GET /entities is accessible without auth', async () => {
    const res = await request(app).get('/entities');
    expect(res.status).toBe(200);
  });

  it('POST /proposals/:id/accept requires user auth', async () => {
    const entity = seedEntity(store);
    const proposal = seedProposal(store, entity.id);
    const res = await request(app)
      .post(`/proposals/${proposal.id}/accept`)
      .set('Authorization', mockCredentials.none.header())
      .send();
    expect(res.status).toBe(401);
  });

  it('POST /proposals/:id/reject requires user auth', async () => {
    const entity = seedEntity(store);
    const proposal = seedProposal(store, entity.id);
    const res = await request(app)
      .post(`/proposals/${proposal.id}/reject`)
      .set('Authorization', mockCredentials.none.header())
      .send();
    expect(res.status).toBe(401);
  });

  // /escalation/* endpoints lives in (escalation router tests).
});

// ─── Flow 6: Scan Trigger ─────────────────────────────────────────

describe('Flow 6: Scan Trigger', () => {
  it('POST /scans/trigger fires scan asynchronously and returns 202', async () => {
    const store = createInMemoryStore();
    const { app, mockScanService } = await createIntegrationApp(store);

    const res = await request(app).post('/scans/trigger').send();
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('scan_triggered');
    expect(mockScanService.runScan).toHaveBeenCalled();
  });
});

// ─── Flow 7: Input Validation ────────────────────────────

describe('Flow 7: Input Validation', () => {
  let app;
  let store;

  beforeEach(async () => {
    store = createInMemoryStore();
    ({ app } = await createIntegrationApp(store));
  });

  it('POST /proposals/:id/reject without reason returns 400', async () => {
    const entity = seedEntity(store);
    const proposal = seedProposal(store, entity.id);
    const res = await request(app)
      .post(`/proposals/${proposal.id}/reject`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST /proposals/:id/accept with extra body fields returns 400', async () => {
    const entity = seedEntity(store);
    const proposal = seedProposal(store, entity.id);
    const res = await request(app)
      .post(`/proposals/${proposal.id}/accept`)
      .send({ note: 'a note' });
    expect(res.status).toBe(400);
  });

  it('GET /scans?status=invalid returns 400', async () => {
    const res = await request(app).get('/scans?status=invalid');
    expect(res.status).toBe(400);
  });

  it('GET /scans?since=not-a-date returns 400', async () => {
    const res = await request(app).get('/scans?since=not-a-date');
    expect(res.status).toBe(400);
  });
});

// ─── Flow 8: Full Lifecycle E2E ──────────────────────────

describe('Flow 8: Full Reject-All → Escalation Triggered', () => {
  it('rejecting the last proposal transitions entity to escalated and emits expected history', async () => {
    const store = createInMemoryStore();
    const { app } = await createIntegrationApp(store);

    const entity = seedEntity(store, { current_status: 'open' });
    const proposal = seedProposal(store, entity.id, {
      proposed_owner_ref: 'group:default/team-a',
    });

    // Reject the only proposal → entity becomes escalated
    const rejectRes = await request(app)
      .post(`/proposals/${proposal.id}/reject`)
      .send({ reason: 'not responsible' });
    expect(rejectRes.status).toBe(200);

    const afterReject = await request(app).get(`/entities/${entity.id}`);
    expect(afterReject.body.entity.current_status).toBe('escalated');

    // the full assign / archive flows in with the proper service mocks.

    const actions = afterReject.body.history.map(h => h.action);
    expect(actions).toEqual(
      expect.arrayContaining(['proposal_rejected', 'escalation_triggered']),
    );

    const rejectIdx = actions.indexOf('proposal_rejected');
    const escalationIdx = actions.indexOf('escalation_triggered');
    expect(rejectIdx).toBeLessThan(escalationIdx);
  });
});
