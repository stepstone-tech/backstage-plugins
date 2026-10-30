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

import { mockServices } from '@backstage/backend-test-utils';
import { ConflictError } from '@backstage/errors';
import {
  ScmError,
  type ScmPullRequestCapability,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import type { ScmLocationResolution } from '../scm';
import { OwnershipStore } from '../service/DatabaseOwnershipStore';
import { PendingDeadlineRow } from '../escalation/types';
import {
  CatalogComponent,
  OwnershipEntityRow,
  OwnershipProposalRow,
} from '../types';
import { TestClock } from '../escalation/__fixtures__/Clock';
import { EntityValidator } from './EntityValidator';
import {
  PR_JOB_LEASE_MS,
  PR_RETRY_BACKOFF_MS,
  PrCatalog,
  PR_READ_ONLY_BACKOFF_MS,
  PrCreationService,
  PrScm,
  branchNameFor,
} from './PrCreationService';

const NOW = new Date('2026-10-01T10:00:00Z');
const LOCATION =
  'url:https://repo.example.com/projects/PROJ/repos/my-repo/browse/catalog-info.yaml';
const CATALOG_INFO = [
  'apiVersion: backstage.io/v1alpha1',
  'kind: Component',
  'metadata:',
  '  name: my-service',
  'spec:',
  '  type: service',
  '  owner: group:old-team # previous owner',
  '  lifecycle: production',
  '',
].join('\n');

function makeEntity(
  overrides: Partial<OwnershipEntityRow> = {},
): OwnershipEntityRow {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    entity_ref: 'component:default/my-service',
    entity_name: 'my-service',
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: NOW,
    last_scanned_at: NOW,
    current_status: 'accepted',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    scm_type: 'bitbucketServer',
    repo_host: 'repo.example.com',
    repo_path: 'PROJ/my-repo',
    resolved_by: 'user:default/jane.doe',
    resolved_at: null,
    resolution_type: 'ownership_changed',
    accepted_at: NOW,
    assigned_to: 'group:default/new-team',
    pr_status: 'pending',
    pr_url: null,
    pr_branch: null,
    pr_attempts: 0,
    pr_last_error: null,
    pr_id: null,
    pr_checked_at: null,
    version: 2,
    ...overrides,
  };
}

function makeProposal(
  overrides: Partial<OwnershipProposalRow> = {},
): OwnershipProposalRow {
  return {
    id: 'prop-1',
    entity_id: makeEntity().id,
    proposed_owner_ref: 'group:default/new-team',
    proposed_owner_type: 'Group',
    confidence_reason: 'top contributor',
    confidence_score: 0.9,
    proposal_order: 1,
    status: 'accepted',
    escalation_level: 0,
    notified_at: NOW,
    responded_at: NOW,
    response_note: null,
    created_at: NOW,
    ...overrides,
  };
}

function makeDeadline(
  overrides: Partial<PendingDeadlineRow> = {},
): PendingDeadlineRow {
  return {
    id: 'dl-1',
    entity_id: makeEntity().id,
    proposal_id: 'prop-1',
    deadline_type: 'pr_creation',
    fire_at: NOW,
    actor_ref: 'user:default/jane.doe',
    escalation_level: null,
    processed: true,
    processed_at: NOW,
    created_at: NOW,
    ...overrides,
  };
}

/** Minimal in-memory store: one entity, its proposals, and recorders for writes. */
function makeStore(
  entity: OwnershipEntityRow,
  proposals: OwnershipProposalRow[] = [makeProposal()],
) {
  const state = {
    entity: { ...entity },
    history: [] as Array<Record<string, any>>,
    deadlines: [] as Array<Record<string, any>>,
    cancelled: [] as Array<{ entityId: string; types?: string[] }>,
    claimable: new Set<string>(),
    leases: [] as Array<{ id: string; now: Date; leaseUntil: Date }>,
    processed: [] as string[],
    /** Deadline ids whose lease was lost (cancelled / re-leased) — completeLease returns false. */
    superseded: new Set<string>(),
    locks: [] as string[],
  };
  const tx = {
    entityStore: {
      getEntityById: async (id: string) =>
        id === state.entity.id ? { ...state.entity } : undefined,
      getEntityByIdForUpdate: async (id: string) => {
        state.locks.push(`entity:${id}`);
        return id === state.entity.id ? { ...state.entity } : undefined;
      },
      updatePrState: async (
        _id: string,
        patch: Partial<OwnershipEntityRow>,
      ) => {
        Object.assign(state.entity, patch);
      },
    },
    historyStore: {
      appendHistory: async (h: Record<string, any>) => {
        state.history.push(h);
      },
    },
    proposalStore: {
      listProposalsByEntity: async () => proposals,
    },
    pendingDeadlineStore: {
      writeDeadline: async (d: Record<string, any>) => {
        state.deadlines.push(d);
        return `dl-${state.deadlines.length + 1}`;
      },
      cancelDeadlinesForEntity: async (entityId: string, types?: string[]) => {
        state.cancelled.push({ entityId, types });
        return 0;
      },
      leaseDeadline: async (id: string, now: Date, leaseUntil: Date) => {
        if (!state.claimable.delete(id)) return undefined;
        state.leases.push({ id, now, leaseUntil });
        return makeDeadline({
          id,
          processed: false,
          processed_at: null,
          fire_at: leaseUntil,
        });
      },
      completeLease: async (id: string) => {
        if (state.superseded.has(id)) return false;
        state.processed.push(id);
        return true;
      },
      isLeaseHeld: async (id: string) => !state.superseded.has(id),
      lockUnprocessedForEntity: async (entityId: string) => {
        state.locks.push(`deadlines:${entityId}`);
      },
    },
  };
  const store = {
    getEntityById: async (id: string) =>
      id === state.entity.id ? { ...state.entity } : undefined,
    getProposal: async (id: string) => proposals.find(p => p.id === id),
    findExpiredDeadlines: jest.fn(async () => [] as PendingDeadlineRow[]),
    withTransaction: async (fn: (t: any) => Promise<any>) => fn(tx),
  } as unknown as OwnershipStore;
  return { store, state };
}

const REPO: ScmRepoRef = {
  type: 'bitbucketServer',
  host: 'repo.example.com',
  path: 'PROJ/my-repo',
  webUrl: 'https://repo.example.com/projects/PROJ/repos/my-repo',
};

function makePrs(
  overrides: Partial<Record<keyof ScmPullRequestCapability, jest.Mock>> = {},
): jest.Mocked<ScmPullRequestCapability> {
  return {
    getDefaultBranch: jest.fn(async () => 'master'),
    readFile: jest.fn(async () => ({
      content: CATALOG_INFO,
      revision: 'c0ffee',
    })),
    commitFile: jest.fn(async () => undefined),
    createBranch: jest.fn(async () => 'created' as const),
    findOpenPullRequest: jest.fn(async () => undefined),
    createPullRequest: jest.fn(async () => ({
      status: 'created' as const,
      pr: { id: '42', url: 'https://repo/pr/42' },
    })),
    resolveReviewer: jest.fn(async () => 'jdoe'),
    getDefaultReviewers: jest.fn(async () => [] as string[]),
    updatePullRequest: jest.fn(async () => 'unchanged' as const),
    ...overrides,
  } as unknown as jest.Mocked<ScmPullRequestCapability>;
}

