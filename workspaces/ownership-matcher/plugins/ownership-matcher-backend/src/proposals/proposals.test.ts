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

import { FallbackStrategy } from './FallbackStrategy';
import { OrgProximityStrategy } from './OrgProximityStrategy';
import { TopContributorStrategy } from './TopContributorStrategy';
import { ProposalStrategyContext } from './types';
import { CatalogComponent } from '../types';
import { mockServices } from '@backstage/backend-test-utils';
import { ScmError } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

function makeCtx(
  entity: Partial<CatalogComponent>,
  rejectedActors: string[] = [],
): ProposalStrategyContext {
  return {
    entity: {
      kind: 'Component',
      metadata: { name: 'test-service', namespace: 'default' },
      ...entity,
    },
    repo: undefined,
    currentCheck: 'orphaned',
    currentOwner: undefined,
    rejectedActors: new Set(rejectedActors),
  };
}

// ─── FallbackStrategy ─────────────────────────────────────────────────────────

describe('FallbackStrategy', () => {
  it('returns empty array when action is escalated', async () => {
    const strategy = new FallbackStrategy('escalated');
    const candidates = await strategy.findCandidates(makeCtx({}));
    expect(candidates).toEqual([]);
    expect(strategy.triggersEscalation).toBe(true);
  });

  it('returns the fixed owner when action is fixed-owner', async () => {
    const strategy = new FallbackStrategy(
      'fixed-owner',
      'group:default/platform-team',
    );
    const candidates = await strategy.findCandidates(makeCtx({}));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownerRef).toBe('group:default/platform-team');
    expect(candidates[0].confidenceReason).toEqual(['fallback']);
  });

  it('returns empty when fixed owner is rejected', async () => {
    const strategy = new FallbackStrategy(
      'fixed-owner',
      'group:default/platform-team',
    );
    const candidates = await strategy.findCandidates(
      makeCtx({}, ['group:default/platform-team']),
    );
    expect(candidates).toEqual([]);
  });

  it('triggersEscalation is false for fixed-owner strategy', () => {
    const strategy = new FallbackStrategy(
      'fixed-owner',
      'group:default/platform-team',
    );
    expect(strategy.triggersEscalation).toBe(false);
  });
});

// ─── OrgProximityStrategy ────────────────────────────────────────────────────

describe('OrgProximityStrategy', () => {
  const logger = mockServices.logger.mock();

  it('returns system owner as candidate when system is set', async () => {
    const mockCatalogService = {
      getEntityByRef: jest.fn().mockResolvedValueOnce({
        kind: 'System',
        metadata: { name: 'my-system' },
        spec: { owner: 'group:default/system-team' },
      }),
    } as any;

    const strategy = new OrgProximityStrategy(mockCatalogService, logger);
    const candidates = await strategy.findCandidates(
      makeCtx({ spec: { system: 'my-system' } }),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownerRef).toBe('group:default/system-team');
    expect(candidates[0].confidenceReason).toEqual(['org_proximity_system']);
  });

  it('returns empty when system has no owner', async () => {
    const mockCatalogService = {
      getEntityByRef: jest.fn().mockResolvedValueOnce({
        kind: 'System',
        metadata: { name: 'sys' },
        spec: {},
      }),
    } as any;

    const strategy = new OrgProximityStrategy(mockCatalogService, logger);
    const candidates = await strategy.findCandidates(
      makeCtx({ spec: { system: 'my-system' } }),
    );

    expect(candidates).toHaveLength(0);
  });

  it('excludes rejected actors from candidates', async () => {
    const mockCatalogService = {
      getEntityByRef: jest.fn().mockResolvedValueOnce({
        kind: 'System',
        metadata: { name: 'my-system' },
        spec: { owner: 'group:default/system-team' },
      }),
    } as any;

    const strategy = new OrgProximityStrategy(mockCatalogService, logger);
    const candidates = await strategy.findCandidates(
      makeCtx({ spec: { system: 'my-system' } }, ['group:default/system-team']),
    );

    expect(candidates).toHaveLength(0);
  });

  it('propagates a catalog lookup failure instead of returning empty', async () => {
    const mockCatalogService = {
      getEntityByRef: jest.fn().mockRejectedValue(new Error('catalog timeout')),
    } as any;
    const strategy = new OrgProximityStrategy(mockCatalogService, logger);

    await expect(
      strategy.findCandidates(makeCtx({ spec: { system: 'my-system' } })),
    ).rejects.toThrow('catalog timeout');
  });

  it('returns empty when the system entity does not exist', async () => {
    const mockCatalogService = {
      getEntityByRef: jest.fn().mockResolvedValue(undefined),
    } as any;
    const strategy = new OrgProximityStrategy(mockCatalogService, logger);

    await expect(
      strategy.findCandidates(makeCtx({ spec: { system: 'my-system' } })),
    ).resolves.toEqual([]);
  });

  it('returns empty when entity has no system or domain', async () => {
    const mockCatalogService = { getEntityByRef: jest.fn() } as any;
    const strategy = new OrgProximityStrategy(mockCatalogService, logger);
    const candidates = await strategy.findCandidates(makeCtx({ spec: {} }));
    expect(candidates).toHaveLength(0);
    expect(mockCatalogService.getEntityByRef).not.toHaveBeenCalled();
  });
});

