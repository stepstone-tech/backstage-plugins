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
 * Catalog-info PR automation against a real Postgres database —
 * migration, accept → enqueue → kick, deadline routing, exclusive claim and
 * retry scheduling. The SCM provider and the catalog are faked.
 */

import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import { ProposalLifecycleService } from '../service/ProposalLifecycleService';
import { DefaultDeadlineCheckerService } from '../escalation/DeadlineCheckerService';
import { DefaultEscalationService } from '../escalation/EscalationService';
import { buildValidEscalationConfig } from '../escalation/__fixtures__/buildEscalationConfig';
import { createStandardOrgHierarchy } from '../escalation/__fixtures__/createMockCatalog';
import { TestClock } from '../escalation/__fixtures__/Clock';
import {
  seedDeadlineRow,
  seedEntityRow,
  seedProposalRow,
} from '../escalation/__fixtures__/seedEntity';
import {
  ScmError,
  type ScmPullRequestCapability,
  type ScmPullRequestRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  PrCatalog,
  PrCreationService,
  PrScm,
  PR_JOB_LEASE_MS,
  PR_RETRY_BACKOFF_MS,
} from './PrCreationService';

const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

const CATALOG_INFO =
  'kind: Component\nmetadata:\n  name: svc\nspec:\n  # owner comment\n  owner: group:old-team\n';

async function createStore() {
  const knex = await databases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  return { store: await DatabaseOwnershipStore.create({ database }), knex };
}

const REPO = {
  type: 'bitbucketServer',
  host: 'repo.example.com',
  path: 'P/r',
  webUrl: 'https://repo.example.com/projects/P/repos/r',
};

function fakePrs(
  overrides: Partial<Record<keyof ScmPullRequestCapability, jest.Mock>> = {},
): jest.Mocked<ScmPullRequestCapability> {
  return {
    getDefaultBranch: jest.fn(async () => 'master'),
    readFile: jest.fn(async () => ({ content: CATALOG_INFO, revision: 'c1' })),
    commitFile: jest.fn(async () => undefined),
    createBranch: jest.fn(async () => 'created' as const),
    findOpenPullRequest: jest.fn(async () => undefined),
    createPullRequest: jest.fn(async () => ({
      status: 'created' as const,
      pr: { id: '1', url: 'https://repo/pr/1' },
    })),
    resolveReviewer: jest.fn(async () => 'alice'),
    getDefaultReviewers: jest.fn(async () => ['lead']),
    updatePullRequest: jest.fn(async () => 'unchanged' as const),
    ...overrides,
  } as unknown as jest.Mocked<ScmPullRequestCapability>;
}

/** Registry routing every location to `prs` (catalog-info.yaml at the repo root). */
function fakeScm(prs: ScmPullRequestCapability): PrScm {
  return {
    forLocation: async () => ({
      status: 'ok',
      client: { parseLocation: () => undefined, pullRequests: prs },
      location: { repo: REPO, path: 'catalog-info.yaml' },
    }),
  };
}

const unavailable = () =>
  new ScmError('unavailable', 'Service Unavailable', { httpStatus: 503 });

const fakeCatalog: PrCatalog = {
  getEntityByRef: async ref =>
    ref.startsWith('user:')
      ? {
          kind: 'User',
          metadata: { name: 'alice' },
          spec: { profile: { email: 'alice@x.com' } },
        }
      : {
          kind: 'Component',
          metadata: {
            name: 'svc',
            annotations: {
              'backstage.io/managed-by-location':
                'url:https://repo.example.com/projects/P/repos/r/browse/catalog-info.yaml',
            },
          },
        },
};

function buildPrService(
  store: DatabaseOwnershipStore,
  clock: TestClock,
  prs = fakePrs(),
) {
  const service = new PrCreationService(
    store,
    fakeScm(prs),
    fakeCatalog,
    { validate: async () => ({ status: 'valid' }) },
    clock,
    mockServices.logger.mock(),
  );
  return { service, prs };
}

