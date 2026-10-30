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
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import express from 'express';
import request from 'supertest';
import { createRouter } from './router';
import { OwnershipStore } from './service/DatabaseOwnershipStore';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';
import { OwnershipMatcherService } from './service/OwnershipMatcherService';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { EscalationService } from './escalation';

const USER_REF = 'user:default/mock';
const DIRECT_TEAM = 'group:default/team-child';
const PARENT_TEAM = 'group:default/team-parent';
const FOREIGN_TEAM = 'group:default/someone-else';

const escalationConfig = {
  levels: [
    {
      groupFilter: 'Group:domain',
      timeoutDays: 7,
      titlePatterns: ['^Director'],
    },
  ],
};

const entityRow = {
  id: 'e-1',
  entity_ref: 'component:default/svc',
  current_status: 'escalated',
  version: 1,
};

function buildStore() {
  return {
    getDashboardStats: jest.fn().mockResolvedValue({ totalOpen: 0 }),
    listAllProposals: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
    listProposalsForOwners: jest.fn().mockResolvedValue([]),
    getEntityById: jest.fn().mockResolvedValue(entityRow),
    listProposalsByEntity: jest.fn().mockResolvedValue([]),
    listHistory: jest.fn().mockResolvedValue([]),
    listEntities: jest
      .fn()
      .mockResolvedValue({ items: [], total: 0, page: 1, limit: 50 }),
    findActiveQueueEntry: jest.fn().mockResolvedValue(null),
  } as unknown as jest.Mocked<OwnershipStore>;
}

/**
 * Builds the router as a given caller sees it. `admin` controls the result of
 * the ownership-matcher admin permission; `ownershipEntityRefs` is what the
 * sign-in resolver put in the caller's token (transitive group refs).
 */
async function buildApp(opts: {
  admin: boolean;
  ownershipEntityRefs?: string[];
}) {
  const store = buildStore();
  const scanService = {
    runScan: jest.fn().mockResolvedValue({}),
    scanEntity: jest.fn(),
  } as unknown as jest.Mocked<OwnershipMatcherService>;
  const catalogService = {
    isUserMemberOfGroup: jest.fn().mockResolvedValue(false),
    getEntityByRef: jest
      .fn()
      .mockResolvedValue({ metadata: { name: 'svc' }, spec: {} }),
  } as unknown as jest.Mocked<CatalogService>;
  const ownershipEmailTask = { run: jest.fn().mockResolvedValue({}) };

  const router = await createRouter({
    httpAuth: mockServices.httpAuth(),
    userInfo: mockServices.userInfo(
      opts.ownershipEntityRefs
        ? { ownershipEntityRefs: opts.ownershipEntityRefs }
        : undefined,
    ),
    permissions: mockServices.permissions({
      result: opts.admin ? AuthorizeResult.ALLOW : AuthorizeResult.DENY,
    }),
    store,
    lifecycleService: {} as ProposalLifecycleService,
    scanService,
    catalogService,
    escalationConfig,
    escalationService: {} as EscalationService,
    escalationTrigger: { triggerEscalation: jest.fn() },
    checks: [],
    strategies: [],
    ownershipEmailTask: ownershipEmailTask as any,
  });
  const app = express().use(router).use(mockErrorHandler());
  return { app, store, scanService, ownershipEmailTask };
}

const unauthenticated = mockCredentials.none.header();

describe('admin-only endpoints', () => {
  it.each([
    ['get', '/entities', 200],
    ['get', '/stats', 200],
    ['get', '/proposals', 200],
    ['post', '/scans/trigger', 202],
    ['post', '/email-digest/trigger', 200],
    ['get', '/escalation/manager-chain?ref=component:default/svc', 200],
  ] as const)('%s %s: 401 / 403 / admin ok', async (method, path, okStatus) => {
    const { app: nonAdmin } = await buildApp({ admin: false });
    const { app: admin } = await buildApp({ admin: true });

    const anon = await request(nonAdmin)
      [method](path)
      .set('Authorization', unauthenticated);
    expect(anon.status).toBe(401);

    expect((await request(nonAdmin)[method](path)).status).toBe(403);
    expect((await request(admin)[method](path)).status).toBe(okStatus);
  });

  it('does not start a scan or send emails for a non-admin', async () => {
    const { app, scanService, ownershipEmailTask } = await buildApp({
      admin: false,
    });
    await request(app).post('/scans/trigger');
    await request(app).post('/email-digest/trigger');
    expect(scanService.runScan).not.toHaveBeenCalled();
    expect(ownershipEmailTask.run).not.toHaveBeenCalled();
  });
});

