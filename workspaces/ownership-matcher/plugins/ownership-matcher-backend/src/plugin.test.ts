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
  mockServices,
  startTestBackend,
} from '@backstage/backend-test-utils';
import {
  createBackendModule,
  SchedulerServiceTaskScheduleDefinition,
} from '@backstage/backend-plugin-api';
import {
  CatalogService,
  ownershipMatcherNotifierExtensionPoint,
  ownershipMatcherScmExtensionPoint,
  type OwnershipEmailSender,
  type ScmProvider,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { JsonObject } from '@backstage/types';
import { ownershipMatcherPlugin } from './plugin';
import { PrCreationService, PrReconciliationService } from './pr';
import { DefaultDeadlineCheckerService } from './escalation';
import { DatabaseOwnershipStore } from './service/DatabaseOwnershipStore';
import { DryRunEmailSender } from './service/notifications/DryRunEmailSender';
import request from 'supertest';

describe('ownershipMatcherPlugin', () => {
  it('starts up and serves /entities endpoint', async () => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server).get(
      '/api/ownership-matcher/entities',
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: expect.any(Array),
      total: expect.any(Number),
    });
  });

  it('serves /scans endpoint', async () => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server).get('/api/ownership-matcher/scans');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ scans: [] });
  });

  it('returns 404 for an unknown entity id', async () => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server).get(
      '/api/ownership-matcher/entities/nonexistent-id',
    );
    expect(response.status).toBe(404);
  });

  it('returns 404 for an unknown scan id', async () => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server).get(
      '/api/ownership-matcher/scans/nonexistent-id',
    );
    expect(response.status).toBe(404);
  });

  it('triggers a scan via POST /scans/trigger and returns 202', async () => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server)
      .post('/api/ownership-matcher/scans/trigger')
      .send();
    expect(response.status).toBe(202);
    expect(response.body.status).toBe('scan_triggered');
  });

  // Auth policies match by path prefix, so an unauthenticated `/scans` or
  // `/entities` policy would also open the trigger and detail routes.
  it.each([
    ['get', '/entities'],
    ['get', '/entities/some-id'],
    ['get', '/scans'],
    ['post', '/scans/trigger'],
    ['post', '/email-digest/trigger'],
    ['get', '/definitions'],
  ] as const)('rejects unauthenticated %s %s', async (method, path) => {
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin],
    });

    const response = await request(server)
      [method](`/api/ownership-matcher${path}`)
      .set('Authorization', mockCredentials.none.header());
    expect(response.status).toBe(401);
  });
});

/** Start the plugin with a scheduler mock and return the deadline-checker task fn. */
async function startWith(prCreation?: JsonObject, extra: JsonObject = {}) {
  const scheduler = mockServices.scheduler.mock();
  const ownershipMatcher: JsonObject = {
    ...extra,
    ...(prCreation ? { prCreation } : {}),
  };
  const { server } = await startTestBackend({
    features: [
      ownershipMatcherPlugin,
      scheduler.factory,
      ...(Object.keys(ownershipMatcher).length > 0
        ? [mockServices.rootConfig.factory({ data: { ownershipMatcher } })]
        : []),
    ],
  });
  const task = scheduler.scheduleTask.mock.calls
    .map(
      ([t]) =>
        t as SchedulerServiceTaskScheduleDefinition & {
          id: string;
          fn: () => Promise<void>;
        },
    )
    .find(t => t.id === 'ownership-matcher-deadline-checker');
  return { server, task };
}

