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

import { readSchedulerServiceTaskScheduleDefinitionFromConfig } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { EntityFilters } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  OwnershipMatcherConfig,
  ScheduleConfig,
  ChecksConfig,
  OwnersConfig,
  ProposalsConfig,
  StrategyConfig,
  ConfidenceTiersConfig,
  ContributorsConfig,
  NotificationsConfig,
  OwnershipEmailConfig,
  PrCreationConfig,
  FallbackAction,
} from './types';

// Re-exported from the node library.
export { readEscalationConfig } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

const DEFAULT_SCHEDULE: ScheduleConfig = {
  frequency: { hours: 24 },
  timeout: { minutes: 30 },
  initialDelay: { seconds: 30 },
};

const DEFAULT_STRATEGY_WEIGHTS: Record<string, number> = {
  'top-contributor': 0.5,
  'org-proximity': 0.3,
};

const DEFAULT_STRATEGIES: StrategyConfig[] = [
  { name: 'top-contributor', weight: 0.5, maxCandidates: 3 },
  { name: 'org-proximity', weight: 0.3 },
  { name: 'fallback', action: 'escalated' },
];

export function readOwnershipMatcherConfig(
  config: Config,
): OwnershipMatcherConfig {
  const root = config.getOptionalConfig('ownershipMatcher');

  // ── schedule ───────────────────────────────────────────────────────────────
  const scheduleCfg = root?.getOptionalConfig('schedule');
  const schedule: ScheduleConfig = scheduleCfg
    ? readSchedulerServiceTaskScheduleDefinitionFromConfig(scheduleCfg)
    : DEFAULT_SCHEDULE;

  // ── filters ────────────────────────────────────────────────────────────────
  // Default-exclude the four kinds that have no meaningful `spec.owner`
  // semantics — User/Group are people, Location is catalog plumbing,
  // Template is scaffolder metadata. Without this default the scanner would
  // proposse arbitrary teams as "owners" of every user in the directory.
  // Operators can override by setting `ownershipMatcher.filters.excludeKinds`
  // explicitly (which replaces, not extends, the default).
  const filtersCfg = root?.getOptionalConfig('filters');
  const DEFAULT_EXCLUDE_KINDS = ['User', 'Group', 'Location', 'Template'];
  const filters: EntityFilters = {
    excludeKinds:
      filtersCfg?.getOptionalStringArray('excludeKinds') ??
      DEFAULT_EXCLUDE_KINDS,
    requireAnnotations:
      filtersCfg?.getOptionalStringArray('requireAnnotations') ?? [],
    excludeOwners: filtersCfg?.getOptionalStringArray('excludeOwners') ?? [],
    excludeNamespaces:
      filtersCfg?.getOptionalStringArray('excludeNamespaces') ?? [],
    excludeTypes: (
      filtersCfg?.getOptionalStringArray('excludeTypes') ?? []
    ).map(entry => {
      const trimmed = entry.trim();
      if (!/^[^:\s]+:[^:\s]+$/.test(trimmed)) {
        throw new InputError(
          `ownershipMatcher.filters.excludeTypes: "${entry}" must be in "Kind:type" form, e.g. "Resource:cloud-account"`,
        );
      }
      return trimmed;
    }),
  };

  // ── checks ─────────────────────────────────────────────────────────────────
  const checksCfg = root?.getOptionalConfig('checks');
  const orphanedCfg = checksCfg?.getOptionalConfig('orphaned');
  const checks: ChecksConfig = {
    enabled: checksCfg?.getOptionalStringArray('enabled') ?? [
      'orphaned',
      'zombie',
    ],
    orphaned: {
      placeholderValues: orphanedCfg?.getOptionalStringArray(
        'placeholderValues',
      ) ?? ['unknown'],
    },
  };

  // ── owners ─────────────────────────────────────────────────────────────────
  // Default false: User owners are validated against the catalog like groups.
  const owners: OwnersConfig = {
    excludeUserKind:
      root
        ?.getOptionalConfig('owners')
        ?.getOptionalBoolean('excludeUserKind') ?? false,
  };

  // ── proposals ──────────────────────────────────────────────────────────────
  const proposalsCfg = root?.getOptionalConfig('proposals');
  const rawStrategies = proposalsCfg?.getOptionalConfigArray('strategies');
  const strategies: StrategyConfig[] = rawStrategies
    ? rawStrategies.map(s => {
        const name = s.getString('name');
        return {
          name,
          weight:
            s.getOptionalNumber('weight') ?? DEFAULT_STRATEGY_WEIGHTS[name],
          maxCandidates: s.getOptionalNumber('maxCandidates'),
          commitsLimit: s.getOptionalNumber('commitsLimit'),
          action: s.getOptionalString('action') as FallbackAction | undefined,
          owner: s.getOptionalString('owner'),
        };
      })
    : DEFAULT_STRATEGIES;

  const tiersCfg = proposalsCfg?.getOptionalConfig('confidenceTiers');
  const confidenceTiers: ConfidenceTiersConfig = {
    high: tiersCfg?.getOptionalNumber('high') ?? 0.6,
    medium: tiersCfg?.getOptionalNumber('medium') ?? 0.3,
  };

  const proposals: ProposalsConfig = {
    maxCandidatesPerEntity:
      proposalsCfg?.getOptionalNumber('maxCandidatesPerEntity') ?? 5,
    autoExpiry: proposalsCfg?.getOptionalBoolean('autoExpiry') ?? false,
    expirationDays: proposalsCfg?.getOptionalNumber('expirationDays') ?? 14,
    expirationMinutes: proposalsCfg?.getOptionalNumber('expirationMinutes'),
    minimumScoreThreshold:
      proposalsCfg?.getOptionalNumber('minimumScoreThreshold') ?? 0,
    notificationThreshold:
      proposalsCfg?.getOptionalNumber('notificationThreshold') ?? 0.4,
    confidenceTiers,
    strategies,
  };

  if (
    proposals.notificationThreshold < 0 ||
    proposals.notificationThreshold > 1
  ) {
    throw new InputError(
      `ownershipMatcher.proposals.notificationThreshold must be in [0, 1], got ${proposals.notificationThreshold}`,
    );
  }
  if (proposals.notificationThreshold < proposals.minimumScoreThreshold) {
    throw new InputError(
      `ownershipMatcher.proposals.notificationThreshold (${proposals.notificationThreshold}) must be >= minimumScoreThreshold (${proposals.minimumScoreThreshold})`,
    );
  }

  // ── contributors ───────────────────────────────────────────────────────────
  const contribCfg = root?.getOptionalConfig('contributors');
  const contributors: ContributorsConfig = {
    excludeEmails: contribCfg?.getOptionalStringArray('excludeEmails') ?? [],
    excludePatterns:
      contribCfg?.getOptionalStringArray('excludePatterns') ?? [],
    excludeUsernames:
      contribCfg?.getOptionalStringArray('excludeUsernames') ?? [],
  };

  // ── escalation ────────────────────────────────────────────────────────────
  // Escalation is read via `readEscalationConfig` (see ./escalationConfig).

  // ── notifications ──────────────────────────────────────────────────────────
  const notifCfg = root?.getOptionalConfig('notifications');
  const notifications: NotificationsConfig = {
    enabled: notifCfg?.getOptionalBoolean('enabled') ?? true,
    channels: notifCfg?.getOptionalStringArray('channels') ?? ['backstage'],
    remindersEnabled: notifCfg?.getOptionalBoolean('remindersEnabled') ?? false,
    reminderAfterDays: notifCfg?.getOptionalNumber('reminderAfterDays') ?? 7,
    acceptancePendingReminderDays:
      notifCfg?.getOptionalNumber('acceptancePendingReminderDays') ?? 7,
  };

  return {
    schedule,
    filters,
    checks,
    owners,
    proposals,
    contributors,
    notifications,
  };
}

