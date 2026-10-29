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
import { mockErrorHandler, mockServices } from '@backstage/backend-test-utils';
import express from 'express';
import request from 'supertest';
import { v4 as uuid } from 'uuid';
import { createRouter } from './router';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';

// ─── In-Memory Store ──────────────────────────────────────────────────────────

function createStore() {
  const entities = new Map();
  const proposals = new Map();
  const history = [];
  /** Rows of `escalation_queue_entries` (only the columns the router reads). */
  const escalationEntries = [];

  // Mirrors EntityStore.whereOwnedOrEscalatedTo: escalated entities are scoped
  // by the active queue entry's actor, everything else by current_owner.
  const inScope = (e, owners, actorRef) => {
    if (!actorRef) return !!e.current_owner && owners.has(e.current_owner);
    if (e.current_status === 'escalated') {
      return escalationEntries.some(
        q =>
          q.entity_id === e.id &&
          q.status === 'active' &&
          q.resolved_actor_ref === actorRef,
      );
    }
    return !!e.current_owner && owners.has(e.current_owner);
  };

  return {
    entities,
    proposals,
    history,
    escalationEntries,

    async createEntity(input) {
      const id = uuid();
      const now = new Date();
      entities.set(id, {
        id,
        entity_ref: input.entity_ref,
        entity_name: input.entity_name,
        entity_kind: input.entity_kind ?? 'Component',
        entity_namespace: input.entity_namespace ?? 'default',
        current_owner: input.current_owner ?? null,
        first_detected_at: now,
        last_scanned_at: now,
        current_status: 'open',
        current_check: input.current_check ?? 'orphaned',
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
      });
      return id;
    },

    async getEntityById(id) {
      return entities.get(id);
    },
    async updateEntityLastScanned() {},
    async acceptEntity() {},
    async reopenEntity() {},
    async updateAssignee() {},
    async markEntityToArchive() {},
    async closeEntity() {},
    async setEntityEscalated() {},
    async setEntityUnresolved() {},
    async getActiveEntityByRef(ref) {
      return Array.from(entities.values()).find(e => e.entity_ref === ref);
    },
    async listActiveEntitiesForReconciliation() {
      return [];
    },
    async findActiveQueueEntry() {
      return null;
    },
    async countActiveEscalationsForActor(actorRef) {
      return escalationEntries.filter(
        q => q.status === 'active' && q.resolved_actor_ref === actorRef,
      ).length;
    },
    async findExpiredDeadlines() {
      return [];
    },

    async getStats() {
      const rows = Array.from(entities.values()).filter(e =>
        ['open', 'escalated', 'unresolved'].includes(e.current_status),
      );
      const perCheck = {};
      for (const e of rows) {
        perCheck[e.current_check] = (perCheck[e.current_check] ?? 0) + 1;
      }
      return {
        totalOpen: rows.length,
        perCheck,
        pendingProposals: 0,
        totalProposals: 0,
        avgConfidence: null,
      };
    },

    async getDashboardStats() {
      return this.getStats();
    },

    async getStatsForOwners(owners, escalationActorRef) {
      const ownerSet = new Set(owners);
      const rows = Array.from(entities.values()).filter(
        e =>
          ['open', 'escalated', 'unresolved'].includes(e.current_status) &&
          inScope(e, ownerSet, escalationActorRef),
      );
      const perCheck = {};
      for (const e of rows) {
        perCheck[e.current_check] = (perCheck[e.current_check] ?? 0) + 1;
      }
      return { totalOpen: rows.length, perCheck };
    },

    async listEntities(filter, pagination) {
      let rows = Array.from(entities.values());
      if (filter?.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        rows = rows.filter(r => statuses.includes(r.current_status));
      }
      if (filter?.escalationActorRef || filter?.owners?.length) {
        const ownerSet = new Set(filter.owners ?? []);
        rows = rows.filter(r =>
          inScope(r, ownerSet, filter.escalationActorRef),
        );
      }
      if (filter?.kind) rows = rows.filter(r => r.entity_kind === filter.kind);
      const page = pagination?.page ?? 1;
      const limit = pagination?.limit ?? 50;
      const offset = (page - 1) * limit;
      return {
        items: rows.slice(offset, offset + limit),
        total: rows.length,
        page,
        limit,
      };
    },

    async createProposal(input) {
      const id = uuid();
      proposals.set(id, {
        id,
        entity_id: input.entity_id,
        proposed_owner_ref: input.proposed_owner_ref,
        confidence_reason: input.confidence_reason ?? '[]',
        confidence_score: input.confidence_score ?? 0.8,
        proposal_order: input.proposal_order ?? 1,
        status: 'pending',
        escalation_level: 0,
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
      return Array.from(proposals.values()).filter(
        p => p.entity_id === entityId,
      );
    },
    async listActiveProposalsByEntity(entityId) {
      return Array.from(proposals.values()).filter(
        p => p.entity_id === entityId && p.status === 'pending',
      );
    },
    async listProposalsForOwners(ownerRefs, statuses) {
      const ownerSet = new Set(ownerRefs);
      const statusSet = new Set(statuses ?? ['pending']);
      return Array.from(proposals.values()).filter(
        p => ownerSet.has(p.proposed_owner_ref) && statusSet.has(p.status),
      );
    },
    async listAllProposals(pagination, filter) {
      let rows = Array.from(proposals.values());
      if (filter?.status)
        rows = rows.filter(p => filter.status.includes(p.status));
      const page = pagination?.page ?? 1;
      const limit = pagination?.limit ?? 50;
      return {
        items: rows.slice((page - 1) * limit, page * limit),
        total: rows.length,
        page,
        limit,
      };
    },
    async listPendingProposalIdsForOwner(ownerRef) {
      return Array.from(proposals.values())
        .filter(
          p => p.proposed_owner_ref === ownerRef && p.status === 'pending',
        )
        .map(p => p.id);
    },
    async updateProposalStatus(id, status, extra) {
      const p = proposals.get(id);
      if (!p) return;
      p.status = status;
      if (extra?.respondedAt) p.responded_at = extra.respondedAt;
      if (extra?.responseNote) p.response_note = extra.responseNote;
    },
    async refreshNotifiedAt() {},
    async listProposalsNeedingReminder() {
      return [];
    },

    async appendHistory(input) {
      history.push({ id: uuid(), ...input, created_at: new Date() });
    },
    async listHistory(entityId) {
      return history.filter(h => h.entity_id === entityId);
    },
    async getLatestHistoryAction() {
      return undefined;
    },
    async getRejectedActors() {
      return new Set();
    },

    async createScan() {
      return uuid();
    },
    async completeScan() {},
    async failScan() {},
    async failStaleScans() {
      return 0;
    },
    async getScan() {
      return undefined;
    },
    async listScans() {
      return [];
    },

    async withTransaction(cb) {
      return cb({
        entityStore: this,
        proposalStore: this,
        historyStore: this,
        escalationQueueStore: { findActiveEntry: async () => null },
        pendingDeadlineStore: {
          writeDeadline: async () => {},
          cancelDeadlinesForEntity: async () => {},
        },
      });
    },
  };
}

// ─── App Factory ──────────────────────────────────────────────────────────────

const TEAM_REF = 'group:default/platform-team';
const SUB_TEAM_REF = 'group:default/platform-sub-team';

async function buildApp(store, opts = {}) {
  const logger = mockServices.logger.mock();
  const lifecycleService = new ProposalLifecycleService(store, logger);

  const mockCatalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
    walkGroupHierarchy: jest
      .fn()
      .mockResolvedValue(
        opts.subTeams ?? [
          { ref: SUB_TEAM_REF, kind: 'Group', specType: 'team' },
        ],
      ),
    getEntityByRef: jest.fn().mockResolvedValue(
      opts.userEntity ?? {
        kind: 'User',
        metadata: {
          name: 'alice',
          userDetails: { jobTitle: opts.jobTitle ?? 'Engineering Manager' },
        },
        spec: { memberOf: [TEAM_REF] },
      },
    ),
  };

  const escalationConfig = opts.escalationConfig ?? {
    levels: [
      {
        groupFilter: 'Group:team',
        timeoutDays: 7,
        titlePatterns: ['Engineering Manager', 'Director'],
      },
    ],
  };

  const userInfo =
    opts.userInfo ??
    mockServices.userInfo({
      userEntityRef: 'user:default/alice',
    });

  const escalationTrigger = {
    async triggerEscalation() {},
  };

  const router = await createRouter({
    httpAuth: mockServices.httpAuth(),
    userInfo,
    store,
    lifecycleService,
    scanService: { runScan: jest.fn() },
    catalogService: mockCatalogService,
    escalationConfig,
    escalationTrigger,
    checks: [],
    strategies: [],
  });

  const app = express().use(router).use(mockErrorHandler());
  return { app, store, mockCatalogService };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /leadership/stats', () => {
  it('returns zero stats when user has no group memberships', async () => {
    const store = createStore();
    const { app } = await buildApp(store, {
      userEntity: {
        kind: 'User',
        metadata: { name: 'alice' },
        spec: { memberOf: [] },
      },
    });

    const res = await request(app).get('/leadership/stats');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalOpen: 0,
      perCheck: {},
      pendingProposals: 0,
    });
  });

  it('counts only entities owned by the managed group subtree', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/mine',
      entity_name: 'mine',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_owner: TEAM_REF,
      current_check: 'orphaned',
    });
    await store.createEntity({
      entity_ref: 'c:d/sub',
      entity_name: 'sub',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_owner: SUB_TEAM_REF,
      current_check: 'orphaned',
    });
    await store.createEntity({
      entity_ref: 'c:d/other',
      entity_name: 'other',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_owner: 'group:default/other-team',
      current_check: 'orphaned',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/stats');

    expect(res.status).toBe(200);
    expect(res.body.totalOpen).toBe(2);
    expect(res.body.perCheck.orphaned).toBe(2);
  });

  it('counts pending proposals for managed groups', async () => {
    const store = createStore();
    const entityId = await store.createEntity({
      entity_ref: 'c:d/e',
      entity_name: 'e',
      current_owner: TEAM_REF,
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: TEAM_REF,
      confidence_reason: '[]',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/stats');

    expect(res.status).toBe(200);
    expect(res.body.pendingProposals).toBe(1);
  });
});