describe('ownershipMatcherPlugin — deadline sweep & PR automation wiring', () => {
  afterEach(() => jest.restoreAllMocks());

  it('always schedules the deadline checker, and drains pr_creation jobs when enabled (default)', async () => {
    const processDue = jest
      .spyOn(PrCreationService.prototype, 'processDue')
      .mockResolvedValue();
    const { task } = await startWith();

    expect(task).toBeDefined();
    await task!.fn();

    expect(processDue).toHaveBeenCalledTimes(1);
  });

  it('does not drain pr_creation jobs when prCreation is disabled (kill switch)', async () => {
    const processDue = jest
      .spyOn(PrCreationService.prototype, 'processDue')
      .mockResolvedValue();
    const { task } = await startWith({ enabled: false });

    expect(task).toBeDefined();
    await task!.fn();

    expect(processDue).not.toHaveBeenCalled();
  });

  it('runs the escalation deadline checker and the PR drain in one sweep when escalation is configured', async () => {
    const processExpired = jest
      .spyOn(DefaultDeadlineCheckerService.prototype, 'processExpiredDeadlines')
      .mockResolvedValue();
    const processDue = jest
      .spyOn(PrCreationService.prototype, 'processDue')
      .mockResolvedValue();
    const { task } = await startWith(undefined, {
      escalation: {
        levels: [
          {
            groupFilter: 'Group:domain',
            titlePatterns: ['.*Director.*'],
            timeoutDays: 7,
          },
        ],
      },
    });

    await task!.fn();

    expect(processExpired).toHaveBeenCalledTimes(1);
    expect(processDue).toHaveBeenCalledTimes(1);
  });

  it('reconciles PR outcomes on every sweep, reading PR state from the SCM only when prCreation is enabled', async () => {
    const scmSeen: unknown[] = [];
    const reconcileDue = jest
      .spyOn(PrReconciliationService.prototype, 'reconcileDue')
      .mockImplementation(async function (this: PrReconciliationService) {
        scmSeen.push(
          (this as unknown as { options: { scm?: unknown } }).options.scm,
        );
      });
    const enabled = await startWith();
    const disabled = await startWith({ enabled: false });

    await enabled.task!.fn();
    await disabled.task!.fn();

    expect(reconcileDue).toHaveBeenCalledTimes(2);
    expect(scmSeen[0]).toBeDefined();
    expect(scmSeen[1]).toBeUndefined();
  });

  it('a failing sweep step does not skip the later ones, and the run still fails', async () => {
    jest
      .spyOn(PrCreationService.prototype, 'processDue')
      .mockRejectedValue(new Error('db down'));
    const reconcileDue = jest
      .spyOn(PrReconciliationService.prototype, 'reconcileDue')
      .mockResolvedValue();
    const { task } = await startWith();

    await expect(task!.fn()).rejects.toThrow(
      'PR creation jobs failed: db down',
    );

    expect(reconcileDue).toHaveBeenCalledTimes(1);
  });

  it('mounts the PR retry route only when prCreation is enabled', async () => {
    const enabled = await startWith();
    const disabled = await startWith({ enabled: false });

    const path = '/api/ownership-matcher/entities/nonexistent-id/pr/retry';
    // Enabled: the route exists and reaches the entity lookup (404 entity).
    const onRes = await request(enabled.server).post(path).send();
    // Disabled: the route reports the feature as off.
    const offRes = await request(disabled.server).post(path).send();

    expect(onRes.status).toBe(404);
    expect(onRes.body.error?.message).toMatch(
      /Entity nonexistent-id not found/,
    );
    expect(offRes.status).toBe(404);
    expect(offRes.body.error?.message).toMatch(/PR automation is disabled/);
  });
});