const DEFAULT_EMAIL_SCHEDULE: ScheduleConfig = {
  frequency: { months: 1 },
  timeout: { minutes: 30 },
  initialDelay: { minutes: 5 },
};

/** `email.supportUrl` is rendered into an href, so only allow http(s). */
function readSupportUrl(emailCfg: Config): string | undefined {
  const supportUrl = emailCfg.getOptionalString('supportUrl');
  if (supportUrl !== undefined && !/^https?:\/\//i.test(supportUrl)) {
    throw new InputError(
      `ownershipMatcher.email.supportUrl must be an http(s) URL, got '${supportUrl}'`,
    );
  }
  return supportUrl;
}

/**
 * Reads `ownershipMatcher.email` from config.
 * Returns `undefined` when the block is absent (email feature disabled).
 */
export function readOwnershipEmailConfig(
  config: Config,
): OwnershipEmailConfig | undefined {
  const root = config.getOptionalConfig('ownershipMatcher');
  const emailCfg = root?.getOptionalConfig('email');
  if (!emailCfg) return undefined;

  const scheduleCfg = emailCfg.getOptionalConfig('schedule');
  const schedule: ScheduleConfig = scheduleCfg
    ? readSchedulerServiceTaskScheduleDefinitionFromConfig(scheduleCfg)
    : DEFAULT_EMAIL_SCHEDULE;

  return {
    dryRun: emailCfg.getOptionalBoolean('dryRun') ?? false,
    supportUrl: readSupportUrl(emailCfg),
    schedule,
  };
}

/** Reads `ownershipMatcher.prCreation`; absent block = enabled with defaults. */
export function readPrCreationConfig(config: Config): PrCreationConfig {
  const cfg = config
    .getOptionalConfig('ownershipMatcher')
    ?.getOptionalConfig('prCreation');
  const maxAttempts = cfg?.getOptionalNumber('maxAttempts') ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new InputError(
      'ownershipMatcher.prCreation.maxAttempts must be a positive integer',
    );
  }
  const mergeGraceHours = cfg?.getOptionalNumber('mergeGraceHours') ?? 24;
  if (!Number.isFinite(mergeGraceHours) || mergeGraceHours < 0) {
    throw new InputError(
      'ownershipMatcher.prCreation.mergeGraceHours must be a non-negative number',
    );
  }
  return {
    enabled: cfg?.getOptionalBoolean('enabled') ?? true,
    maxAttempts,
    mergeGraceHours,
  };
}