describe('GET /leadership/entities', () => {
  it('returns entities for the managed group subtree only', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/mine',
      entity_name: 'mine',
      current_owner: TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/sub',
      entity_name: 'sub',
      current_owner: SUB_TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/other',
      entity_name: 'other',
      current_owner: 'group:default/other',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/entities');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const names = res.body.items.map(i => i.entity_name);
    expect(names).toContain('mine');
    expect(names).toContain('sub');
    expect(names).not.toContain('other');
  });

  it('returns empty list when user has no group memberships', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/e',
      entity_name: 'e',
      current_owner: TEAM_REF,
    });

    const { app } = await buildApp(store, {
      userEntity: {
        kind: 'User',
        metadata: { name: 'alice' },
        spec: { memberOf: [] },
      },
    });
    const res = await request(app).get('/leadership/entities');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('respects status filter', async () => {
    const store = createStore();
    const openId = await store.createEntity({
      entity_ref: 'c:d/open',
      entity_name: 'open',
      current_owner: TEAM_REF,
    });
    const closedId = await store.createEntity({
      entity_ref: 'c:d/closed',
      entity_name: 'closed',
      current_owner: TEAM_REF,
    });
    store.entities.get(closedId).current_status = 'closed';

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/entities?status=open');

    expect(res.status).toBe(200);
    const ids = res.body.items.map(i => i.id);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(closedId);
  });

  it('returns correct pagination metadata', async () => {
    const store = createStore();
    for (let i = 0; i < 5; i++) {
      await store.createEntity({
        entity_ref: `c:d/e${i}`,
        entity_name: `e${i}`,
        current_owner: TEAM_REF,
      });
    }

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/entities?page=1&limit=2');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(2);
  });
});