async function seedAcceptable(knex: any) {
  const entity = await seedEntityRow(knex, {
    entity_ref: 'component:default/svc',
    entity_name: 'svc',
    current_status: 'open',
  });
  const proposal = await seedProposalRow(knex, entity.id, {
    proposed_owner_ref: 'group:default/new-team',
  });
  return { entity, proposal };
}

/** A provider whose createPullRequest blocks until `release()` — the job is "running" meanwhile. Resolves with `result` or rejects with an Error. */
function gatedPrs(
  result: { status: 'created' | 'reused'; pr: ScmPullRequestRef } | Error,
) {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  let started!: () => void;
  const running = new Promise<void>(r => {
    started = r;
  });
  const prs = fakePrs({
    createPullRequest: jest.fn(async () => {
      started();
      await gate;
      if (result instanceof Error) throw result;
      return result;
    }),
  });
  return { prs, release, running };
}

async function seedFailedWithDueRetry(knex: any) {
  const entity = await seedEntityRow(knex, {
    entity_ref: 'component:default/svc',
    entity_name: 'svc',
    current_status: 'accepted',
    assigned_to: 'group:default/new-team',
    resolved_by: 'user:default/alice',
    pr_status: 'failed',
    pr_attempts: 1,
  });
  const deadline = await seedDeadlineRow(knex, entity.id, {
    deadline_type: 'pr_creation',
  });
  return { entity, deadline };
}