/** A mock that rejects with an {@link ScmError}. */
function scmFailure(
  kind: ScmError['kind'],
  message = 'boom',
  httpStatus?: number,
) {
  return jest.fn(async () => {
    throw new ScmError(kind, message, { httpStatus });
  });
}

/**
 * Fake registry: routes any `url:` location to a Bitbucket-like client backed
 * by `prs`, honouring `?at=refs/heads/<branch>`. `resolution` overrides it.
 */
function makeScm(
  prs: ScmPullRequestCapability | undefined,
  resolution?: ScmLocationResolution,
): jest.Mocked<PrScm> {
  return {
    forLocation: jest.fn(
      async (loc: string | undefined): Promise<ScmLocationResolution> => {
        if (resolution) return resolution;
        if (!loc) return { status: 'missing' };
        const url = new URL(loc.replace(/^url:/, ''));
        const at = url.searchParams.get('at');
        return {
          status: 'ok',
          client: {
            parseLocation: jest.fn(),
            ...(prs ? { pullRequests: prs } : {}),
          },
          location: {
            repo: REPO,
            path: 'catalog-info.yaml',
            ...(at ? { ref: at.replace(/^refs\/heads\//, '') } : {}),
          },
        };
      },
    ),
  };
}

function makeCatalog(
  annotation: string | null = LOCATION,
): jest.Mocked<PrCatalog> {
  return {
    getEntityByRef: jest.fn(async (ref: string): Promise<CatalogComponent> => {
      if (ref.startsWith('user:')) {
        return {
          kind: 'User',
          metadata: { name: 'jane.doe', namespace: 'default' },
          spec: { profile: { email: 'jane.doe@example.com' } },
        };
      }
      return {
        kind: 'Component',
        metadata: {
          name: 'my-service',
          namespace: 'default',
          annotations: annotation
            ? { 'backstage.io/managed-by-location': annotation }
            : {},
        },
      };
    }),
  };
}

const validValidator: EntityValidator = {
  validate: jest.fn(async () => ({ status: 'valid' as const })),
};

function makeService(
  opts: {
    entity?: OwnershipEntityRow;
    proposals?: OwnershipProposalRow[];
    prs?: jest.Mocked<ScmPullRequestCapability>;
    scm?: jest.Mocked<PrScm>;
    catalog?: jest.Mocked<PrCatalog>;
    validator?: EntityValidator;
    maxAttempts?: number;
    appTitle?: string;
  } = {},
) {
  const { store, state } = makeStore(
    opts.entity ?? makeEntity(),
    opts.proposals,
  );
  const prs = opts.prs ?? makePrs();
  const scm = opts.scm ?? makeScm(prs);
  const catalog = opts.catalog ?? makeCatalog();
  const clock = new TestClock(NOW);
  const service = new PrCreationService(
    store,
    scm,
    catalog,
    opts.validator ?? validValidator,
    clock,
    mockServices.logger.mock(),
    { maxAttempts: opts.maxAttempts ?? 5, appTitle: opts.appTitle },
  );
  return { service, state, prs, scm, catalog, store };
}

describe('PrCreationService.run', () => {
  it('reads, edits, validates, branches, commits and opens a PR with the acceptor as reviewer', async () => {
    const validator: EntityValidator = {
      validate: jest.fn(async () => ({ status: 'valid' as const })),
    };
    const { service, state, prs } = makeService({ validator });

    await service.run(makeDeadline());

    const branch = branchNameFor(makeEntity());
    expect(prs.readFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      'master',
    );
    expect(validator.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({ owner: 'new-team' }),
      }),
      LOCATION,
    );
    expect(prs.createBranch).toHaveBeenCalledWith(REPO, branch, 'master');
    expect(prs.commitFile).toHaveBeenCalledWith(REPO, 'catalog-info.yaml', {
      content: CATALOG_INFO.replace('group:old-team', 'new-team'),
      message: 'chore(ownership): set spec.owner to new-team',
      branch,
      revision: 'c0ffee',
    });
    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({
        fromBranch: branch,
        toBranch: 'master',
        reviewers: ['jdoe'],
      }),
    );
    expect(state.entity).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/42',
      pr_id: '42',
      pr_branch: branch,
      pr_last_error: null,
      pr_checked_at: null,
    });
    expect(state.history).toEqual([
      expect.objectContaining({
        action: 'pr_raised',
        details: expect.objectContaining({ prId: '42' }),
      }),
    ]);
  });

  it.each([
    ['app.title', 'Dev Portal', 'in Dev Portal.'],
    ['Backstage by default', undefined, 'in Backstage.'],
  ])('PR description names %s', async (_, appTitle, expected) => {
    const { service, prs } = makeService({ appTitle });

    await service.run(makeDeadline());

    expect(prs.createPullRequest.mock.calls[0][1].description).toContain(
      expected,
    );
  });

  it('PR description does not link to the admin-only ownership-matcher page', async () => {
    const { service, prs } = makeService();

    await service.run(makeDeadline());

    const { description } = prs.createPullRequest.mock.calls[0][1];
    expect(description).toContain('component:default/my-service');
    expect(description).not.toMatch(/ownership-matcher\/entities|Details:/);
  });

  it('uses the branch from the location ?at= instead of the default branch', async () => {
    const prs = makePrs();
    const { service } = makeService({
      prs,
      catalog: makeCatalog(`${LOCATION}?at=refs%2Fheads%2Fdevelop`),
    });

    await service.run(makeDeadline());

    expect(prs.getDefaultBranch).not.toHaveBeenCalled();
    expect(prs.readFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      'develop',
    );
  });

  it('reuses an existing open PR instead of opening a second one', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async (_repo: ScmRepoRef, branch: string) =>
        branch === 'ownership/custom'
          ? { id: '7', url: 'https://repo/pr/7' }
          : undefined,
      ),
    });
    const { service, state } = makeService({
      prs,
      entity: makeEntity({ pr_branch: 'ownership/custom' }),
    });

    await service.run(makeDeadline());

    expect(prs.readFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      'ownership/custom',
    );
    expect(prs.commitFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      expect.objectContaining({ branch: 'ownership/custom' }),
    );
    expect(prs.createBranch).not.toHaveBeenCalled();
    expect(prs.createPullRequest).not.toHaveBeenCalled();
    expect(state.entity).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/7',
    });
    expect(state.history[0].action).toBe('pr_reused');
  });

  it('reuses an open PR without committing when its branch already has the new owner', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => ({
        id: '7',
        url: 'https://repo/pr/7',
      })),
      readFile: jest.fn(async () => ({
        content: CATALOG_INFO.replace('group:old-team', 'new-team'),
        revision: 'c1',
      })),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.commitFile).not.toHaveBeenCalled();
    expect(state.entity.pr_status).toBe('raised');
  });

  it('uses a suffixed branch when the deterministic branch exists without an open PR', async () => {
    const prs = makePrs({
      createBranch: jest
        .fn()
        .mockResolvedValueOnce('exists')
        .mockResolvedValueOnce('created'),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    const base = branchNameFor(makeEntity());
    const second = prs.createBranch.mock.calls[1][1];
    expect(second).toMatch(new RegExp(`^${base}-`));
    expect(state.entity.pr_branch).toBe(second);
  });

  it('opens the PR without reviewer when the acceptor cannot be mapped to an SCM user', async () => {
    const prs = makePrs({ resolveReviewer: jest.fn(async () => undefined) });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ reviewers: [] }),
    );
    expect(state.entity.pr_status).toBe('raised');
    expect(state.history[0].details).toMatchObject({
      reviewerUnresolved: true,
    });
  });

  describe('reviewers = acceptor + repository default reviewers', () => {
    it('requests the acceptor first, then the default reviewers for the PR refs, de-duplicated', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => [
          'lead.one',
          'JDOE',
          'lead.two',
        ]),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      const branch = branchNameFor(makeEntity());
      expect(prs.getDefaultReviewers).toHaveBeenCalledWith(REPO, {
        fromBranch: branch,
        toBranch: 'master',
      });
      expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
      expect(prs.createPullRequest).toHaveBeenCalledWith(
        REPO,
        expect.objectContaining({
          reviewers: ['jdoe', 'lead.one', 'lead.two'],
        }),
      );
      expect(state.history[0].details).toMatchObject({
        reviewers: ['jdoe', 'lead.one', 'lead.two'],
      });
    });

    it('still opens the PR with the acceptor when default reviewers cannot be resolved', async () => {
      const prs = makePrs({ getDefaultReviewers: scmFailure('unavailable') });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenCalledWith(
        REPO,
        expect.objectContaining({ reviewers: ['jdoe'] }),
      );
      expect(state.entity.pr_status).toBe('raised');
      expect(state.history[0].details).toMatchObject({
        defaultReviewersUnresolved: true,
      });
    });

    it('falls back to the acceptor only when the SCM rejects the reviewer list (invalid)', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => ['svc-account']),
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError('invalid', 'svc-account is the author', {
              httpStatus: 400,
            }),
          )
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '43', url: 'https://repo/pr/43' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({ reviewers: ['jdoe'] }),
      );
      expect(state.entity).toMatchObject({
        pr_status: 'raised',
        pr_url: 'https://repo/pr/43',
      });
      expect(state.history[0].details).toMatchObject({
        reviewers: ['jdoe'],
        reviewersFallback: {
          rejected: ['jdoe', 'svc-account'],
          reason: 'svc-account is the author',
        },
      });
    });

    it('does not retry an invalid request when there are no default reviewers to drop', async () => {
      const prs = makePrs({
        createPullRequest: scmFailure('invalid', 'bad', 400),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
      expect(state.entity.pr_status).toBe('failed');
    });

    it('drops only the reviewers the SCM names as rejected, keeping the acceptor and other defaults', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => [
          'lead.one',
          'SVC-Account',
          'lead.two',
        ]),
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError(
              'invalid',
              'Errors encountered while adding some reviewers',
              {
                httpStatus: 409,
                rejectedReviewers: ['svc-account'],
              },
            ),
          )
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '44', url: 'https://repo/pr/44' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({
          reviewers: ['jdoe', 'lead.one', 'lead.two'],
        }),
      );
      expect(state.entity).toMatchObject({
        pr_status: 'raised',
        pr_url: 'https://repo/pr/44',
      });
      expect(state.history[0].details).toMatchObject({
        reviewers: ['jdoe', 'lead.one', 'lead.two'],
        reviewersFallback: {
          rejected: ['svc-account'],
          reason: 'Errors encountered while adding some reviewers',
        },
      });
    });

    it('opens the PR without the acceptor when the SCM rejects the acceptor', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => ['lead']),
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError('invalid', 'jdoe is the author', {
              rejectedReviewers: ['jdoe'],
            }),
          )
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '45', url: 'u45' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({ reviewers: ['lead'] }),
      );
      expect(state.entity.pr_status).toBe('raised');
    });

    it('raises the PR with no reviewers when the only reviewer, the acceptor, is rejected', async () => {
      const prs = makePrs({
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError('invalid', 'jdoe is the author', {
              rejectedReviewers: ['jdoe'],
            }),
          )
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '47', url: 'u47' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({ reviewers: [] }),
      );
      expect(state.entity.pr_status).toBe('raised');
      expect(state.history[0].details).toMatchObject({
        reviewers: [],
        reviewersFallback: { rejected: ['jdoe'], reason: 'jdoe is the author' },
      });
    });

    it('falls back to the acceptor when the rejected reviewers are not in the list', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => ['lead']),
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError('invalid', 'someone-else', {
              rejectedReviewers: ['someone-else'],
            }),
          )
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '48', url: 'u48' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({ reviewers: ['jdoe'] }),
      );
      expect(state.entity.pr_status).toBe('raised');
    });

    it('fails without looping when the rejected reviewers are not in an acceptor-only list', async () => {
      const prs = makePrs({
        createPullRequest: jest.fn(async () => {
          throw new ScmError('invalid', 'someone-else', {
            rejectedReviewers: ['someone-else'],
          });
        }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
      expect(state.entity.pr_status).toBe('failed');
    });

    it('falls back to the acceptor when removing the named reviewers is still rejected', async () => {
      const prs = makePrs({
        getDefaultReviewers: jest.fn(async () => ['lead', 'gone']),
        createPullRequest: jest
          .fn()
          .mockRejectedValueOnce(
            new ScmError('invalid', 'gone is inactive', {
              rejectedReviewers: ['gone'],
            }),
          )
          .mockRejectedValueOnce(new ScmError('invalid', 'some reviewers'))
          .mockResolvedValueOnce({
            status: 'created',
            pr: { id: '46', url: 'u46' },
          }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        2,
        REPO,
        expect.objectContaining({ reviewers: ['jdoe', 'lead'] }),
      );
      expect(prs.createPullRequest).toHaveBeenNthCalledWith(
        3,
        REPO,
        expect.objectContaining({ reviewers: ['jdoe'] }),
      );
      expect(state.history[0].details).toMatchObject({
        reviewers: ['jdoe'],
        reviewersFallback: [
          { rejected: ['gone'], reason: 'gone is inactive' },
          { rejected: ['jdoe', 'lead'], reason: 'some reviewers' },
        ],
      });
    });
  });

  it('skips (status none) when the file already has the new owner', async () => {
    const prs = makePrs({
      readFile: jest.fn(async () => ({
        content: CATALOG_INFO.replace('group:old-team', 'new-team'),
        revision: 'c1',
      })),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.createBranch).not.toHaveBeenCalled();
    expect(state.entity.pr_status).toBe('none');
    expect(state.history[0]).toMatchObject({
      action: 'pr_creation_skipped',
      details: { reason: 'already_up_to_date' },
    });
  });

  it.each([
    [
      'entity no longer accepted',
      makeEntity({ current_status: 'open' }),
      [makeProposal()],
    ],
    [
      'proposal no longer accepted',
      makeEntity(),
      [makeProposal({ status: 'expired' })],
    ],
  ])('skips a stale job: %s', async (_label, entity, proposals) => {
    const { service, state, prs } = makeService({ entity, proposals });

    await service.run(makeDeadline());

    expect(prs.readFile).not.toHaveBeenCalled();
    expect(state.entity.pr_status).toBe('none');
    expect(state.history[0].action).toBe('pr_creation_skipped');
  });

  describe('failures', () => {
    it('file not found → failed, recorded, no automatic retry', async () => {
      const prs = makePrs({ readFile: jest.fn(async () => undefined) });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(state.entity).toMatchObject({
        pr_status: 'failed',
        pr_attempts: 1,
      });
      expect(state.entity.pr_last_error).toContain('not found');
      expect(state.history[0]).toMatchObject({
        action: 'pr_creation_failed',
        details: expect.objectContaining({
          step: 'read',
          retryable: false,
          attempt: 1,
        }),
      });
      expect(state.deadlines).toHaveLength(0);
    });

    it('repository not found → failed, no automatic retry', async () => {
      const prs = makePrs({ getDefaultBranch: scmFailure('not-found') });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(state.entity.pr_status).toBe('failed');
      expect(state.deadlines).toHaveLength(0);
    });

    it('missing managed-by-location → failed, no automatic retry', async () => {
      const { service, state } = makeService({ catalog: makeCatalog(null) });

      await service.run(makeDeadline());

      expect(state.entity.pr_status).toBe('failed');
      expect(state.history[0].details.step).toBe('locate');
      expect(state.deadlines).toHaveLength(0);
    });

    it('API error → failed and a retry deadline with backoff is written', async () => {
      const prs = makePrs({
        createPullRequest: scmFailure('unavailable', 'boom', 500),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(state.entity).toMatchObject({
        pr_status: 'failed',
        pr_attempts: 1,
      });
      expect(state.entity.pr_last_error).toContain('HTTP 500');
      expect(state.deadlines).toEqual([
        expect.objectContaining({
          deadline_type: 'pr_creation',
          proposal_id: 'prop-1',
          actor_ref: 'user:default/jane.doe',
          fire_at: new Date(NOW.getTime() + PR_RETRY_BACKOFF_MS[0]),
        }),
      ]);
    });

    it('increases the backoff with each attempt', async () => {
      const prs = makePrs({ commitFile: scmFailure('unavailable') });
      const { service, state } = makeService({
        prs,
        entity: makeEntity({ pr_attempts: 2 }),
      });

      await service.run(makeDeadline());

      expect(state.entity.pr_attempts).toBe(3);
      expect(state.deadlines[0].fire_at).toEqual(
        new Date(NOW.getTime() + PR_RETRY_BACKOFF_MS[2]),
      );
    });

    it('stops automatic retries once maxAttempts is reached', async () => {
      const prs = makePrs({ commitFile: scmFailure('unavailable') });
      const { service, state } = makeService({
        prs,
        maxAttempts: 3,
        entity: makeEntity({ pr_attempts: 2 }),
      });

      await service.run(makeDeadline());

      expect(state.entity).toMatchObject({
        pr_status: 'failed',
        pr_attempts: 3,
      });
      expect(state.deadlines).toHaveLength(0);
    });

    it('validation errors → failed, nothing written to the SCM, no automatic retry', async () => {
      const validator: EntityValidator = {
        validate: jest.fn(async () => ({
          status: 'invalid' as const,
          errors: ['spec.lifecycle is invalid'],
        })),
      };
      const { service, state, prs } = makeService({ validator });

      await service.run(makeDeadline());

      expect(prs.createBranch).not.toHaveBeenCalled();
      expect(prs.commitFile).not.toHaveBeenCalled();
      expect(state.entity.pr_status).toBe('failed');
      expect(state.entity.pr_last_error).toContain('spec.lifecycle is invalid');
      expect(state.deadlines).toHaveLength(0);
    });

    it('validator unavailable → failed with an automatic retry', async () => {
      const validator: EntityValidator = {
        validate: jest.fn(async () => ({
          status: 'unavailable' as const,
          message: 'ECONNREFUSED',
        })),
      };
      const { service, state } = makeService({ validator });

      await service.run(makeDeadline());

      expect(state.entity.pr_status).toBe('failed');
      expect(state.deadlines).toHaveLength(1);
    });

    it('an unexpected exception is still recorded as a retryable failure', async () => {
      const prs = makePrs({
        readFile: jest.fn(async () => {
          throw new Error('kaboom');
        }),
      });
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline());

      expect(state.entity).toMatchObject({
        pr_status: 'failed',
        pr_last_error: 'Failed to read catalog-info.yaml: kaboom',
      });
      expect(state.history[0].details.step).toBe('read');
      expect(state.deadlines).toHaveLength(1);
    });
  });
});

describe('PrCreationService.trigger', () => {
  it('runs a deadline only once even if triggered twice (lease is exclusive)', async () => {
    const { service, state, prs } = makeService();
    state.claimable.add('dl-1');

    await Promise.all([service.trigger('dl-1'), service.trigger('dl-1')]);

    expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it('leases the deadline for PR_JOB_LEASE_MS instead of marking it processed up front', async () => {
    const { service, state } = makeService();
    state.claimable.add('dl-1');

    await service.trigger('dl-1');

    expect(state.leases).toEqual([
      {
        id: 'dl-1',
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + PR_JOB_LEASE_MS),
      },
    ]);
  });
});

describe('PrCreationService — deadline is marked processed with the outcome, never before', () => {
  it.each([
    ['raised', makePrs()],
    ['failed (retryable)', makePrs({ commitFile: scmFailure('unavailable') })],
    [
      'failed (permanent)',
      makePrs({ readFile: jest.fn(async () => undefined) }),
    ],
  ])(
    '%s → marked processed in the same tx as the state write',
    async (_label, prs) => {
      const { service, state } = makeService({ prs });

      await service.run(makeDeadline({ id: 'dl-9' }));

      expect(state.processed).toEqual(['dl-9']);
      expect(state.history).toHaveLength(1);
    },
  );

  it('skipped (stale) → marked processed', async () => {
    const { service, state } = makeService({
      entity: makeEntity({ current_status: 'open' }),
    });

    await service.run(makeDeadline({ id: 'dl-9' }));

    expect(state.processed).toEqual(['dl-9']);
  });

  it('when the final state write throws, the deadline stays unprocessed (lease expiry re-runs it)', async () => {
    const { service, state, store } = makeService();
    const realTx = store.withTransaction.bind(store);
    // Fail exactly the final outcome write (the tx that completes the lease).
    (store as any).withTransaction = (fn: (t: any) => Promise<any>) =>
      realTx((tx: any) =>
        fn({
          ...tx,
          pendingDeadlineStore: {
            ...tx.pendingDeadlineStore,
            completeLease: async () => {
              throw new Error('db connection lost');
            },
          },
        }),
      );

    await expect(service.run(makeDeadline({ id: 'dl-9' }))).rejects.toThrow(
      'db connection lost',
    );

    expect(state.processed).toEqual([]);
    expect(state.entity.pr_status).toBe('pending');
  });
});

describe('PrCreationService.processDue', () => {
  it('only asks for pr_creation deadlines', async () => {
    const { service, store } = makeService();

    await service.processDue();

    expect(store.findExpiredDeadlines).toHaveBeenCalledWith(NOW, {
      types: ['pr_creation'],
    });
  });
});

describe('PrCreationService.requestRetry', () => {
  it('resets attempts, enqueues a fresh job with the original acceptor as reviewer, and records history', async () => {
    const { service, state } = makeService({
      entity: makeEntity({
        pr_status: 'failed',
        pr_attempts: 5,
        pr_last_error: 'boom',
      }),
    });

    const entity = await service.requestRetry(
      makeEntity().id,
      'user:default/admin',
    );

    expect(entity).toMatchObject({
      pr_status: 'pending',
      pr_attempts: 0,
      pr_last_error: null,
    });
    expect(state.cancelled).toEqual([
      { entityId: makeEntity().id, types: ['pr_creation'] },
    ]);
    expect(state.deadlines).toEqual([
      expect.objectContaining({
        deadline_type: 'pr_creation',
        proposal_id: 'prop-1',
        actor_ref: 'user:default/jane.doe',
        fire_at: NOW,
      }),
    ]);
    expect(state.history).toEqual([
      expect.objectContaining({
        action: 'pr_retry_requested',
        actor: 'user:default/admin',
        details: { previousAttempts: 5, previousError: 'boom' },
      }),
    ]);
  });

  it('a declined PR can be retried', async () => {
    const { service } = makeService({
      entity: makeEntity({ pr_status: 'declined' }),
    });
    await expect(
      service.requestRetry(makeEntity().id, 'user:default/admin'),
    ).resolves.toMatchObject({
      pr_status: 'pending',
    });
  });

  it.each([
    ['PR not failed', makeEntity({ pr_status: 'raised' })],
    ['PR completed', makeEntity({ pr_status: 'completed' })],
    [
      'PR superseded by another owner change',
      makeEntity({ pr_status: 'superseded' }),
    ],
    [
      'entity not accepted',
      makeEntity({ current_status: 'open', pr_status: 'failed' }),
    ],
  ])('rejects a retry when %s', async (_label, entity) => {
    const { service } = makeService({ entity });
    await expect(
      service.requestRetry(entity.id, 'user:default/admin'),
    ).rejects.toThrow(ConflictError);
  });
});

describe('PrCreationService — one run at a time per entity', () => {
  it('marks the entity pending in the lease transaction (so Retry is refused while running)', async () => {
    const { service, state, prs } = makeService({
      entity: makeEntity({ pr_status: 'failed' }),
      prs: makePrs({
        readFile: jest.fn(async () => {
          // Observed mid-run: the job is running, the UI must not offer Retry.
          expect(state.entity.pr_status).toBe('pending');
          return { content: CATALOG_INFO, revision: 'c0ffee' };
        }),
      }),
    });
    state.claimable.add('dl-1');

    await service.trigger('dl-1');

    expect(prs.readFile).toHaveBeenCalled();
    expect(state.entity.pr_status).toBe('raised');
  });

  it.each([
    [
      'a failure (no state overwrite, no extra retry deadline)',
      makePrs({ commitFile: scmFailure('unavailable') }),
    ],
    ['a raised PR', makePrs()],
  ])('a superseded run discards %s', async (_label, prs) => {
    const { service, state } = makeService({
      prs,
      entity: makeEntity({ pr_status: 'pending', pr_attempts: 0 }),
    });
    state.superseded.add('dl-old');

    await service.run(makeDeadline({ id: 'dl-old' }));

    expect(state.entity).toMatchObject({
      pr_status: 'pending',
      pr_attempts: 0,
      pr_url: null,
    });
    expect(state.history).toEqual([]);
    expect(state.deadlines).toEqual([]);
  });

  it('requestRetry locks the PR deadline rows before the entity row (same order as the lease)', async () => {
    const { service, state } = makeService({
      entity: makeEntity({ pr_status: 'failed' }),
    });

    await service.requestRetry(makeEntity().id, 'user:default/admin');

    expect(state.locks.slice(0, 2)).toEqual([
      `deadlines:${makeEntity().id}`,
      `entity:${makeEntity().id}`,
    ]);
  });
});

describe('PrCreationService — no orphan branches across retries', () => {
  const branch = branchNameFor(makeEntity());
  const withNewOwner = CATALOG_INFO.replace('group:old-team', 'new-team');

  it('saves the work branch right after creating it, so a failed commit leaves it recorded', async () => {
    const { service, state } = makeService({
      prs: makePrs({ commitFile: scmFailure('unavailable') }),
    });

    await service.run(makeDeadline());

    expect(state.entity).toMatchObject({
      pr_status: 'failed',
      pr_branch: branch,
      pr_url: null,
    });
  });

  it('the next attempt reuses that branch: reads from it, commits, opens the PR — no new branch', async () => {
    const prs = makePrs();
    const { service, state } = makeService({
      prs,
      entity: makeEntity({
        pr_status: 'pending',
        pr_branch: branch,
        pr_url: null,
      }),
    });

    await service.run(makeDeadline());

    expect(prs.createBranch).not.toHaveBeenCalled();
    expect(prs.readFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      branch,
    );
    expect(prs.commitFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      expect.objectContaining({ branch }),
    );
    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ fromBranch: branch, toBranch: 'master' }),
    );
    expect(state.entity).toMatchObject({
      pr_status: 'raised',
      pr_branch: branch,
    });
  });

  it('when the leftover branch already has the commit (PR step failed last time), only the PR is opened', async () => {
    const prs = makePrs({
      readFile: jest.fn(async () => ({
        content: withNewOwner,
        revision: 'c2',
      })),
    });
    const { service, state } = makeService({
      prs,
      entity: makeEntity({
        pr_status: 'pending',
        pr_branch: branch,
        pr_url: null,
      }),
    });

    await service.run(makeDeadline());

    expect(prs.createBranch).not.toHaveBeenCalled();
    expect(prs.commitFile).not.toHaveBeenCalled();
    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ fromBranch: branch }),
    );
    expect(state.entity.pr_status).toBe('raised');
  });

  it('a leftover branch that was deleted falls back to the base branch and a fresh branch', async () => {
    const prs = makePrs({
      readFile: jest.fn(async (_repo: ScmRepoRef, _f: string, at: string) =>
        at === 'ownership/gone'
          ? undefined
          : { content: CATALOG_INFO, revision: 'c0ffee' },
      ),
    });
    const { service, state } = makeService({
      prs,
      entity: makeEntity({
        pr_status: 'pending',
        pr_branch: 'ownership/gone',
        pr_url: null,
      }),
    });

    await service.run(makeDeadline());

    expect(prs.readFile).toHaveBeenLastCalledWith(
      REPO,
      'catalog-info.yaml',
      'master',
    );
    expect(prs.createBranch).toHaveBeenCalledWith(REPO, branch, 'master');
    expect(state.entity).toMatchObject({
      pr_status: 'raised',
      pr_branch: branch,
    });
  });

  it('a branch from an earlier, already-raised PR (pr_url set) is not reused — suffixed branch instead', async () => {
    const prs = makePrs({
      createBranch: jest
        .fn()
        .mockResolvedValueOnce('exists')
        .mockResolvedValueOnce('created'),
    });
    const { service } = makeService({
      prs,
      entity: makeEntity({
        pr_status: 'pending',
        pr_branch: branch,
        pr_url: 'https://repo/pr/old',
      }),
    });

    await service.run(makeDeadline());

    expect(prs.readFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      'master',
    );
    expect(prs.createBranch.mock.calls[1][1]).toMatch(
      new RegExp(`^${branch}-`),
    );
  });

  it('a superseded run does not record its branch', async () => {
    const { service, state } = makeService({
      prs: makePrs({ commitFile: scmFailure('unavailable') }),
    });
    state.superseded.add('dl-old');

    await service.run(makeDeadline({ id: 'dl-old' }));

    expect(state.entity.pr_branch).toBeNull();
  });
});