describe('GET /leadership/proposals', () => {
  it('returns pending proposals for managed groups by default', async () => {
    const store = createStore();
    const entityId = await store.createEntity({
      entity_ref: 'c:d/e',
      entity_name: 'e',
      current_owner: TEAM_REF,
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: TEAM_REF,
      confidence_reason: '[]',
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: 'group:default/other',
      confidence_reason: '[]',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/proposals');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].proposal.proposed_owner_ref).toBe(TEAM_REF);
  });

  it('includes proposals for sub-team groups', async () => {
    const store = createStore();
    const entityId = await store.createEntity({
      entity_ref: 'c:d/e',
      entity_name: 'e',
      current_owner: SUB_TEAM_REF,
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: SUB_TEAM_REF,
      confidence_reason: '[]',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/proposals');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it('returns empty list when user has no group memberships', async () => {
    const store = createStore();
    const entityId = await store.createEntity({
      entity_ref: 'c:d/e',
      entity_name: 'e',
      current_owner: TEAM_REF,
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: TEAM_REF,
      confidence_reason: '[]',
    });

    const { app } = await buildApp(store, {
      userEntity: {
        kind: 'User',
        metadata: { name: 'alice' },
        spec: { memberOf: [] },
      },
    });
    const res = await request(app).get('/leadership/proposals');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });

  it('rejects invalid status values with 400', async () => {
    const store = createStore();
    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/proposals?status=bogus');
    expect(res.status).toBe(400);
  });

  it('enriches proposal response with entity and actor', async () => {
    const store = createStore();
    const entityId = await store.createEntity({
      entity_ref: 'c:d/svc',
      entity_name: 'svc',
      current_owner: TEAM_REF,
    });
    await store.createProposal({
      entity_id: entityId,
      proposed_owner_ref: TEAM_REF,
      confidence_reason: '[]',
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/proposals');

    expect(res.status).toBe(200);
    const item = res.body.items[0];
    expect(item.entity).toBeDefined();
    expect(item.entity.entity_name).toBe('svc');
    expect(item.actor).toBeNull();
  });
});

describe('resolveManagedGroupRefs — title pattern matching', () => {
  it('non-leader user gets only direct memberships without subtree expansion', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/mine',
      entity_name: 'mine',
      current_owner: TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/sub',
      entity_name: 'sub',
      current_owner: SUB_TEAM_REF,
    });

    const { app, mockCatalogService } = await buildApp(store, {
      jobTitle: 'Software Engineer',
    });

    const res = await request(app).get('/leadership/entities');

    expect(res.status).toBe(200);
    // Non-leader: sees only direct membership (TEAM_REF), no subtree walk
    const names = res.body.items.map(i => i.entity_name);
    expect(names).toContain('mine');
    expect(names).not.toContain('sub');
    // walkGroupHierarchy should not have been called
    expect(mockCatalogService.walkGroupHierarchy).not.toHaveBeenCalled();
  });

  it('leader user gets subtree expansion when title matches pattern', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/mine',
      entity_name: 'mine',
      current_owner: TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/sub',
      entity_name: 'sub',
      current_owner: SUB_TEAM_REF,
    });

    const { app } = await buildApp(store, {
      jobTitle: 'Engineering Manager',
    });

    const res = await request(app).get('/leadership/entities');

    expect(res.status).toBe(200);
    const names = res.body.items.map(i => i.entity_name);
    expect(names).toContain('mine');
    expect(names).toContain('sub');
  });
});