// ─── TopContributorStrategy ─────────────────────────────────────────────────

describe('TopContributorStrategy', () => {
  const logger = mockServices.logger.mock();

  const REPO = {
    type: 'bitbucketServer',
    host: 'bb.example.com',
    path: 'PROJ/repo',
    webUrl: 'https://bb.example.com/projects/PROJ/repos/repo',
  };

  /** Fake ScmRegistry whose client serves `commits` via the history capability. */
  function makeScm(
    commits: Array<{ email: string; name: string }>,
    opts: {
      repoFromLocation?: typeof REPO;
      noClient?: boolean;
      noHistory?: boolean;
    } = {},
  ) {
    const history = {
      getCommits: jest.fn().mockResolvedValue(
        commits.map(c => ({
          id: `sha-${c.name}`,
          author: { email: c.email, name: c.name },
        })),
      ),
    };
    const client = {
      parseLocation: jest.fn(),
      ...(opts.noHistory ? {} : { history }),
    };
    return {
      history,
      forLocation: jest.fn().mockResolvedValue(
        opts.repoFromLocation
          ? {
              status: 'ok',
              client,
              location: {
                repo: opts.repoFromLocation,
                path: 'catalog-info.yaml',
              },
            }
          : { status: 'missing' },
      ),
      clientFor: jest
        .fn()
        .mockResolvedValue(opts.noClient ? undefined : client),
    } as any;
  }

  function makeContributorService(
    mapping: Record<string, string[]>,
    bots: string[] = [],
  ) {
    return {
      isBot: jest
        .fn()
        .mockImplementation((email: string) => bots.includes(email)),
      getContributorInfo: jest
        .fn()
        .mockImplementation(async (email: string) => {
          if (bots.includes(email)) return null;
          const teams = mapping[email];
          if (!teams) return null;
          return { email, teams };
        }),
    } as any;
  }

  // 2.1.1 — returns teams ranked by commit frequency
  it('returns teams ranked by commit frequency', async () => {
    const scm = makeScm([
      { email: 'alice@example.com', name: 'alice' },
      { email: 'alice@example.com', name: 'alice' },
      { email: 'alice@example.com', name: 'alice' },
      { email: 'bob@example.com', name: 'bob' },
    ]);
    const contributor = makeContributorService({
      'alice@example.com': ['team-a'],
      'bob@example.com': ['team-b'],
    });

    const strategy = new TopContributorStrategy(scm, contributor, logger, 3);
    const ctx = makeCtx({
      metadata: {
        name: 'svc',
        namespace: 'default',
        annotations: {
          'backstage.io/managed-by-location':
            'http://bb/projects/PROJ/repos/repo/browse',
        },
      },
    });
    ctx.repo = REPO;

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(2);
    // team-a has 3 commits, team-b has 1 — team-a should be first.
    expect(candidates[0].ownerRef).toBe('group:default/team-a');
    expect(candidates[1].ownerRef).toBe('group:default/team-b');
    expect(candidates[0].confidenceScore).toBeGreaterThan(
      candidates[1].confidenceScore,
    );
  });

  // 2.1.2 — bot emails are excluded
  it('excludes bot emails from contributor analysis', async () => {
    const scm = makeScm([
      { email: 'bot@example.com', name: 'bot' },
      { email: 'bot@example.com', name: 'bot' },
      { email: 'alice@example.com', name: 'alice' },
    ]);
    const contributor = makeContributorService(
      { 'alice@example.com': ['team-a'] },
      ['bot@example.com'],
    );

    const strategy = new TopContributorStrategy(scm, contributor, logger, 3);
    const ctx = makeCtx({});
    ctx.repo = REPO;

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownerRef).toBe('group:default/team-a');
  });

  // 2.1.3 — bot username patterns are excluded (via ContributorService.isBot)
  it('excludes bot username patterns from contributor analysis', async () => {
    const scm = makeScm([
      { email: 'deploy-bot@ci.internal', name: 'deploy-bot' },
      { email: 'alice@example.com', name: 'alice' },
    ]);
    const contributor = makeContributorService(
      { 'alice@example.com': ['team-a'] },
      ['deploy-bot@ci.internal'],
    );

    const strategy = new TopContributorStrategy(scm, contributor, logger, 3);
    const ctx = makeCtx({});
    ctx.repo = REPO;

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownerRef).toBe('group:default/team-a');
  });

  // 2.1.4 — respects maxCandidates
  it('respects maxCandidates limit', async () => {
    const scm = makeScm([
      { email: 'a@x.com', name: 'a' },
      { email: 'b@x.com', name: 'b' },
      { email: 'c@x.com', name: 'c' },
    ]);
    const contributor = makeContributorService({
      'a@x.com': ['team-a'],
      'b@x.com': ['team-b'],
      'c@x.com': ['team-c'],
    });

    const strategy = new TopContributorStrategy(scm, contributor, logger, 2);
    const ctx = makeCtx({});
    ctx.repo = REPO;

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(2);
  });

  // 2.1.5 — entity with no repo (none in ctx, none resolvable) returns empty
  it('returns empty when entity has no repo', async () => {
    const scm = makeScm([]);
    const contributor = makeContributorService({});

    const strategy = new TopContributorStrategy(scm, contributor, logger, 3);
    const ctx = makeCtx({});
    // No repo in ctx and none resolvable from the location

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(0);
  });

  // 2.1.6 — rejected actors are excluded
  it('excludes rejected actors from results', async () => {
    const scm = makeScm([
      { email: 'alice@example.com', name: 'alice' },
      { email: 'bob@example.com', name: 'bob' },
    ]);
    const contributor = makeContributorService({
      'alice@example.com': ['team-a'],
      'bob@example.com': ['team-b'],
    });

    const strategy = new TopContributorStrategy(scm, contributor, logger, 3);
    const ctx = makeCtx({}, ['group:default/team-a']);
    ctx.repo = REPO;

    const candidates = await strategy.findCandidates(ctx);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].ownerRef).toBe('group:default/team-b');
  });

  it('resolves the repo from managed-by-location when the ctx has none (retrigger path)', async () => {
    const scm = makeScm([{ email: 'alice@example.com', name: 'alice' }], {
      repoFromLocation: REPO,
    });
    const contributor = makeContributorService({
      'alice@example.com': ['team-a'],
    });
    const strategy = new TopContributorStrategy(
      scm,
      contributor,
      logger,
      3,
      10,
    );
    const location =
      'url:https://bb.example.com/projects/PROJ/repos/repo/browse/catalog-info.yaml';
    const ctx = makeCtx({
      metadata: {
        name: 'svc',
        namespace: 'default',
        annotations: { 'backstage.io/managed-by-location': location },
      },
    });

    const candidates = await strategy.findCandidates(ctx);

    expect(scm.forLocation).toHaveBeenCalledWith(location);
    expect(scm.history.getCommits).toHaveBeenCalledWith(REPO, { limit: 10 });
    expect(candidates.map(c => c.ownerRef)).toEqual(['group:default/team-a']);
  });

  it('returns empty when no SCM provider serves the repo host', async () => {
    const scm = makeScm([{ email: 'alice@example.com', name: 'alice' }], {
      noClient: true,
    });
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({ 'alice@example.com': ['team-a'] }),
      logger,
    );
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).resolves.toEqual([]);
  });

  it('returns empty when the provider has no history capability', async () => {
    const scm = makeScm([{ email: 'alice@example.com', name: 'alice' }], {
      noHistory: true,
    });
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({ 'alice@example.com': ['team-a'] }),
      logger,
    );
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).resolves.toEqual([]);
    expect(scm.history.getCommits).not.toHaveBeenCalled();
  });

  // A transport failure must not read as "no contributors" — the caller would
  // escalate the case to unresolved on a transient blip.
  it('propagates a commit-history failure instead of returning empty', async () => {
    const scm = makeScm([]);
    scm.history.getCommits.mockRejectedValue(new Error('boom'));
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({}),
      logger,
    );
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).rejects.toThrow('boom');
  });

  // A missing/expired token affects every entity on the host; returning []
  // would mass-escalate. Only a permanent not-found reads as "nothing to look at".
  it('propagates an SCM auth failure instead of returning empty', async () => {
    const scm = makeScm([]);
    scm.history.getCommits.mockRejectedValue(
      new ScmError('auth', 'token expired', { httpStatus: 401 }),
    );
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({}),
      logger,
    );
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).rejects.toThrow('token expired');
  });

  it('returns empty when the repo no longer exists (SCM not-found)', async () => {
    const scm = makeScm([]);
    scm.history.getCommits.mockRejectedValue(
      new ScmError('not-found', 'repo gone', { httpStatus: 404 }),
    );
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({}),
      logger,
    );
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).resolves.toEqual([]);
  });

  it('propagates a provider-client failure while resolving the repo', async () => {
    const scm = makeScm([]);
    scm.forLocation.mockRejectedValue(new Error('client creation failed'));
    const strategy = new TopContributorStrategy(
      scm,
      makeContributorService({}),
      logger,
    );
    const ctx = makeCtx({
      metadata: {
        name: 'svc',
        namespace: 'default',
        annotations: {
          'backstage.io/managed-by-location': 'url:https://bb.example.com/x',
        },
      },
    });

    await expect(strategy.findCandidates(ctx)).rejects.toThrow(
      'client creation failed',
    );
  });

  it('propagates a contributor lookup failure', async () => {
    const scm = makeScm([{ email: 'alice@example.com', name: 'alice' }]);
    const contributor = makeContributorService({});
    contributor.getContributorInfo.mockRejectedValue(
      new Error('user data unavailable'),
    );
    const strategy = new TopContributorStrategy(scm, contributor, logger);
    const ctx = makeCtx({});
    ctx.repo = REPO;

    await expect(strategy.findCandidates(ctx)).rejects.toThrow(
      'user data unavailable',
    );
  });
});
