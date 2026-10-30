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
 * Reconciliation of catalog-info PR outcomes against the catalog.
 * Runs against SQLite so the conditional writes and the candidate query are
 * exercised for real.
 */
import { mockServices, TestDatabases } from '@backstage/backend-test-utils';
import {
  ScmError,
  type ScmClient,
  type ScmPullRequest,
  type ScmPullRequestCapability,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { DatabaseOwnershipStore } from '../service/DatabaseOwnershipStore';
import {
  seedDeadlineRow,
  seedEntityRow,
  seedProposalRow,
} from '../escalation/__fixtures__/seedEntity';
import { CatalogComponent, PrStatus } from '../types';
import {
  isAcceptedOwner,
  PR_RECONCILE_INTERVAL_MS,
  PrReconciliationService,
} from './PrReconciliationService';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

const HOUR = 3_600_000;
const NOW = new Date('2026-10-08T12:00:00.000Z');
const ACCEPTED = 'group:default/team-new';
const OLD = 'team-old';
const REPO = {
  scm_type: 'bitbucketServer',
  repo_host: 'repo.example.com',
  repo_path: 'PROJ/repo',
};

describe('isAcceptedOwner', () => {
  it.each([
    ['team-new', true],
    ['group:team-new', true],
    ['group:default/Team-New', true],
    ['team-old', false],
    [undefined, false],
    ['  ', false],
    ['group:other-ns/team-new', false],
  ])('catalog owner %p → %p', (catalogOwner, expected) => {
    expect(isAcceptedOwner(catalogOwner, ACCEPTED)).toBe(expected);
  });
});

describe('PrReconciliationService', () => {
  async function setup(
    opts: {
      catalogOwner?: string | null;
      pr?: ScmPullRequest | undefined | Error;
      withScm?: boolean;
      pullRequests?: boolean;
    } = {},
  ) {
    const knex = await databases.init('SQLITE_3');
    const store = await DatabaseOwnershipStore.create({
      database: {
        getClient: async () => knex,
        migrations: { skip: false },
      } as any,
    });
    const catalog = {
      getEntityByRef: jest.fn(
        async (): Promise<CatalogComponent | undefined> =>
          opts.catalogOwner === null
            ? undefined
            : ({
                kind: 'Component',
                metadata: { name: 'svc' },
                spec:
                  opts.catalogOwner === undefined
                    ? {}
                    : { owner: opts.catalogOwner },
              } as CatalogComponent),
      ),
    };
    const getPullRequest = jest.fn(async () => {
      if (opts.pr instanceof Error) throw opts.pr;
      return opts.pr;
    });
    const client: ScmClient = {
      parseLocation: () => undefined,
      ...(opts.pullRequests === false
        ? {}
        : {
            pullRequests: {
              getPullRequest,
            } as unknown as ScmPullRequestCapability,
          }),
    };
    const scm = { clientFor: jest.fn(async () => client) };
    const clock = { now: jest.fn(() => NOW) };
    const logger = mockServices.logger.mock();
    const service = new PrReconciliationService(store, catalog, clock, logger, {
      scm: opts.withScm === false ? undefined : scm,
      mergeGraceMs: 24 * HOUR,
    });
    return {
      knex,
      store,
      service,
      catalog,
      scm,
      getPullRequest,
      logger,
      clock,
    };
  }

  async function seedAccepted(
    knex: Awaited<ReturnType<typeof setup>>['knex'],
    overrides: Parameters<typeof seedEntityRow>[1] = {},
  ) {
    const entity = await seedEntityRow(knex, {
      current_status: 'accepted',
      accepted_at: new Date(NOW.getTime() - 72 * HOUR),
      check_details: { owner: OLD },
      pr_status: 'raised',
      pr_id: '17',
      pr_url:
        'https://repo.example.com/projects/PROJ/repos/repo/pull-requests/17',
      ...REPO,
      ...overrides,
    });
    await seedProposalRow(knex, entity.id, {
      status: 'accepted',
      proposed_owner_ref: ACCEPTED,
    });
    return entity;
  }

  const row = (knex: Awaited<ReturnType<typeof setup>>['knex'], id: string) =>
    knex('ownership_entities').where({ id }).first();
  const history = (
    knex: Awaited<ReturnType<typeof setup>>['knex'],
    id: string,
  ) =>
    knex('ownership_history')
      .where({ entity_id: id })
      .select('action', 'details');

  const merged = (hoursAgo: number): ScmPullRequest => ({
    id: '17',
    url: 'u',
    state: 'merged',
    closedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
  });

  // ── Part A: catalog comparison ───────────────────────────────────────────

  it.each<PrStatus>(['raised', 'none'])(
    '%s + catalog owner = accepted team (after ref normalisation) → completed, with a history row, no SCM call',
    async prStatus => {
      const { knex, service, getPullRequest } = await setup({
        catalogOwner: 'team-new',
      });
      const entity = await seedAccepted(knex, { pr_status: prStatus });

      await service.reconcileDue();

      expect(await row(knex, entity.id)).toMatchObject({
        pr_status: 'completed',
        pr_last_error: null,
      });
      const rows = await history(knex, entity.id);
      expect(rows.map(r => r.action)).toEqual(['pr_completed']);
      expect(JSON.parse(rows[0].details)).toMatchObject({
        catalogOwner: 'team-new',
        acceptedOwner: ACCEPTED,
      });
      expect(getPullRequest).not.toHaveBeenCalled();
    },
  );

  it('catalog owner changed by someone else (the scan closed the case) → superseded, and queued PR jobs are cancelled', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: 'team-third',
    });
    const entity = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: NOW,
    });
    expect(
      await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      }),
    ).toHaveLength(1);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('superseded');
    expect((await history(knex, entity.id)).map(r => r.action)).toEqual([
      'pr_superseded',
    ]);
    const unprocessed = await knex('pending_deadlines').where({
      entity_id: entity.id,
      processed: false,
    });
    expect(unprocessed).toHaveLength(0);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('`none` + catalog still on the old owner → unchanged, only the check time is recorded', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: OLD,
    });
    const entity = await seedAccepted(knex, { pr_status: 'none' });

    await service.reconcileDue();

    const after = await row(knex, entity.id);
    expect(after.pr_status).toBe('none');
    expect(new Date(after.pr_checked_at).getTime()).toBe(NOW.getTime());
    expect(await history(knex, entity.id)).toHaveLength(0);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('an accepted case whose owner changed to another failing value is not superseded: the raised PR is still tracked', async () => {
    // Detected with owner `team-old`; someone edits it to `tbd`, which still
    // fails the checks, so the scan keeps the case accepted.
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: 'tbd',
      pr: { id: '17', url: 'u', state: 'open' },
    });
    const entity = await seedAccepted(knex);
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: NOW,
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('raised');
    expect(await history(knex, entity.id)).toHaveLength(0);
    expect(
      await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      }),
    ).toHaveLength(1);
    expect(getPullRequest).toHaveBeenCalledTimes(1);
  });

  it('an accepted case whose owner changed, with a merged PR, is failed after the grace period (not superseded)', async () => {
    const { knex, service } = await setup({
      catalogOwner: 'tbd',
      pr: merged(48),
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('failed');
    expect((await history(knex, entity.id)).map(r => r.action)).toEqual([
      'pr_not_applied',
    ]);
  });

  it('falls back to the assignee for the accepted owner', async () => {
    const { knex, service } = await setup({ catalogOwner: 'team-new' });
    const entity = await seedEntityRow(knex, {
      current_status: 'accepted',
      accepted_at: new Date(NOW.getTime() - 72 * HOUR),
      assigned_to: ACCEPTED,
      pr_status: 'none',
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('completed');
  });

  it('works without any SCM (Part A only)', async () => {
    const { knex, service } = await setup({
      catalogOwner: 'group:default/team-new',
      withScm: false,
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('completed');
  });

  it('leaves an entity that is gone from the catalog to the scan', async () => {
    const { knex, service } = await setup({ catalogOwner: null });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('raised');
  });

  it('a case the scan already closed as ownership_changed while raised is reconciled too', async () => {
    const { knex, service } = await setup({ catalogOwner: 'team-new' });
    const entity = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('completed');
  });

  it.each<PrStatus>(['failed', 'declined', 'unsupported_scm'])(
    '%s + owner fixed by hand → completed, and the queued retry is cancelled',
    async prStatus => {
      const { knex, service, getPullRequest } = await setup({
        catalogOwner: 'team-new',
      });
      const entity = await seedAccepted(knex, { pr_status: prStatus });
      await knex('ownership_entities')
        .where({ id: entity.id })
        .update({ pr_last_error: 'boom' });
      await seedDeadlineRow(knex, entity.id, {
        deadline_type: 'pr_creation',
        fire_at: NOW,
      });

      await service.reconcileDue();

      expect(await row(knex, entity.id)).toMatchObject({
        pr_status: 'completed',
        pr_last_error: null,
      });
      expect(
        await knex('pending_deadlines').where({
          entity_id: entity.id,
          processed: false,
        }),
      ).toHaveLength(0);
      expect(getPullRequest).not.toHaveBeenCalled();
    },
  );

  it('failed + owner changed by someone else → superseded once the scan closed the case, not while still accepted', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: 'team-third',
    });
    const accepted = await seedAccepted(knex, { pr_status: 'failed' });
    const closed = await seedAccepted(knex, {
      pr_status: 'failed',
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });
    await seedDeadlineRow(knex, accepted.id, {
      deadline_type: 'pr_creation',
      fire_at: NOW,
    });
    await seedDeadlineRow(knex, closed.id, {
      deadline_type: 'pr_creation',
      fire_at: NOW,
    });

    await service.reconcileDue();

    expect((await row(knex, accepted.id)).pr_status).toBe('failed');
    expect(
      await knex('pending_deadlines').where({
        entity_id: accepted.id,
        processed: false,
      }),
    ).toHaveLength(1);
    expect((await row(knex, closed.id)).pr_status).toBe('superseded');
    expect(
      await knex('pending_deadlines').where({
        entity_id: closed.id,
        processed: false,
      }),
    ).toHaveLength(0);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('a raised PR on a closed case with another owner → superseded without reading the PR', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: 'team-third',
      pr: merged(48),
    });
    const entity = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('superseded');
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('a closed case whose entity is gone from the catalog is checked once, then no more', async () => {
    const { knex, service, catalog, clock } = await setup({
      catalogOwner: null,
    });
    const entity = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      resolved_at: new Date(NOW.getTime() - HOUR),
    });

    await service.reconcileDue();
    clock.now.mockReturnValue(new Date(NOW.getTime() + 3 * HOUR));
    await service.reconcileDue();

    expect(catalog.getEntityByRef).toHaveBeenCalledTimes(1);
    const after = await row(knex, entity.id);
    expect(after.pr_status).toBe('raised');
    expect(new Date(after.pr_checked_at).getTime()).toBe(NOW.getTime());
  });

  it('a closed case last checked while still accepted is reconciled once more; one checked after closing is not', async () => {
    const { knex, service } = await setup({ catalogOwner: 'team-third' });
    const closedAt = new Date(NOW.getTime() - 2 * HOUR);
    const checkedBeforeClose = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      resolved_at: closedAt,
      pr_checked_at: new Date(closedAt.getTime() - HOUR),
    });
    const checkedAfterClose = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      resolved_at: closedAt,
      pr_checked_at: new Date(closedAt.getTime() + HOUR),
    });

    await service.reconcileDue();

    expect((await row(knex, checkedBeforeClose.id)).pr_status).toBe(
      'superseded',
    );
    expect((await row(knex, checkedAfterClose.id)).pr_status).toBe('raised');
  });

  it('a closed case is retried while the catalog lookup fails', async () => {
    const { knex, service, catalog } = await setup({
      catalogOwner: 'team-third',
    });
    const entity = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      resolved_at: new Date(NOW.getTime() - HOUR),
    });
    catalog.getEntityByRef.mockRejectedValueOnce(new Error('catalog down'));

    await service.reconcileDue();
    expect((await row(knex, entity.id)).pr_checked_at).toBeNull();
    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('superseded');
  });

  it('a case the scan closed as ownership_changed without ever being accepted is not reconciled', async () => {
    const { knex, service, catalog } = await setup({
      catalogOwner: 'team-third',
    });
    // pending/escalated/unresolved cases are auto-closed this way too
    const neverAccepted = await seedEntityRow(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      assigned_to: ACCEPTED,
      pr_status: 'none',
    });

    await service.reconcileDue();

    expect(catalog.getEntityByRef).not.toHaveBeenCalled();
    const after = await row(knex, neverAccepted.id);
    expect(after.pr_status).toBe('none');
    expect(after.pr_checked_at).toBeNull();
    expect(await history(knex, neverAccepted.id)).toHaveLength(0);
  });

  it('a case the scan closed before any PR job ran (`none`) is reconciled too', async () => {
    const { knex, service } = await setup({ catalogOwner: 'team-new' });
    const entity = await seedAccepted(knex, {
      pr_status: 'none',
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('completed');
  });

  it('a closed case is not reconciled once a newer case exists for the same entity', async () => {
    const { knex, service } = await setup({ catalogOwner: 'team-third' });
    const old = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });
    await knex('ownership_entities')
      .where({ id: old.id })
      .update({ first_detected_at: new Date(NOW.getTime() - 30 * 24 * HOUR) });
    await seedEntityRow(knex, {
      entity_ref: old.entity_ref,
      current_status: 'open',
    });

    await service.reconcileDue();

    expect((await row(knex, old.id)).pr_status).toBe('raised');
  });

  it('failed + catalog still on the old owner → stays failed (no PR state read), queued retry kept', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: OLD,
      pr: merged(48),
    });
    const entity = await seedAccepted(knex, { pr_status: 'failed' });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: NOW,
    });

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('failed');
    expect(
      await knex('pending_deadlines').where({
        entity_id: entity.id,
        processed: false,
      }),
    ).toHaveLength(1);
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('skips pending/terminal PRs, non-accepted cases and recently checked ones', async () => {
    const { knex, service, catalog } = await setup({
      catalogOwner: 'team-new',
    });
    const pending = await seedAccepted(knex, { pr_status: 'pending' });
    const completed = await seedAccepted(knex, { pr_status: 'completed' });
    const superseded = await seedAccepted(knex, { pr_status: 'superseded' });
    const open = await seedAccepted(knex, { current_status: 'open' });
    const archived = await seedAccepted(knex, {
      current_status: 'closed',
      resolution_type: 'archived',
    });
    const recent = await seedAccepted(knex, {
      pr_checked_at: new Date(NOW.getTime() - PR_RECONCILE_INTERVAL_MS / 2),
    });

    await service.reconcileDue();

    expect(catalog.getEntityByRef).not.toHaveBeenCalled();
    for (const [entity, status] of [
      [pending, 'pending'],
      [completed, 'completed'],
      [superseded, 'superseded'],
      [open, 'raised'],
      [archived, 'raised'],
      [recent, 'raised'],
    ] as const) {
      expect((await row(knex, entity.id)).pr_status).toBe(status);
    }
  });

  it('does not overwrite a PR job that started while reconciling', async () => {
    const { knex, store, service, catalog } = await setup({
      catalogOwner: 'team-new',
    });
    const entity = await seedAccepted(knex);
    catalog.getEntityByRef.mockImplementationOnce(async () => {
      await knex('ownership_entities')
        .where({ id: entity.id })
        .update({ pr_status: 'pending' });
      return {
        kind: 'Component',
        metadata: { name: 'svc' },
        spec: { owner: 'team-new' },
      } as CatalogComponent;
    });

    await service.reconcile((await store.getEntityById(entity.id))!);

    expect((await row(knex, entity.id)).pr_status).toBe('pending');
    expect(await history(knex, entity.id)).toHaveLength(0);
  });

  it('a catalog failure leaves the case untouched for the next sweep', async () => {
    const { knex, service, catalog, logger } = await setup({
      catalogOwner: 'team-new',
    });
    const entity = await seedAccepted(knex);
    catalog.getEntityByRef.mockRejectedValueOnce(new Error('catalog down'));

    await service.reconcileDue();

    const after = await row(knex, entity.id);
    expect(after).toMatchObject({ pr_status: 'raised', pr_checked_at: null });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('catalog down'),
    );
  });

  // ── Part B: PR state ─────────────────────────────────────────────────────

  it('declined PR → declined, with a history row and a readable reason', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: OLD,
      pr: {
        id: '17',
        url: 'u',
        state: 'declined',
        closedAt: new Date(NOW.getTime() - HOUR),
      },
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect(getPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'bitbucketServer',
        host: 'repo.example.com',
        path: 'PROJ/repo',
      }),
      '17',
    );
    expect(await row(knex, entity.id)).toMatchObject({
      pr_status: 'declined',
      pr_last_error: 'The pull request was declined',
    });
    expect((await history(knex, entity.id)).map(r => r.action)).toEqual([
      'pr_declined',
    ]);
  });

  it('a PR that is not found is treated as declined, naming the possible causes', async () => {
    const { knex, service } = await setup({ catalogOwner: OLD, pr: undefined });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect(await row(knex, entity.id)).toMatchObject({
      pr_status: 'declined',
      pr_last_error:
        'The pull request was not found (deleted, or the repository was moved or renamed)',
    });
  });

  it('merged PR within the grace period → still raised', async () => {
    const { knex, service } = await setup({
      catalogOwner: OLD,
      pr: merged(23),
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('raised');
  });

  it('merged PR whose change never reached the catalog → failed after the grace period', async () => {
    const { knex, service, logger } = await setup({
      catalogOwner: OLD,
      pr: merged(25),
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    const after = await row(knex, entity.id);
    expect(after.pr_status).toBe('failed');
    expect(after.pr_last_error).toMatch(
      /merged on .* but the catalog still shows spec.owner team-old instead of group:default\/team-new/,
    );
    expect((await history(knex, entity.id)).map(r => r.action)).toEqual([
      'pr_not_applied',
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('merged PR without a merge time → still raised (no grace period to measure)', async () => {
    const { knex, service } = await setup({
      catalogOwner: OLD,
      pr: {
        id: '17',
        url: 'u',
        state: 'merged',
        createdAt: new Date(NOW.getTime() - 96 * HOUR),
      },
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('raised');
  });

  it('merged PR + catalog already matching → completed, not failed', async () => {
    const { knex, service, getPullRequest } = await setup({
      catalogOwner: 'team-new',
      pr: merged(48),
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    expect((await row(knex, entity.id)).pr_status).toBe('completed');
    expect(getPullRequest).not.toHaveBeenCalled();
  });

  it('open PR → still raised', async () => {
    const { knex, service } = await setup({
      catalogOwner: OLD,
      pr: { id: '17', url: 'u', state: 'open' },
    });
    const entity = await seedAccepted(knex);

    await service.reconcileDue();

    const after = await row(knex, entity.id);
    expect(after.pr_status).toBe('raised');
    expect(after.pr_checked_at).not.toBeNull();
  });

  it.each([
    ['no SCM', { withScm: false }, {}],
    ['no pullRequests capability', { pullRequests: false }, {}],
    ['no PR id', {}, { pr_id: undefined }],
    ['no repository', {}, { scm_type: undefined }],
    ['an SCM error', { pr: new ScmError('unavailable', 'repo down') }, {}],
  ] as const)(
    'degrades gracefully with %s: stays raised',
    async (_label, opts, overrides) => {
      const { knex, service } = await setup({
        catalogOwner: OLD,
        pr: merged(48),
        ...opts,
      });
      const entity = await seedAccepted(knex, { ...overrides });
      if ('pr_id' in overrides)
        await knex('ownership_entities')
          .where({ id: entity.id })
          .update({ pr_id: null });
      if ('scm_type' in overrides)
        await knex('ownership_entities')
          .where({ id: entity.id })
          .update({ scm_type: null });

      await service.reconcileDue();

      expect((await row(knex, entity.id)).pr_status).toBe('raised');
    },
  );

  // ── KPI ──────────────────────────────────────────────────────────────────

  it('logs the loop-closed KPI over accepted cases', async () => {
    const { knex, service, logger } = await setup({ catalogOwner: 'team-new' });
    await seedAccepted(knex);
    await seedAccepted(knex, { pr_status: 'pending' });

    await service.reconcileDue();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('loop closed for 1 of 2 accepted case(s)'),
      { loopClosed: 1, acceptedTotal: 2 },
    );
  });

  it('logs the KPI again only when a case changed, or an hour after the last log', async () => {
    const { knex, service, logger, clock } = await setup({ catalogOwner: OLD });
    const kpiLogs = () =>
      logger.info.mock.calls.filter(([msg]) =>
        String(msg).includes('loop closed'),
      ).length;
    await seedAccepted(knex, { pr_status: 'none' });

    await service.reconcileDue();
    expect(kpiLogs()).toBe(1);

    clock.now.mockReturnValue(new Date(NOW.getTime() + 30 * 60_000));
    await service.reconcileDue();
    expect(kpiLogs()).toBe(1);

    // closed by the scan on another owner → superseded
    await seedAccepted(knex, {
      pr_status: 'none',
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });
    await service.reconcileDue();
    expect(kpiLogs()).toBe(2);

    clock.now.mockReturnValue(new Date(NOW.getTime() + 2 * HOUR));
    await service.reconcileDue();
    expect(kpiLogs()).toBe(3);
  });
});