describe.each(['/entities/e-1', '/entities/e-1/proposals'])(
  'GET %s (admins and involved users only)',
  path => {
    it('allows admins', async () => {
      const { app } = await buildApp({ admin: true });
      expect((await request(app).get(path)).status).toBe(200);
    });

    it('allows the current escalation actor', async () => {
      const { app, store } = await buildApp({ admin: false });
      store.findActiveQueueEntry.mockResolvedValue({
        resolved_actor_ref: USER_REF,
      } as any);
      expect((await request(app).get(path)).status).toBe(200);
    });

    it('allows members of the assigned team', async () => {
      const { app, store } = await buildApp({
        admin: false,
        ownershipEntityRefs: [USER_REF, DIRECT_TEAM],
      });
      store.getEntityById.mockResolvedValue({
        ...entityRow,
        assigned_to: DIRECT_TEAM,
      } as any);
      expect((await request(app).get(path)).status).toBe(200);
    });

    it('allows a nested-team user whose parent group has a proposal', async () => {
      const { app, store } = await buildApp({
        admin: false,
        ownershipEntityRefs: [USER_REF, DIRECT_TEAM, PARENT_TEAM],
      });
      store.listProposalsByEntity.mockResolvedValue([
        { id: 'p-1', proposed_owner_ref: 'group:default/Team-Parent' },
      ] as any);
      expect((await request(app).get(path)).status).toBe(200);
    });

    it('rejects uninvolved users (e.g. guest) with 403', async () => {
      const { app, store } = await buildApp({
        admin: false,
        ownershipEntityRefs: ['user:development/guest'],
      });
      store.getEntityById.mockResolvedValue({
        ...entityRow,
        assigned_to: FOREIGN_TEAM,
      } as any);
      store.listProposalsByEntity.mockResolvedValue([
        { id: 'p-1', proposed_owner_ref: FOREIGN_TEAM },
      ] as any);
      store.findActiveQueueEntry.mockResolvedValue({
        resolved_actor_ref: 'user:default/director',
      } as any);
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(store.listHistory).not.toHaveBeenCalled();
    });

    // Unauthenticated access is rejected by the backend credential barrier,
    // asserted in plugin.test.ts.
  },
);

describe('GET /proposals/for-team', () => {
  const query = (...refs: string[]) =>
    `/proposals/for-team?${refs
      .map(r => `teamRef=${encodeURIComponent(r)}`)
      .join('&')}`;

  it('rejects unauthenticated callers', async () => {
    const { app } = await buildApp({ admin: false });
    const res = await request(app)
      .get(query(DIRECT_TEAM))
      .set('Authorization', unauthenticated);
    expect(res.status).toBe(401);
  });

  it('keeps transitive parent groups for a user in a nested team', async () => {
    // The UI sends identity.ownershipEntityRefs, which includes parent groups
    // the user is not a direct `memberOf`. Those must not be filtered out.
    const { app, store } = await buildApp({
      admin: false,
      ownershipEntityRefs: [USER_REF, DIRECT_TEAM, PARENT_TEAM],
    });
    const res = await request(app).get(query(DIRECT_TEAM, PARENT_TEAM));
    expect(res.status).toBe(200);
    expect(store.listProposalsForOwners).toHaveBeenCalledWith(
      [DIRECT_TEAM, PARENT_TEAM],
      ['pending'],
    );
  });

  it('drops team refs the caller does not belong to', async () => {
    const { app, store } = await buildApp({
      admin: false,
      ownershipEntityRefs: [USER_REF, DIRECT_TEAM],
    });
    const res = await request(app).get(query(DIRECT_TEAM, FOREIGN_TEAM));
    expect(res.status).toBe(200);
    expect(store.listProposalsForOwners).toHaveBeenCalledWith(
      [DIRECT_TEAM],
      ['pending'],
    );
  });

  it('matches team refs case-insensitively', async () => {
    const { app, store } = await buildApp({
      admin: false,
      ownershipEntityRefs: [USER_REF, DIRECT_TEAM],
    });
    await request(app).get(query('group:default/Team-Child'));
    expect(store.listProposalsForOwners).toHaveBeenCalledWith(
      ['group:default/Team-Child'],
      ['pending'],
    );
  });

  it('returns no items without querying when every requested ref is foreign', async () => {
    const { app, store } = await buildApp({
      admin: false,
      ownershipEntityRefs: [USER_REF, DIRECT_TEAM],
    });
    const res = await request(app).get(query(FOREIGN_TEAM));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
    expect(store.listProposalsForOwners).not.toHaveBeenCalled();
  });

  it('lets admins query any team', async () => {
    const { app, store } = await buildApp({
      admin: true,
      ownershipEntityRefs: [USER_REF],
    });
    await request(app).get(query(FOREIGN_TEAM));
    expect(store.listProposalsForOwners).toHaveBeenCalledWith(
      [FOREIGN_TEAM],
      ['pending'],
    );
  });
});
