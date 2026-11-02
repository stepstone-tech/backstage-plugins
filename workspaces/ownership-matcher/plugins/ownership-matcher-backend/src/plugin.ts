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
  coreServices,
  createBackendPlugin,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { eventsServiceRef } from '@backstage/plugin-events-node';
import { notificationService } from '@backstage/plugin-notifications-node';
import { CatalogClient } from '@backstage/catalog-client';
import { createRouter } from './router';
import { DatabaseOwnershipStore } from './service/DatabaseOwnershipStore';
import { createAuthenticatedFetch } from './service/createAuthenticatedFetch';
import {
  CatalogService,
  ownershipChecksExtensionPoint,
  ownershipMatcherNotifierExtensionPoint,
  ownershipMatcherScmExtensionPoint,
  type OwnershipEmailSender,
  ownershipProposalStrategiesExtensionPoint,
  readCatalogConventions,
  type ScmProvider,
  warnIfManagerChainUnavailable,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ContributorService } from './service/ContributorService';
import { ScmRegistry } from './scm';
import { ProposalGenerationService } from './service/ProposalGenerationService';
import { ProposalLifecycleService } from './service/ProposalLifecycleService';
import { DefaultOwnershipMatcherService } from './service/OwnershipMatcherService';
import { EntityProcessingService } from './service/EntityProcessingService';
import {
  BackstageNotifier,
  OwnershipNotificationService,
  ReminderScheduler,
} from './service/notifications';
import { OrphanedCheck } from './checks/OrphanedCheck';
import { ZombieCheck } from './checks/ZombieCheck';
import { OwnershipCheck } from './checks/types';
import { ProposalStrategy } from './proposals/types';
import { TopContributorStrategy } from './proposals/TopContributorStrategy';
import { OrgProximityStrategy } from './proposals/OrgProximityStrategy';
import { FallbackStrategy } from './proposals/FallbackStrategy';
import { readOwnershipMatcherConfig } from './config';
import {
  readEscalationConfig,
  readOwnershipEmailConfig,
  readPrCreationConfig,
} from './config/reader';
import {
  CatalogEntityValidator,
  PrCreationService,
  PrReconciliationService,
} from './pr';
import { OwnershipEmailTask } from './service/notifications/OwnershipEmailTask';
import { DryRunEmailSender } from './service/notifications/DryRunEmailSender';
import { ownershipMatcherAdminPermission } from './permissions';
import {
  DefaultDeadlineCheckerService,
  DefaultEscalationService,
  type DeadlineCheckerService,
  FallbackEscalationTrigger,
  LazyEscalationTrigger,
  SystemClock,
} from './escalation';

// ─── Plugin ───────────────────────────────────────────────────────────────────

const DEFAULT_SCHEDULE = {
  frequency: { hours: 24 },
  timeout: { minutes: 30 },
  initialDelay: { minutes: 15 },
};

const DEADLINE_CHECKER_SCHEDULE = {
  // a polling sweep, not an interactive trigger. 15min keeps the load on
  // `pending_deadlines` low enough for steady-state operation.
  frequency: { minutes: 15 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 60 },
};

/**
 * One deadline-checker tick: escalation deadlines (when escalation is
 * configured), catalog-info PR jobs (when PR automation is enabled), then the
 * PR outcome reconciliation.
 * Gating the PR drain means disabling prCreation also stops already-queued
 * jobs and retries from reaching the SCM; they resume if re-enabled.
 * Each step is isolated: one failing (logged) does not skip the others; the
 * run still fails afterwards, so the scheduler reports it.
 */