describe('ownershipMatcherPlugin — SCM extension point', () => {
  const provider = (type: string): ScmProvider => ({
    type,
    createClient: () => ({ parseLocation: () => undefined }),
  });
  const moduleAdding = (moduleId: string, ...providers: ScmProvider[]) =>
    createBackendModule({
      pluginId: 'ownership-matcher',
      moduleId,
      register(env) {
        env.registerInit({
          deps: { scm: ownershipMatcherScmExtensionPoint },
          async init({ scm }) {
            providers.forEach(p => scm.addProvider(p));
          },
        });
      },
    });

  it('starts without any provider module and logs a single warning', async () => {
    const logger = mockServices.logger.mock();
    const { server } = await startTestBackend({
      features: [ownershipMatcherPlugin, logger.factory],
    });

    const response = await request(server).get(
      '/api/ownership-matcher/entities',
    );
    expect(response.status).toBe(200);
    const warnings = logger.warn.mock.calls.filter(([m]) =>
      /No ownership-matcher SCM provider/.test(String(m)),
    );
    expect(warnings).toHaveLength(1);
  });

  it('accepts providers from a module and does not warn', async () => {
    const logger = mockServices.logger.mock();
    await startTestBackend({
      features: [
        ownershipMatcherPlugin,
        logger.factory,
        moduleAdding('scm-a', provider('bitbucketServer')),
      ],
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(/No ownership-matcher SCM provider/),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Ownership-matcher SCM providers: bitbucketServer',
    );
  });

  it('refuses a second provider for the same type', async () => {
    await expect(
      startTestBackend({
        features: [
          ownershipMatcherPlugin,
          moduleAdding('scm-a', provider('gitlab')),
          moduleAdding('scm-b', provider('gitlab')),
        ],
      }),
    ).rejects.toThrow(/SCM provider for type 'gitlab' is already registered/);
  });
});

describe('ownershipMatcherPlugin — email sender extension point', () => {
  afterEach(() => jest.restoreAllMocks());

  const DIGEST_TASK = 'ownership-matcher-email-digest';
  const senderModule = (moduleId: string, sender: OwnershipEmailSender) =>
    createBackendModule({
      pluginId: 'ownership-matcher',
      moduleId,
      register(env) {
        env.registerInit({
          deps: { notifier: ownershipMatcherNotifierExtensionPoint },
          async init({ notifier }) {
            notifier.setEmailSender(sender);
          },
        });
      },
    });
  const fakeSender = () => ({
    sendEmail: jest.fn().mockResolvedValue({ success: true }),
  });

  async function startWithEmail(
    email: JsonObject | undefined,
    ...modules: ReturnType<typeof senderModule>[]
  ) {
    const scheduler = mockServices.scheduler.mock();
    const logger = mockServices.logger.mock();
    const { server } = await startTestBackend({
      features: [
        ownershipMatcherPlugin,
        scheduler.factory,
        logger.factory,
        mockServices.rootConfig.factory({
          data: {
            app: { baseUrl: 'https://portal.example.com', title: 'Dev Portal' },
            ...(email ? { ownershipMatcher: { email } } : {}),
          },
        }),
        ...modules,
      ],
    });
    const task = scheduler.scheduleTask.mock.calls
      .map(([t]) => t as { id: string; fn: () => Promise<void> })
      .find(t => t.id === DIGEST_TASK);
    return { server, task, logger };
  }

  it('schedules the digest and delivers through the registered sender', async () => {
    jest
      .spyOn(DatabaseOwnershipStore.prototype, 'listPendingProposalsForEmail')
      .mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ] as any);
    jest.spyOn(CatalogService.prototype, 'getEntityByRef').mockResolvedValue({
      kind: 'Group',
      metadata: { name: 'team-a' },
      spec: { profile: { email: 'team-a@example.com', displayName: 'Team A' } },
    } as any);
    const sender = fakeSender();

    const { task } = await startWithEmail({}, senderModule('email-a', sender));
    expect(task).toBeDefined();
    await task!.fn();

    expect(sender.sendEmail).toHaveBeenCalledTimes(1);
    expect(sender.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'team-a@example.com',
        subject: expect.stringMatching(/^Dev Portal: /),
      }),
    );
  });

  it('does not schedule the digest or mount its trigger when no sender is installed', async () => {
    const { server, task, logger } = await startWithEmail({});

    expect(task).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/no email sender is registered/),
    );
    const response = await request(server)
      .post('/api/ownership-matcher/email-digest/trigger')
      .send();
    expect(response.status).toBe(404);
  });

  it('runs a dry-run digest without a sender module', async () => {
    const send = jest.spyOn(DryRunEmailSender.prototype, 'sendEmail');
    const { task } = await startWithEmail({ dryRun: true });

    expect(task).toBeDefined();
    await task!.fn();
    expect(send).not.toHaveBeenCalled(); // no pending proposals in a fresh DB
  });

  it('prefers the dry-run sender over a registered one when dryRun is true', async () => {
    jest
      .spyOn(DatabaseOwnershipStore.prototype, 'listPendingProposalsForEmail')
      .mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ] as any);
    jest.spyOn(CatalogService.prototype, 'getEntityByRef').mockResolvedValue({
      kind: 'Group',
      metadata: { name: 'team-a' },
      spec: { profile: { email: 'team-a@example.com' } },
    } as any);
    const dryRun = jest
      .spyOn(DryRunEmailSender.prototype, 'sendEmail')
      .mockResolvedValue({ success: true });
    const sender = fakeSender();

    const { task } = await startWithEmail(
      { dryRun: true },
      senderModule('email-a', sender),
    );
    await task!.fn();

    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(sender.sendEmail).not.toHaveBeenCalled();
  });

  it('does not schedule the digest when ownershipMatcher.email is absent, even with a sender', async () => {
    const { task, logger } = await startWithEmail(
      undefined,
      senderModule('email-a', fakeSender()),
    );

    expect(task).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/set ownershipMatcher.email config to enable/),
    );
  });

  it('refuses a second email sender module', async () => {
    await expect(
      startTestBackend({
        features: [
          ownershipMatcherPlugin,
          senderModule('email-a', fakeSender()),
          senderModule('email-b', fakeSender()),
        ],
      }),
    ).rejects.toThrow(/email sender is already registered/);
  });
});

/** Start the plugin with the given `ownershipMatcher` config; returns the logger mock. */
async function startWithConfig(ownershipMatcher: JsonObject) {
  const logger = mockServices.logger.mock();
  await startTestBackend({
    features: [
      ownershipMatcherPlugin,
      logger.factory,
      mockServices.rootConfig.factory({ data: { ownershipMatcher } }),
    ],
  });
  return logger;
}

describe('ownershipMatcherPlugin — catalog conventions wiring', () => {
  const MANAGER_CHAIN_WARNING = /Manager-chain escalation is disabled/;
  const escalation = {
    levels: [
      {
        groupFilter: 'Group:domain',
        timeoutDays: 7,
        titlePatterns: ['Director'],
        managerChain: true,
      },
    ],
  };

  it('warns at startup when a managerChain level is configured without the manager annotations', async () => {
    const logger = await startWithConfig({ escalation });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(MANAGER_CHAIN_WARNING),
    );
  });

  it('does not warn when the alias and manager annotations are configured', async () => {
    const logger = await startWithConfig({
      escalation,
      catalog: {
        annotations: {
          userAlias: 'example.com/alias',
          manager: 'example.com/manager-alias',
        },
      },
    });
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringMatching(MANAGER_CHAIN_WARNING),
    );
  });
});