describe('PR automation (Postgres)', () => {
  it('migration adds pr_* columns with defaults and the CHECK rejects unknown statuses', async () => {
    const { knex } = await createStore();
    const entity = await seedEntityRow(knex);

    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({
      pr_status: 'none',
      pr_url: null,
      pr_branch: null,
      pr_attempts: 0,
      pr_last_error: null,
    });
    await expect(
      knex('ownership_entities')
        .where({ id: entity.id })
        .update({ pr_status: 'bogus' }),
    ).rejects.toThrow(/ownership_entities_pr_status_check/);
  });

  it('a job for a host without an SCM provider ends as unsupported_scm (allowed by the CHECK)', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    await seedDeadlineRow(knex, entity.id, { deadline_type: 'pr_creation' });
    const service = new PrCreationService(
      store,
      {
        forLocation: async () => ({
          status: 'no-provider',
          host: 'gitlab.com',
          type: 'gitlab',
        }),
      },
      fakeCatalog,
      { validate: async () => ({ status: 'valid' }) },
      clock,
      mockServices.logger.mock(),
    );

    await service.processDue();

    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({ pr_status: 'unsupported_scm', pr_attempts: 0 });
    const open = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    expect(open).toHaveLength(0);
  });

  it('accept enqueues pr_creation atomically, the kick raises the PR, and history records the sequence', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const { service, prs } = buildPrService(store, clock);
    let kick: Promise<void> | undefined;
    const lifecycle = new ProposalLifecycleService(
      store,
      mockServices.logger.mock(),
      undefined,
      undefined,
      { triggerEscalation: async () => {} },
      { trigger: id => (kick = service.trigger(id)) },
    );
    const { entity, proposal } = await seedAcceptable(knex);

    const result = await lifecycle.acceptProposal(
      proposal.id,
      'user:default/alice',
    );
    await kick;

    expect(['pending', 'raised']).toContain(result.entity.pr_status);
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/1',
    });
    expect(prs.createPullRequest).toHaveBeenCalledWith(
      REPO,
      expect.objectContaining({ reviewers: ['alice', 'lead'] }),
    );
    expect(prs.commitFile).toHaveBeenCalledWith(
      REPO,
      'catalog-info.yaml',
      expect.objectContaining({
        content: CATALOG_INFO.replace('group:old-team', 'new-team'),
      }),
    );

    const deadline = await knex('pending_deadlines')
      .where({ entity_id: entity.id, deadline_type: 'pr_creation' })
      .first();
    expect(deadline).toMatchObject({
      processed: true,
      actor_ref: 'user:default/alice',
      proposal_id: proposal.id,
    });

    const actions = (
      await knex('ownership_history')
        .where({ entity_id: entity.id })
        .orderBy('created_at')
    )
      .map((h: { action: string }) => h.action)
      .filter((a: string) => a.startsWith('pr_'));
    expect(actions).toEqual(['pr_creation_enqueued', 'pr_raised']);
  });

  it('the escalation deadline checker leaves pr_creation rows for PrCreationService', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, { current_status: 'accepted' });
    await seedDeadlineRow(knex, entity.id, { deadline_type: 'pr_creation' });
    const logger = mockServices.logger.mock();
    const config = buildValidEscalationConfig();
    const escalation = new DefaultEscalationService(
      store,
      createStandardOrgHierarchy(),
      config,
      clock,
      {} as any,
      {} as any,
      logger,
    );
    const checker = new DefaultDeadlineCheckerService(
      store,
      escalation,
      config,
      clock,
      logger,
    );

    await checker.processExpiredDeadlines();

    const row = await knex('pending_deadlines')
      .where({ entity_id: entity.id })
      .first();
    expect(row.processed).toBe(false);
  });

  it('processDue drains pr_creation deadlines without escalation config, exactly once under concurrency', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      actor_ref: 'user:default/alice',
    });
    const { service, prs } = buildPrService(store, clock);

    await Promise.all([service.processDue(), service.processDue()]);

    expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row.pr_status).toBe('raised');
  });

  it('an API failure records failed and schedules a retry that the next sweep picks up', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    await seedDeadlineRow(knex, entity.id, { deadline_type: 'pr_creation' });
    const prs = fakePrs({
      createPullRequest: jest
        .fn()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValueOnce({
          status: 'created',
          pr: { id: '2', url: 'https://repo/pr/2' },
        }),
    });
    const { service } = buildPrService(store, clock, prs);

    await service.processDue();

    let row = await knex('ownership_entities').where({ id: entity.id }).first();
    expect(row).toMatchObject({ pr_status: 'failed', pr_attempts: 1 });
    const retry = await knex('pending_deadlines')
      .where({
        entity_id: entity.id,
        processed: false,
        deadline_type: 'pr_creation',
      })
      .first();
    expect(new Date(retry.fire_at).getTime()).toBe(
      clock.now().getTime() + PR_RETRY_BACKOFF_MS[0],
    );

    // Not due yet.
    await service.processDue();
    expect(prs.createPullRequest).toHaveBeenCalledTimes(1);

    clock.advance(PR_RETRY_BACKOFF_MS[0]);
    await service.processDue();

    row = await knex('ownership_entities').where({ id: entity.id }).first();
    expect(row).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/2',
    });
  });

  it('a job whose process died after the lease is re-run once the lease expires (no stuck pending)', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    const deadline = await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
    });

    // Simulate a worker that leased the job and then died before recording an outcome.
    const leased = await store.withTransaction(tx =>
      tx.pendingDeadlineStore.leaseDeadline(
        deadline.id,
        clock.now(),
        new Date(clock.now().getTime() + PR_JOB_LEASE_MS),
      ),
    );
    expect(leased).toBeDefined();
    expect(
      (await knex('pending_deadlines').where({ id: deadline.id }).first())
        .processed,
    ).toBe(false);

    const { service, prs } = buildPrService(store, clock);

    // While the lease is live nobody else picks it up.
    await service.processDue();
    expect(prs.createPullRequest).not.toHaveBeenCalled();

    // After the lease expires, the next sweep recovers the job.
    clock.advance(PR_JOB_LEASE_MS);
    await service.processDue();

    expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row.pr_status).toBe('raised');
    expect(
      (await knex('pending_deadlines').where({ id: deadline.id }).first())
        .processed,
    ).toBe(true);
  });

  it('a re-run after a crash between PR creation and the state write reuses the open PR', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    await seedDeadlineRow(knex, entity.id, { deadline_type: 'pr_creation' });
    // The first run already opened the PR before dying, so Bitbucket now reports it as open.
    const prs = fakePrs({
      findOpenPullRequest: jest.fn(async () => ({
        id: '9',
        url: 'https://repo/pr/9',
      })),
      readFile: jest.fn(async () => ({
        content: CATALOG_INFO.replace('group:old-team', 'new-team'),
        revision: 'c2',
      })),
    });
    const { service } = buildPrService(store, clock, prs);

    await service.processDue();

    expect(prs.createPullRequest).not.toHaveBeenCalled();
    expect(prs.commitFile).not.toHaveBeenCalled();
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/9',
    });
  });

  describe('concurrent runs (manual Retry / re-acceptance during a running job)', () => {
    it('Retry is refused while an automatic retry is running — no second job, one PR', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date(Date.now() + 60_000));
      const { entity, deadline } = await seedFailedWithDueRetry(knex);
      const { prs, release, running } = gatedPrs({
        status: 'created',
        pr: { id: '1', url: 'https://repo/pr/1' },
      });
      const { service } = buildPrService(store, clock, prs);

      const job = service.trigger(deadline.id);
      await running;

      await expect(
        service.requestRetry(entity.id, 'user:default/bob'),
      ).rejects.toThrow(
        /pending; only failed, unsupported_scm, declined PRs can be retried/,
      );

      release();
      await job;

      expect(prs.createPullRequest).toHaveBeenCalledTimes(1);
      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row).toMatchObject({
        pr_status: 'raised',
        pr_url: 'https://repo/pr/1',
      });
      const open = await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      });
      expect(open).toHaveLength(0);
    });

    it('a run cancelled mid-flight (e.g. re-acceptance) does not overwrite state or add a retry', async () => {
      const { store, knex } = await createStore();
      const clock = new TestClock(new Date(Date.now() + 60_000));
      const { entity, deadline } = await seedFailedWithDueRetry(knex);
      const { prs, release, running } = gatedPrs(unavailable());
      const { service } = buildPrService(store, clock, prs);

      const job = service.trigger(deadline.id);
      await running;

      // A newer owner of the job takes over: cancels PR deadlines and resets state,
      // exactly as acceptProposal / requestRetry do.
      await store.withTransaction(async tx => {
        await tx.pendingDeadlineStore.lockUnprocessedForEntity(entity.id, [
          'pr_creation',
        ]);
        await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entity.id, [
          'pr_creation',
        ]);
        await tx.entityStore.updatePrState(entity.id, {
          pr_status: 'pending',
          pr_attempts: 0,
        });
      });

      release();
      await job;

      const row = await knex('ownership_entities')
        .where({ id: entity.id })
        .first();
      expect(row).toMatchObject({ pr_status: 'pending', pr_attempts: 0 });
      const open = await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      });
      expect(open).toHaveLength(0);
      const failures = await knex('ownership_history').where({
        entity_id: entity.id,
        action: 'pr_creation_failed',
      });
      expect(failures).toHaveLength(0);
    });
  });

  it('an automatic retry after a failed PR step reuses the branch it created — one branch total', async () => {
    const { store, knex } = await createStore();
    const clock = new TestClock(new Date(Date.now() + 60_000));
    const entity = await seedEntityRow(knex, {
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      current_status: 'accepted',
      assigned_to: 'group:default/new-team',
      pr_status: 'pending',
    });
    await seedDeadlineRow(knex, entity.id, { deadline_type: 'pr_creation' });
    const prs = fakePrs({
      createPullRequest: jest
        .fn()
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValueOnce({
          status: 'created',
          pr: { id: '3', url: 'https://repo/pr/3' },
        }),
    });
    const { service } = buildPrService(store, clock, prs);

    await service.processDue();
    const afterFailure = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(afterFailure.pr_status).toBe('failed');
    expect(afterFailure.pr_branch).toMatch(/^ownership\/svc-/);

    // The leftover branch now already contains the commit.
    prs.readFile.mockResolvedValue({
      content: CATALOG_INFO.replace('group:old-team', 'new-team'),
      revision: 'c2',
    });
    clock.advance(PR_RETRY_BACKOFF_MS[0]);
    await service.processDue();

    expect(prs.createBranch).toHaveBeenCalledTimes(1);
    expect(prs.commitFile).toHaveBeenCalledTimes(1);
    expect(prs.createPullRequest).toHaveBeenLastCalledWith(
      REPO,
      expect.objectContaining({ fromBranch: afterFailure.pr_branch }),
    );
    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/3',
      pr_branch: afterFailure.pr_branch,
    });
  });
});
