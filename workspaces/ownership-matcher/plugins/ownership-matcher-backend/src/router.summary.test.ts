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

const mockEscalationTrigger = {
  triggerEscalation: jest.fn().mockResolvedValue(undefined),
};

const mockLifecycle = {} as jest.Mocked<ProposalLifecycleService>;
const mockScanService = {
  runScan: jest.fn().mockResolvedValue({}),
} as unknown as jest.Mocked<OwnershipMatcherService>;
const mockCatalogService = {
  isUserMemberOfGroup: jest.fn().mockResolvedValue(true),
} as unknown as jest.Mocked<CatalogService>;

function buildStore(
  perOwner: Record<string, string[]> = {},
): jest.Mocked<OwnershipStore> {
  return {
    listPendingProposalIdsForOwner: jest.fn(async (ownerRef: string) => {
      return perOwner[ownerRef] ?? [];
    }),
  } as unknown as jest.Mocked<OwnershipStore>;
}

async function buildApp(
  store: OwnershipStore,
  userInfo = mockServices.userInfo(),
) {
  const router = await createRouter({
    httpAuth: mockServices.httpAuth(),
    userInfo,
    store,
    lifecycleService: mockLifecycle,
    scanService: mockScanService,
    catalogService: mockCatalogService,
    escalationTrigger: mockEscalationTrigger as any,
    checks: [],
    strategies: [],
  });
  return express().use(router).use(mockErrorHandler());
}

describe('GET /proposals/mine/summary', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns pendingCount, link and a stable hash for a user with pending proposals across two groups', async () => {
    const userInfo = mockServices.userInfo({
      ownershipEntityRefs: [
        'user:default/jane',
        'group:default/team-a',
        'group:default/team-b',
      ],
    });
    const store = buildStore({
      'group:default/team-a': ['p1', 'p3'],
      'group:default/team-b': ['p2'],
    });
    const app = await buildApp(store, userInfo);

    const res = await request(app).get('/proposals/mine/summary');
    expect(res.status).toBe(200);
    expect(res.body.pendingCount).toBe(3);
    expect(res.body.link).toBe('/my-ownership-proposals');
    expect(res.body.hash).toMatch(/^[a-f0-9]{12}$/);

    // Stable: same data, same hash on repeat
    const res2 = await request(app).get('/proposals/mine/summary');
    expect(res2.body.hash).toBe(res.body.hash);
  });

  it('deduplicates proposal IDs that appear under more than one group', async () => {
    const userInfo = mockServices.userInfo({
      ownershipEntityRefs: ['group:default/team-a', 'group:default/team-b'],
    });
    // p1 appears under both groups — should only be counted once.
    const store = buildStore({
      'group:default/team-a': ['p1', 'p2'],
      'group:default/team-b': ['p1', 'p3'],
    });
    const app = await buildApp(store, userInfo);

    const res = await request(app).get('/proposals/mine/summary');
    expect(res.status).toBe(200);
    expect(res.body.pendingCount).toBe(3);
  });

  it('returns pendingCount=0 when the user has groups but none have pending proposals', async () => {
    const userInfo = mockServices.userInfo({
      ownershipEntityRefs: ['user:default/jane', 'group:default/team-a'],
    });
    const store = buildStore({ 'group:default/team-a': [] });
    const app = await buildApp(store, userInfo);

    const res = await request(app).get('/proposals/mine/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pendingCount: 0,
      link: '/my-ownership-proposals',
      hash: '',
    });
  });

  it('returns pendingCount=0 when the user has no groups (empty ownershipEntityRefs)', async () => {
    const userInfo = mockServices.userInfo({ ownershipEntityRefs: [] });
    const store = buildStore();
    const app = await buildApp(store, userInfo);

    const res = await request(app).get('/proposals/mine/summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pendingCount: 0,
      link: '/my-ownership-proposals',
      hash: '',
    });
    // Confirms the short-circuit before any store call.
    expect(store.listPendingProposalIdsForOwner).not.toHaveBeenCalled();
  });

  it('only queries group refs and ignores user/other refs', async () => {
    const userInfo = mockServices.userInfo({
      ownershipEntityRefs: [
        'user:default/jane',
        'group:default/team-a',
        'component:default/foo',
      ],
    });
    const store = buildStore({ 'group:default/team-a': ['p1'] });
    const app = await buildApp(store, userInfo);

    const res = await request(app).get('/proposals/mine/summary');
    expect(res.status).toBe(200);
    expect(res.body.pendingCount).toBe(1);
    expect(store.listPendingProposalIdsForOwner).toHaveBeenCalledTimes(1);
    expect(store.listPendingProposalIdsForOwner).toHaveBeenCalledWith(
      'group:default/team-a',
    );
  });

  it('returns 401 for unauthenticated requests', async () => {
    const store = buildStore();
    const app = await buildApp(store);

    const res = await request(app)
      .get('/proposals/mine/summary')
      .set('Authorization', mockCredentials.none.header());
    expect(res.status).toBe(401);
  });
});