describe('PrCreationService — reused PR is kept in line with the new owner', () => {
  const openPr = { id: '7', url: 'https://repo/pr/7' };

  it('updates title/description to the new owner and adds the new acceptor as reviewer', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => openPr),
      updatePullRequest: jest.fn(async () => 'updated' as const),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.commitFile).toHaveBeenCalled();
    expect(prs.createPullRequest).not.toHaveBeenCalled();
    expect(prs.updatePullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ id: '7' }),
      {
        title: 'Set owner of my-service to new-team',
        description: expect.stringContaining('**new-team**'),
        addReviewers: ['jdoe'],
      },
    );
    expect(state.history[0]).toMatchObject({
      action: 'pr_reused',
      details: expect.objectContaining({ prSync: 'updated' }),
    });
  });

  it('also syncs when the branch already has the new owner (nothing to commit)', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => openPr),
      readFile: jest.fn(async () => ({
        content: CATALOG_INFO.replace('group:old-team', 'new-team'),
        revision: 'c1',
      })),
    });
    const { service } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.commitFile).not.toHaveBeenCalled();
    expect(prs.updatePullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ id: '7' }),
      expect.objectContaining({
        title: 'Set owner of my-service to new-team',
      }),
    );
  });

  it('a failed PR update is recorded but does not fail the job (the commit is already on the PR)', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => openPr),
      updatePullRequest: scmFailure('conflict', 'version mismatch', 409),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.entity).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/7',
    });
    expect(state.history[0].details).toMatchObject({
      prSync: 'error',
      prSyncError: 'version mismatch',
    });
    expect(state.deadlines).toHaveLength(0);
  });
});