// ─── Escalations routed via the manager chain (resolved_actor_ref) ───────────

const DIRECTOR_REF = 'user:default/alice';
const CHAPTER_REF = 'group:default/chapter-platform';

/** Seed an escalated entity and (optionally) its active queue entry for `actorRef`. */
async function seedEscalated(
  store,
  name,
  { owner = null, actorRef, entryStatus = 'active' } = {},
) {
  const id = await store.createEntity({
    entity_ref: `c:d/${name}`,
    entity_name: name,
    current_owner: owner,
  });
  store.entities.get(id).current_status = 'escalated';
  if (actorRef) {
    store.escalationEntries.push({
      id: uuid(),
      entity_id: id,
      group_ref: TEAM_REF,
      escalation_level: 1,
      position: 0,
      status: entryStatus,
      resolved_actor_ref: actorRef,
    });
  }
  return id;
}

const chapterDirector = {
  kind: 'User',
  metadata: { name: 'alice', userDetails: { jobTitle: 'Director' } },
  spec: { memberOf: [CHAPTER_REF] },
};

describe('leadership — escalations assigned via resolved_actor_ref', () => {
  it('returns the case escalated to a director whose only group is non-team', async () => {
    const store = createStore();
    await seedEscalated(store, 'orphan-svc', { actorRef: DIRECTOR_REF });
    await seedEscalated(store, 'someone-elses', {
      actorRef: 'user:default/bob',
    });

    const { app } = await buildApp(store, {
      userEntity: chapterDirector,
      subTeams: [],
    });
    const res = await request(app).get('/leadership/entities?status=escalated');

    expect(res.status).toBe(200);
    expect(res.body.items.map(i => i.entity_name)).toEqual(['orphan-svc']);
    expect(res.body.total).toBe(1);
  });

  it('returns the assigned case even when the user has no group memberships or matching title', async () => {
    const store = createStore();
    await seedEscalated(store, 'orphan-svc', { actorRef: DIRECTOR_REF });

    const { app } = await buildApp(store, {
      userEntity: {
        kind: 'User',
        metadata: { name: 'alice', userDetails: { jobTitle: 'Engineer' } },
        spec: { memberOf: [] },
      },
    });

    const entities = await request(app).get(
      '/leadership/entities?status=escalated',
    );
    expect(entities.body.items.map(i => i.entity_name)).toEqual(['orphan-svc']);

    const stats = await request(app).get('/leadership/stats');
    expect(stats.body).toMatchObject({ isLeader: true, totalOpen: 1 });
  });

  it('returns nothing for a user with no team and no assigned escalation', async () => {
    const store = createStore();
    await seedEscalated(store, 'orphan-svc', { actorRef: 'user:default/bob' });
    await seedEscalated(store, 'finished', {
      actorRef: DIRECTOR_REF,
      entryStatus: 'completed',
    });

    const { app } = await buildApp(store, {
      userEntity: {
        kind: 'User',
        metadata: { name: 'alice', userDetails: { jobTitle: 'Engineer' } },
        spec: { memberOf: [CHAPTER_REF] },
      },
    });

    const entities = await request(app).get(
      '/leadership/entities?status=escalated',
    );
    expect(entities.body).toMatchObject({ items: [], total: 0 });

    const stats = await request(app).get('/leadership/stats');
    expect(stats.body).toMatchObject({ isLeader: false, totalOpen: 0 });
  });

  it('excludes escalations owned within the subtree but assigned to someone else', async () => {
    const store = createStore();
    await seedEscalated(store, 'routed-to-bob', {
      owner: SUB_TEAM_REF,
      actorRef: 'user:default/bob',
    });
    await seedEscalated(store, 'routed-to-me', {
      owner: 'group:default/elsewhere',
      actorRef: DIRECTOR_REF,
    });

    const { app } = await buildApp(store);
    const res = await request(app).get('/leadership/entities?status=escalated');

    expect(res.body.items.map(i => i.entity_name)).toEqual(['routed-to-me']);
  });

  it('keeps subtree scoping for non-escalated entities of a team leader (regression)', async () => {
    const store = createStore();
    await store.createEntity({
      entity_ref: 'c:d/mine',
      entity_name: 'mine',
      current_owner: TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/sub',
      entity_name: 'sub',
      current_owner: SUB_TEAM_REF,
    });
    await store.createEntity({
      entity_ref: 'c:d/other',
      entity_name: 'other',
      current_owner: 'group:default/other',
    });
    await seedEscalated(store, 'routed-to-me', { actorRef: DIRECTOR_REF });

    const { app } = await buildApp(store);

    const open = await request(app).get('/leadership/entities?status=open');
    expect(open.body.items.map(i => i.entity_name).sort()).toEqual([
      'mine',
      'sub',
    ]);

    const stats = await request(app).get('/leadership/stats');
    expect(stats.body).toMatchObject({ isLeader: true, totalOpen: 3 });
  });
});