async function runDeadlineSweep(
  logger: LoggerService,
  deadlineChecker: DeadlineCheckerService | undefined,
  prCreation: PrCreationService | undefined,
  prReconciliation: PrReconciliationService,
): Promise<void> {
  logger.info('Ownership deadline checker: starting...');
  const steps: Array<[string, (() => Promise<void>) | undefined]> = [
    [
      'escalation deadlines',
      deadlineChecker && (() => deadlineChecker.processExpiredDeadlines()),
    ],
    ['PR creation jobs', prCreation && (() => prCreation.processDue())],
    ['PR reconciliation', () => prReconciliation.reconcileDue()],
  ];
  const failures: string[] = [];
  for (const [name, step] of steps) {
    if (!step) continue;
    try {
      await step();
    } catch (err) {
      const message = `${name} failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger.error(`Ownership deadline checker: ${message}`);
      failures.push(message);
    }
  }
  // Still a failed run for the scheduler, once every step had its turn.
  if (failures.length > 0) {
    throw new Error(`Ownership deadline checker: ${failures.join('; ')}`);
  }
}

/** ownershipMatcherPlugin backend plugin */
export const ownershipMatcherPlugin = createBackendPlugin({
  pluginId: 'ownership-matcher',
  register(env) {
    const extraChecks: OwnershipCheck[] = [];
    const extraStrategies: ProposalStrategy[] = [];
    const scmProviders = new Map<string, ScmProvider>();
    let emailSender: OwnershipEmailSender | undefined;

    env.registerExtensionPoint(ownershipChecksExtensionPoint, {
      addCheck(check) {
        extraChecks.push(check);
      },
    });

    env.registerExtensionPoint(ownershipProposalStrategiesExtensionPoint, {
      addStrategy(strategy) {
        extraStrategies.push(strategy);
      },
    });

    env.registerExtensionPoint(ownershipMatcherScmExtensionPoint, {
      addProvider(provider) {
        if (scmProviders.has(provider.type)) {
          throw new Error(
            `An ownership-matcher SCM provider for type '${provider.type}' is already registered`,
          );
        }
        scmProviders.set(provider.type, provider);
      },
    });

    env.registerExtensionPoint(ownershipMatcherNotifierExtensionPoint, {
      setEmailSender(sender) {
        if (emailSender) {
          throw new Error(
            'An ownership-matcher email sender is already registered; install only one email sender module',
          );
        }
        emailSender = sender;
      },
    });

    env.registerInit({
      deps: {
        auth: coreServices.auth,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        userInfo: coreServices.userInfo,
        permissions: coreServices.permissions,
        permissionsRegistry: coreServices.permissionsRegistry,
        discovery: coreServices.discovery,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        scheduler: coreServices.scheduler,
        events: eventsServiceRef,
        notifications: notificationService,
      },
      async init({
        auth,
        httpAuth,
        httpRouter,
        userInfo,
        permissions,
        permissionsRegistry,
        discovery,
        config,
        logger,
        database,
        scheduler,
        events,
        notifications,
      }) {
        const pluginConfig = readOwnershipMatcherConfig(config);
        const catalogConventions = readCatalogConventions(config);

        // Warn once at startup rather than per request: a per-request warning
        // is a log-flood vector, and it's a misconfigured deployment — not a
        // single call — that this needs to catch.
        if (pluginConfig.dangerouslyAllowAsUserOverride) {
          logger.warn(
            'Ownership matcher: the ?asUser= identity override is ENABLED. Any authenticated ' +
              "user can read any other user's managed subtree via /leadership/*, bypassing the " +
              'admin permission gate. Never enable it outside local development.',
          );
        }

        // ── Infrastructure ──────────────────────────────────────────────────
        const store = await DatabaseOwnershipStore.create({ database });
        const catalogClient = new CatalogClient({
          discoveryApi: discovery,
          fetchApi: createAuthenticatedFetch(auth, 'catalog'),
        });
        const catalogService = new CatalogService(
          catalogClient,
          logger,
          catalogConventions,
        );

        // ── SCM providers ──────────────────────────────────────
        const scmRegistry = ScmRegistry.fromConfig(
          config,
          scmProviders.values(),
          logger,
        );
        if (scmRegistry.providerTypes.length === 0) {
          logger.warn(
            'No ownership-matcher SCM provider modules are installed: top-contributor proposals ' +
              'are disabled and catalog-info PR jobs end as unsupported_scm.',
          );
        } else {
          logger.info(
            `Ownership-matcher SCM providers: ${scmRegistry.providerTypes.join(
              ', ',
            )}`,
          );
        }
        const contributorService = new ContributorService(
          catalogService,
          logger,
          pluginConfig.contributors,
          catalogConventions.userAliasAnnotation,
        );

        // ── Checks ──────────────────────────────────────────────────────────
        const checks: OwnershipCheck[] = [
          new OrphanedCheck(),
          new ZombieCheck({
            excludeUserKind: pluginConfig.owners.excludeUserKind,
          }),
          ...extraChecks,
        ];

        // ── Proposal strategies ─────────────────────────────────────────────
        // Built-in strategies respect config order (strategies array).
        // External strategies are appended after built-ins.
        const strategyMap = new Map<string, ProposalStrategy>();

        const builtInFactories: Record<string, () => ProposalStrategy> = {
          'top-contributor': () => {
            const stratCfg = pluginConfig.proposals.strategies.find(
              s => s.name === 'top-contributor',
            );
            return new TopContributorStrategy(
              scmRegistry,
              contributorService,
              logger,
              stratCfg?.maxCandidates ?? 3,
              stratCfg?.commitsLimit ?? 25,
            );
          },
          'org-proximity': () =>
            new OrgProximityStrategy(catalogService, logger),
          fallback: () => {
            const stratCfg = pluginConfig.proposals.strategies.find(
              s => s.name === 'fallback',
            );
            return new FallbackStrategy(
              stratCfg?.action ?? 'escalated',
              stratCfg?.owner,
            );
          },
        };

        const orderedStrategies: ProposalStrategy[] = [];
        for (const stratCfg of pluginConfig.proposals.strategies) {
          if (!strategyMap.has(stratCfg.name)) {
            const factory = builtInFactories[stratCfg.name];
            if (factory) {
              const instance = factory();
              strategyMap.set(stratCfg.name, instance);
              orderedStrategies.push(instance);
            }
          }
        }
        // External strategies go at the end, before fallback if present.
        const fallbackIndex = orderedStrategies.findIndex(
          s => s.name === 'fallback',
        );
        if (fallbackIndex >= 0) {
          orderedStrategies.splice(fallbackIndex, 0, ...extraStrategies);
        } else {
          orderedStrategies.push(...extraStrategies);
        }

        // ── Services ────────────────────────────────────────────────────────
        const clock = new SystemClock();
        const escalationConfig = readEscalationConfig(config);
        warnIfManagerChainUnavailable(
          escalationConfig,
          catalogConventions,
          logger,
        );

        const proposalGenerationService = new ProposalGenerationService(
          store,
          orderedStrategies,
          pluginConfig.proposals,
          logger,
          catalogService,
          clock,
        );

        // Lazy holder breaks the construction cycle: EntityProcessingService
        // takes the trigger as a constructor arg, but EscalationService is
        // built later because it depends on services constructed below.
        // `set` must run before the scheduler kicks off and before the
        // router mounts — both happen later in this init.
        const lazyEscalationTrigger = new LazyEscalationTrigger();

        const entityProcessingService = new EntityProcessingService(
          scmRegistry,
          proposalGenerationService,
          store,
          checks,
          new Set(pluginConfig.checks.enabled),
          logger,
          events,
          lazyEscalationTrigger,
          catalogService,
        );

        const scanService = new DefaultOwnershipMatcherService(
          catalogService,
          entityProcessingService,
          store,
          pluginConfig,
          logger,
          events,
          contributorService,
        );

        // ── Escalation wiring ──────────────────────
        // `escalationConfig` (read above) returns `undefined` when the YAML
        // lacks the `escalation` block; in that case the feature is disabled
        // and we skip wiring the escalation service, deadline checker, and
        // the scheduler task. The router's escalation routes only mount when
        // `escalationService` is supplied.

        // ── Catalog-info PR automation ─────────────────────────
        // `undefined` when disabled: nothing is enqueued, drained or retried.
        const prCreationConfig = readPrCreationConfig(config);
        const prCreationService = prCreationConfig.enabled
          ? new PrCreationService(
              store,
              scmRegistry,
              catalogService,
              new CatalogEntityValidator(catalogClient, auth),
              clock,
              logger,
              {
                maxAttempts: prCreationConfig.maxAttempts,
                appTitle: config.getOptionalString('app.title'),
              },
            )
          : undefined;
        // Always on: comparing with the catalog needs no SCM. PR state is
        // only read from the SCM while PR automation is enabled.
        const prReconciliationService = new PrReconciliationService(
          store,
          catalogService,
          clock,
          logger,
          {
            scm: prCreationConfig.enabled ? scmRegistry : undefined,
            mergeGraceMs: prCreationConfig.mergeGraceHours * 60 * 60 * 1000,
          },
        );

        const lifecycleService = new ProposalLifecycleService(
          store,
          logger,
          events,
          escalationConfig,
          lazyEscalationTrigger,
          prCreationService,
        );

        // ── Notifications wiring ────────────────────────────────────────────
        const notifier = new BackstageNotifier(
          catalogService,
          notifications,
          logger,
        );

        const ownershipNotificationService = new OwnershipNotificationService(
          notifier,
          store,
          events,
          logger,
          pluginConfig.notifications,
        );
        await ownershipNotificationService.init();

        if (pluginConfig.notifications.remindersEnabled) {
          const reminderScheduler = new ReminderScheduler(
            events,
            store,
            logger,
            pluginConfig.notifications,
          );
          await reminderScheduler.register(scheduler);
        }

        const escalationService = escalationConfig
          ? new DefaultEscalationService(
              store,
              catalogService,
              escalationConfig,
              clock,
              scanService,
              proposalGenerationService,
              logger,
              events,
              prCreationService,
            )
          : undefined;
        const deadlineCheckerService = escalationService
          ? new DefaultDeadlineCheckerService(
              store,
              escalationService,
              escalationConfig!,
              clock,
              logger,
              events,
            )
          : undefined;

        // Critical ordering: wire the real trigger before the scheduler kicks
        // off any scan task and before the router mounts the proposal-reject
        // route. Without this, the first scan or first reject would throw
        // "escalation trigger accessed before wiring complete".
        lazyEscalationTrigger.set(
          escalationService ?? new FallbackEscalationTrigger(store, logger),
        );

        // ── Startup failover: mark orphaned scans as failed ─────────────────
        const staleCount = await store.failStaleScans();
        if (staleCount > 0) {
          logger.warn(
            `Marked ${staleCount} stale scan(s) as failed from previous run`,
          );
        }

        // ── Scheduled tasks ─────────────────────────────────────────────────
        await scheduler.scheduleTask({
          id: 'ownership-matcher-scan',
          ...DEFAULT_SCHEDULE,
          ...pluginConfig.schedule,
          fn: async () => {
            logger.info('Ownership scan: starting...');
            await scanService.runScan();
          },
        });

        // Always scheduled: `pr_creation` deadlines must drain even when
        // escalation (and therefore the escalation deadline handlers) is off.
        await scheduler.scheduleTask({
          id: 'ownership-matcher-deadline-checker',
          ...DEADLINE_CHECKER_SCHEDULE,
          fn: () =>
            runDeadlineSweep(
              logger,
              deadlineCheckerService,
              prCreationService,
              prReconciliationService,
            ),
        });

        // ── Permissions ─────────────────────────────────────────────────────
        permissionsRegistry.addPermissions([ownershipMatcherAdminPermission]);

        // ── Ownership email digest ───────────────────────────────────────────
        const emailConfig = readOwnershipEmailConfig(config);
        let ownershipEmailTask: OwnershipEmailTask | undefined;
        // Dry run needs no transport; otherwise a sender module must be installed.
        const sender = emailConfig?.dryRun
          ? new DryRunEmailSender(logger)
          : emailSender;
        if (emailConfig && sender) {
          const appBaseUrl = config.getString('app.baseUrl');
          ownershipEmailTask = new OwnershipEmailTask(
            store,
            catalogService,
            emailConfig,
            sender,
            appBaseUrl,
            logger,
            config.getOptionalString('app.title'),
          );
          await scheduler.scheduleTask({
            id: 'ownership-matcher-email-digest',
            ...emailConfig.schedule,
            scope: 'global',
            fn: async () => {
              await ownershipEmailTask!.run();
            },
          });
          logger.info('Ownership email digest task registered');
        } else if (emailConfig) {
          // Configured but not deliverable: warn, since the digest silently
          // stopping (e.g. a sender module's config moved) is easy to miss.
          logger.warn(
            'Ownership email digest disabled — ownershipMatcher.email is set but no email sender ' +
              'is registered (see "Registering an email sender" in the ownership-matcher-backend README)',
          );
        } else {
          logger.info(
            'Ownership email digest disabled — set ownershipMatcher.email config to enable',
          );
        }

        // ── HTTP router ─────────────────────────────────────────────────────
        httpRouter.use(
          await createRouter({
            httpAuth,
            userInfo,
            permissions,
            store,
            lifecycleService,
            scanService,
            catalogService,
            escalationConfig,
            escalationService,
            escalationTrigger: lazyEscalationTrigger,
            prCreationService,
            checks,
            strategies: orderedStrategies,
            ownershipEmailTask,
            allowAsUserOverride: pluginConfig.dangerouslyAllowAsUserOverride,
          }),
        );
        // No unauthenticated auth policies: auth policies match by path
        // prefix, so e.g. `/scans` would also open `POST /scans/trigger`.
      },
    });
  },
});