describe('PrCreationService — every failing step is recorded with its retry policy', () => {
  type Case = [
    label: string,
    setup: () => Parameters<typeof makeService>[0],
    step: string,
    retryable: boolean,
    reason: RegExp,
  ];
  const cases: Case[] = [
    [
      'no accepted owner',
      () => ({ entity: makeEntity({ assigned_to: null }), proposals: [] }),
      'resolve-owner',
      false,
      /No accepted owner/,
    ],
    [
      'entity missing from the catalog',
      () => {
        const catalog = makeCatalog();
        catalog.getEntityByRef.mockResolvedValue(undefined);
        return { catalog };
      },
      'locate',
      false,
      /not found in catalog/,
    ],
    [
      'default branch lookup error',
      () => ({ prs: makePrs({ getDefaultBranch: scmFailure('unavailable') }) }),
      'locate',
      true,
      /Failed to resolve default branch/,
    ],
    [
      'open-PR lookup error',
      () => ({
        prs: makePrs({ findOpenPullRequest: scmFailure('unavailable') }),
      }),
      'find-pr',
      true,
      /Failed to look up existing pull requests/,
    ],
    [
      'file read error',
      () => ({ prs: makePrs({ readFile: scmFailure('unavailable') }) }),
      'read',
      true,
      /Failed to read catalog-info.yaml/,
    ],
    [
      'entity not present in the file',
      () => ({
        prs: makePrs({
          readFile: jest.fn(async () => ({
            content: CATALOG_INFO.replace('name: my-service', 'name: other'),
            revision: 'c',
          })),
        }),
      }),
      'edit',
      false,
      /Component:my-service not found in catalog-info.yaml/,
    ],
    [
      'unparseable YAML',
      () => ({
        prs: makePrs({
          readFile: jest.fn(async () => ({
            content: 'kind: [unclosed',
            revision: 'c',
          })),
        }),
      }),
      'edit',
      false,
      /Cannot edit catalog-info.yaml/,
    ],
    [
      'branch creation error',
      () => ({
        prs: makePrs({
          createBranch: scmFailure('unknown', 'denied', 403),
        }),
      }),
      'branch',
      true,
      /Failed to create branch .* \(HTTP 403\): denied/,
    ],
    [
      'both branch names already taken',
      () => ({
        prs: makePrs({ createBranch: jest.fn(async () => 'exists' as const) }),
      }),
      'branch',
      true,
      /already exists/,
    ],
  ];

  it.each(cases)(
    '%s → failed at "%s" (retryable: %s)',
    async (_label, setup, step, retryable, reason) => {
      const { service, state } = makeService(setup());

      await service.run(makeDeadline());

      expect(state.entity.pr_status).toBe('failed');
      expect(state.entity.pr_last_error).toMatch(reason);
      expect(state.history[0]).toMatchObject({
        action: 'pr_creation_failed',
        details: expect.objectContaining({ step, retryable }),
      });
      expect(state.deadlines).toHaveLength(retryable ? 1 : 0);
    },
  );
});

describe('PrCreationService — defensive paths', () => {
  it('a deadline whose entity is gone is completed without writing state', async () => {
    const { service, state } = makeService();

    await service.run(makeDeadline({ id: 'dl-x', entity_id: 'missing' }));

    expect(state.processed).toEqual(['dl-x']);
    expect(state.history).toEqual([]);
  });

  it('opens the PR without the acceptor when the reviewer lookup throws', async () => {
    const catalog = makeCatalog();
    const lookup = catalog.getEntityByRef.getMockImplementation()!;
    catalog.getEntityByRef.mockImplementation(async (ref: string) => {
      if (ref.startsWith('user:')) throw new Error('catalog down');
      return lookup(ref);
    });
    const { service, prs, state } = makeService({ catalog });

    await service.run(makeDeadline());

    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ reviewers: [] }),
    );
    expect(state.entity.pr_status).toBe('raised');
  });

  it('processDue keeps going and logs when one deadline throws', async () => {
    const { service, store } = makeService();
    (store.findExpiredDeadlines as jest.Mock).mockResolvedValue([
      makeDeadline({ id: 'a' }),
      makeDeadline({ id: 'b' }),
    ]);
    const trigger = jest
      .spyOn(service, 'trigger')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce();

    await service.processDue();

    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it('requestRetry still returns when the background kick fails', async () => {
    const { service } = makeService({
      entity: makeEntity({ pr_status: 'failed' }),
    });
    jest.spyOn(service, 'trigger').mockRejectedValue(new Error('kick failed'));

    await expect(
      service.requestRetry(makeEntity().id, 'user:default/admin'),
    ).resolves.toMatchObject({
      pr_status: 'pending',
    });
    await new Promise(setImmediate);
  });
});

describe('PrCreationService — optional inputs and fallbacks', () => {
  it('uses DEFAULT_PR_MAX_ATTEMPTS when no options are given', async () => {
    const { store, state } = makeStore(makeEntity({ pr_attempts: 3 }));
    const service = new PrCreationService(
      store,
      makeScm(makePrs({ commitFile: scmFailure('unavailable') })),
      makeCatalog(),
      validValidator,
      new TestClock(NOW),
      mockServices.logger.mock(),
    );

    await service.run(makeDeadline());

    // attempt 4 of the default 5 → still retried
    expect(state.history[0].details).toMatchObject({
      step: 'commit',
      attempt: 4,
    });
    expect(state.deadlines).toHaveLength(1);
  });

  it('a deadline without proposal or actor falls back to the entity owner and requests no acceptor', async () => {
    const { service, state, prs } = makeService();

    await service.run(makeDeadline({ proposal_id: null, actor_ref: null }));

    expect(prs.commitFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      expect.objectContaining({
        message: 'chore(ownership): set spec.owner to new-team',
      }),
    );
    const { description, reviewers } = prs.createPullRequest.mock.calls[0][1];
    expect(reviewers).toEqual([]);
    expect(description).not.toContain('accepted by `');
    expect(state.history[0]).toMatchObject({
      action: 'pr_raised',
      proposal_id: undefined,
    });
  });

  it('reuses an open PR without an acceptor (no reviewer added)', async () => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => ({ id: '7', url: 'u' })),
    });
    const { service } = makeService({ prs });

    await service.run(makeDeadline({ actor_ref: null }));

    expect(prs.updatePullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ id: '7' }),
      expect.objectContaining({ addReviewers: [] }),
    );
  });

  it.each([
    [new ScmError('unavailable', 'HTTP 503', { httpStatus: 503 }), 'HTTP 503'],
    [new Error('socket closed'), 'socket closed'],
  ])('records the PR update failure reason %#', async (error, expected) => {
    const prs = makePrs({
      findOpenPullRequest: jest.fn(async () => ({ id: '7', url: 'u' })),
      updatePullRequest: jest.fn(async () => {
        throw error;
      }),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.history[0].details.prSyncError).toBe(expected);
  });

  it('treats a duplicate-PR response from the SCM as a reused PR', async () => {
    const prs = makePrs({
      createPullRequest: jest.fn(async () => ({
        status: 'reused' as const,
        pr: { id: '8', url: 'https://repo/pr/8' },
      })),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.history[0].action).toBe('pr_reused');
    expect(state.entity.pr_url).toBe('https://repo/pr/8');
  });

  it('falls back to the acceptor with a generic reason when an invalid error has no message', async () => {
    const prs = makePrs({
      getDefaultReviewers: jest.fn(async () => ['lead']),
      createPullRequest: jest
        .fn()
        .mockRejectedValueOnce(new ScmError('invalid', '', { httpStatus: 400 }))
        .mockResolvedValueOnce({
          status: 'created',
          pr: { id: '9', url: 'u9' },
        }),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.history[0].details.reviewersFallback).toEqual({
      rejected: ['jdoe', 'lead'],
      reason: 'HTTP 400',
    });
  });

  it('a PR error without status or message still fails with a readable reason', async () => {
    const prs = makePrs({ createPullRequest: scmFailure('unknown', '') });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.entity.pr_last_error).toBe('Failed to create PR');
  });

  it('a non-Error thrown value is still recorded', async () => {
    const prs = makePrs({
      readFile: jest.fn(async () => {
        throw 'socket hang up'; // eslint-disable-line no-throw-literal
      }),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.entity.pr_last_error).toBe(
      'Failed to read catalog-info.yaml: socket hang up',
    );
  });

  it('skips the reviewer lookup when the acceptor has no email', async () => {
    const catalog = makeCatalog();
    const lookup = catalog.getEntityByRef.getMockImplementation()!;
    catalog.getEntityByRef.mockImplementation(async (ref: string) =>
      ref.startsWith('user:')
        ? { kind: 'User', metadata: { name: 'x' }, spec: { profile: {} } }
        : lookup(ref),
    );
    const { service, prs } = makeService({ catalog });

    await service.run(makeDeadline());

    expect(prs.resolveReviewer).not.toHaveBeenCalled();
  });

  it('requestRetry: unknown entity → NotFoundError; no accepted proposal → deadline without proposal', async () => {
    const missing = makeService();
    await expect(
      missing.service.requestRetry('nope', 'user:default/admin'),
    ).rejects.toThrow(/not found/);

    const { service, state } = makeService({
      entity: makeEntity({ pr_status: 'failed' }),
      proposals: [],
    });
    await service.requestRetry(makeEntity().id, 'user:default/admin');
    expect(state.deadlines[0]).toMatchObject({ proposal_id: null });
  });
});

describe('PrCreationService — SCM routing', () => {
  it.each([
    [
      'no integration for the host',
      { status: 'no-integration', host: 'git.unknown.example' } as const,
      /No SCM integration is configured for git.unknown.example/,
    ],
    [
      'no provider module for the integration type',
      { status: 'no-provider', host: 'gitlab.com', type: 'gitlab' } as const,
      /No ownership-matcher SCM provider is installed for gitlab \(gitlab.com\)/,
    ],
  ])(
    '%s → unsupported_scm, terminal, no retry',
    async (_label, resolution, message) => {
      const { service, state, prs } = makeService({
        scm: makeScm(makePrs(), resolution),
      });

      await service.run(makeDeadline({ id: 'dl-u' }));

      expect(prs.readFile).not.toHaveBeenCalled();
      expect(state.entity.pr_status).toBe('unsupported_scm');
      expect(state.entity.pr_last_error).toMatch(message);
      expect(state.history).toEqual([
        expect.objectContaining({
          action: 'pr_creation_skipped',
          details: expect.objectContaining({ reason: 'unsupported_scm' }),
        }),
      ]);
      expect(state.processed).toEqual(['dl-u']);
      expect(state.deadlines).toHaveLength(0);
    },
  );

  it('a provider without the pullRequests capability → unsupported_scm', async () => {
    const { service, state } = makeService({ scm: makeScm(undefined) });

    await service.run(makeDeadline());

    expect(state.entity.pr_status).toBe('unsupported_scm');
    expect(state.entity.pr_last_error).toMatch(/cannot raise pull requests/);
    expect(state.deadlines).toHaveLength(0);
  });

  it('an unparseable location is a permanent locate failure, not unsupported_scm', async () => {
    const { service, state } = makeService({
      scm: makeScm(makePrs(), {
        status: 'unparseable',
        url: 'https://repo.example.com/x',
      }),
    });

    await service.run(makeDeadline());

    expect(state.entity.pr_status).toBe('failed');
    expect(state.history[0].details).toMatchObject({
      step: 'locate',
      retryable: false,
    });
  });

  it('routes the entity managed-by-location to the registry', async () => {
    const { service, scm } = makeService();

    await service.run(makeDeadline());

    expect(scm.forLocation).toHaveBeenCalledWith(LOCATION);
  });

  it('requestRetry accepts an unsupported_scm job (e.g. after installing a provider)', async () => {
    const { service, state } = makeService({
      entity: makeEntity({ pr_status: 'unsupported_scm' }),
    });

    await expect(
      service.requestRetry(makeEntity().id, 'user:default/admin'),
    ).resolves.toMatchObject({
      pr_status: 'pending',
    });
    expect(state.deadlines).toHaveLength(1);
  });
});

describe('PrCreationService — ScmError mapping', () => {
  const branch = branchNameFor(makeEntity());
  const withNewOwner = CATALOG_INFO.replace('group:old-team', 'new-team');

  it('conflict on commit → re-reads the work branch, re-edits and commits again in the same run', async () => {
    const changedUpstream = CATALOG_INFO.replace(
      'lifecycle: production',
      'lifecycle: experimental',
    );
    const prs = makePrs({
      readFile: jest
        .fn()
        .mockResolvedValueOnce({ content: CATALOG_INFO, revision: 'r1' })
        .mockResolvedValueOnce({ content: changedUpstream, revision: 'r2' }),
      commitFile: jest
        .fn()
        .mockRejectedValueOnce(
          new ScmError('conflict', 'stale', { httpStatus: 409 }),
        )
        .mockResolvedValueOnce(undefined),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.readFile).toHaveBeenLastCalledWith(
      REPO,
      'catalog-info.yaml',
      branch,
    );
    expect(prs.commitFile).toHaveBeenCalledTimes(2);
    expect(prs.commitFile).toHaveBeenLastCalledWith(
      REPO,
      'catalog-info.yaml',
      expect.objectContaining({
        revision: 'r2',
        content: changedUpstream.replace('group:old-team', 'new-team'),
      }),
    );
    expect(state.entity.pr_status).toBe('raised');
  });

  it('conflict, but the fresh content already has the owner → no second commit, PR opened', async () => {
    const prs = makePrs({
      readFile: jest
        .fn()
        .mockResolvedValueOnce({ content: CATALOG_INFO, revision: 'r1' })
        .mockResolvedValueOnce({ content: withNewOwner, revision: 'r2' }),
      commitFile: scmFailure('conflict'),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(prs.commitFile).toHaveBeenCalledTimes(1);
    expect(prs.createPullRequest).toHaveBeenCalled();
    expect(state.entity.pr_status).toBe('raised');
  });

  it('a second conflict fails the run with a normal retry', async () => {
    const { service, state } = makeService({
      prs: makePrs({ commitFile: scmFailure('conflict', 'stale') }),
    });

    await service.run(makeDeadline());

    expect(state.entity.pr_status).toBe('failed');
    expect(state.history[0].details).toMatchObject({
      step: 'commit',
      retryable: true,
    });
    expect(state.deadlines[0].fire_at).toEqual(
      new Date(NOW.getTime() + PR_RETRY_BACKOFF_MS[0]),
    );
  });

  it('read-only repository → retried after the long backoff', async () => {
    const { service, state } = makeService({
      prs: makePrs({
        createBranch: scmFailure('read-only', 'repository is archived'),
      }),
    });

    await service.run(makeDeadline());

    expect(state.entity.pr_last_error).toMatch(/repository is archived/);
    expect(state.history[0].details).toMatchObject({
      step: 'branch',
      retryable: true,
    });
    expect(state.deadlines[0].fire_at).toEqual(
      new Date(NOW.getTime() + PR_READ_ONLY_BACKOFF_MS),
    );
  });

  it.each([
    ['auth', 'token expired'],
    ['not-found', 'no such branch'],
    ['invalid', 'bad request'],
  ] as const)(
    '%s → terminal failure, no automatic retry',
    async (kind, message) => {
      const { service, state } = makeService({
        prs: makePrs({ commitFile: scmFailure(kind, message, 401) }),
      });

      await service.run(makeDeadline());

      expect(state.entity.pr_status).toBe('failed');
      expect(state.entity.pr_last_error).toBe(
        `Failed to commit catalog-info.yaml to ${branch} (HTTP 401): ${message}`,
      );
      expect(state.history[0].details).toMatchObject({
        step: 'commit',
        retryable: false,
      });
      expect(state.deadlines).toHaveLength(0);
    },
  );

  it('rate-limited / unavailable keep the provider retry policy', async () => {
    const { service, state } = makeService({
      prs: makePrs({ findOpenPullRequest: scmFailure('rate-limited') }),
    });

    await service.run(makeDeadline());

    expect(state.history[0].details).toMatchObject({
      step: 'find-pr',
      retryable: true,
    });
    expect(state.deadlines).toHaveLength(1);
  });

  it('a provider-marked non-retryable unknown error is not retried', async () => {
    const prs = makePrs({
      createPullRequest: jest.fn(async () => {
        throw new ScmError('unknown', 'weird', { retryable: false });
      }),
    });
    const { service, state } = makeService({ prs });

    await service.run(makeDeadline());

    expect(state.deadlines).toHaveLength(0);
  });
});
