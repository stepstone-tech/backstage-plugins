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
 * Tests for readOwnershipMatcherConfig — notifications config slice:
 * defaults and per-field overrides.
 */

import { ConfigReader } from '@backstage/config';
import { JsonObject } from '@backstage/types';
import {
  readOwnershipMatcherConfig,
  readOwnershipEmailConfig,
  readPrCreationConfig,
} from './reader';

/**
 * Helper: builds a ConfigReader with ownershipMatcher.notifications
 * set to the given partial object.
 */
function makeConfig(notifications?: JsonObject): ConfigReader {
  const raw: JsonObject = {};
  if (notifications !== undefined) {
    raw.ownershipMatcher = { notifications };
  }
  return new ConfigReader(raw);
}

describe('readOwnershipMatcherConfig — notifications config', () => {
  // All defaults when notifications section is omitted
  it('notifications config omitted — all defaults are returned', () => {
    const config = makeConfig(undefined);
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.enabled).toBe(true);
    expect(result.notifications.channels).toEqual(['backstage']);
    expect(result.notifications.remindersEnabled).toBe(false);
    expect(result.notifications.reminderAfterDays).toBe(7);
    expect(result.notifications.acceptancePendingReminderDays).toBe(7);
  });

  // Each field individually to catch missing-default bugs
  it('enabled defaults to true', () => {
    const config = makeConfig(undefined);
    expect(readOwnershipMatcherConfig(config).notifications.enabled).toBe(true);
  });

  it('channels defaults to [backstage]', () => {
    const config = makeConfig(undefined);
    expect(readOwnershipMatcherConfig(config).notifications.channels).toEqual([
      'backstage',
    ]);
  });

  it('remindersEnabled defaults to false', () => {
    const config = makeConfig(undefined);
    expect(
      readOwnershipMatcherConfig(config).notifications.remindersEnabled,
    ).toBe(false);
  });

  it('reminderAfterDays defaults to 7', () => {
    const config = makeConfig(undefined);
    expect(
      readOwnershipMatcherConfig(config).notifications.reminderAfterDays,
    ).toBe(7);
  });

  it('acceptancePendingReminderDays defaults to 7', () => {
    const config = makeConfig(undefined);
    expect(
      readOwnershipMatcherConfig(config).notifications
        .acceptancePendingReminderDays,
    ).toBe(7);
  });

  // Enabled explicitly set to false
  it('enabled=false overrides default; other fields keep defaults', () => {
    const config = makeConfig({ enabled: false });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.enabled).toBe(false);
    expect(result.notifications.channels).toEqual(['backstage']);
    expect(result.notifications.remindersEnabled).toBe(false);
    expect(result.notifications.reminderAfterDays).toBe(7);
    expect(result.notifications.acceptancePendingReminderDays).toBe(7);
  });

  // Channels overridden
  it('channels explicitly set — overrides default, unknown values accepted silently', () => {
    const config = makeConfig({ channels: ['backstage', 'slack'] });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.channels).toEqual(['backstage', 'slack']);
    expect(result.notifications.enabled).toBe(true);
    expect(result.notifications.reminderAfterDays).toBe(7);
    expect(result.notifications.remindersEnabled).toBe(false);
  });

  // remindersEnabled overridden
  it('remindersEnabled=true enables the reminder scheduler', () => {
    const config = makeConfig({ remindersEnabled: true });
    expect(
      readOwnershipMatcherConfig(config).notifications.remindersEnabled,
    ).toBe(true);
  });

  // ReminderAfterDays overridden
  it('reminderAfterDays=14 overrides default', () => {
    const config = makeConfig({ reminderAfterDays: 14 });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.reminderAfterDays).toBe(14);
    expect(result.notifications.enabled).toBe(true);
    expect(result.notifications.channels).toEqual(['backstage']);
    expect(result.notifications.acceptancePendingReminderDays).toBe(7);
  });

  // AcceptancePendingReminderDays overridden
  it('acceptancePendingReminderDays=3 overrides default', () => {
    const config = makeConfig({ acceptancePendingReminderDays: 3 });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.acceptancePendingReminderDays).toBe(3);
    expect(result.notifications.enabled).toBe(true);
    expect(result.notifications.channels).toEqual(['backstage']);
  });

  // Full override: all fields set simultaneously
  it('full override: all fields set — each takes the configured value', () => {
    const config = makeConfig({
      enabled: false,
      channels: ['backstage', 'email'],
      remindersEnabled: true,
      reminderAfterDays: 14,
      acceptancePendingReminderDays: 3,
    });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications).toEqual({
      enabled: false,
      channels: ['backstage', 'email'],
      remindersEnabled: true,
      reminderAfterDays: 14,
      acceptancePendingReminderDays: 3,
    });
  });

  // Partial override does NOT bleed into other fields
  it('partial override: one field set does not corrupt sibling defaults', () => {
    const config = makeConfig({ enabled: false });
    const result = readOwnershipMatcherConfig(config);

    expect(result.notifications.channels).not.toBeUndefined();
    expect(result.notifications.remindersEnabled).not.toBeUndefined();
    expect(result.notifications.reminderAfterDays).not.toBeUndefined();
    expect(
      result.notifications.acceptancePendingReminderDays,
    ).not.toBeUndefined();
  });
});

describe('readOwnershipMatcherConfig — owners', () => {
  it('excludeUserKind defaults to false when owners block is omitted', () => {
    const result = readOwnershipMatcherConfig(new ConfigReader({}));
    expect(result.owners).toEqual({ excludeUserKind: false });
  });

  it.each([true, false])('excludeUserKind=%s is read as configured', value => {
    const result = readOwnershipMatcherConfig(
      new ConfigReader({
        ownershipMatcher: { owners: { excludeUserKind: value } },
      }),
    );
    expect(result.owners.excludeUserKind).toBe(value);
  });
});

describe('readOwnershipMatcherConfig — schedule', () => {
  function makeScheduleConfig(schedule?: JsonObject): ConfigReader {
    const raw: JsonObject = {};
    if (schedule !== undefined) {
      raw.ownershipMatcher = { schedule };
    }
    return new ConfigReader(raw);
  }

  it('omitted schedule block — defaults are applied', () => {
    const result = readOwnershipMatcherConfig(makeScheduleConfig(undefined));
    expect(result.schedule).toEqual({
      frequency: { hours: 24 },
      timeout: { minutes: 30 },
      initialDelay: { seconds: 30 },
    });
  });

  it('initialDelay: { hours: 1 } parses without throwing', () => {
    const result = readOwnershipMatcherConfig(
      makeScheduleConfig({
        frequency: { hours: 24 },
        timeout: { minutes: 30 },
        initialDelay: { hours: 1 },
      }),
    );
    expect(result.schedule.initialDelay).toEqual({ hours: 1 });
  });

  it('cron frequency is supported', () => {
    const result = readOwnershipMatcherConfig(
      makeScheduleConfig({
        frequency: { cron: '0 0 * * *' },
        timeout: { minutes: 30 },
      }),
    );
    expect(result.schedule.frequency).toEqual({ cron: '0 0 * * *' });
  });

  it('HumanDuration shapes (minutes/seconds/days) parse for all fields', () => {
    const result = readOwnershipMatcherConfig(
      makeScheduleConfig({
        frequency: { minutes: 15 },
        timeout: { seconds: 90 },
        initialDelay: { days: 1 },
      }),
    );
    expect(result.schedule).toEqual({
      frequency: { minutes: 15 },
      timeout: { seconds: 90 },
      initialDelay: { days: 1 },
    });
  });

  it('schedule block missing frequency throws', () => {
    expect(() =>
      readOwnershipMatcherConfig(
        makeScheduleConfig({ timeout: { minutes: 30 } }),
      ),
    ).toThrow();
  });
});

describe('readOwnershipMatcherConfig — filters.excludeKinds', () => {
  it('defaults exclude User, Group, Location, Template when no filter config is supplied', () => {
    const config = new ConfigReader({});
    const result = readOwnershipMatcherConfig(config);
    expect(result.filters.excludeKinds.sort()).toEqual([
      'Group',
      'Location',
      'Template',
      'User',
    ]);
  });

  it('explicit excludeKinds replaces the default (operator override wins)', () => {
    const config = new ConfigReader({
      ownershipMatcher: {
        filters: { excludeKinds: ['Resource', 'API'] },
      },
    });
    const result = readOwnershipMatcherConfig(config);
    expect(result.filters.excludeKinds).toEqual(['Resource', 'API']);
  });

  it('explicit empty array opts out of default exclusions (advanced operator override)', () => {
    const config = new ConfigReader({
      ownershipMatcher: { filters: { excludeKinds: [] } },
    });
    const result = readOwnershipMatcherConfig(config);
    expect(result.filters.excludeKinds).toEqual([]);
  });
});

describe('readOwnershipMatcherConfig — filters.excludeTypes', () => {
  it('defaults to no type exclusions', () => {
    const result = readOwnershipMatcherConfig(new ConfigReader({}));
    expect(result.filters.excludeTypes).toEqual([]);
  });

  it('reads configured kind:type pairs', () => {
    const config = new ConfigReader({
      ownershipMatcher: {
        filters: { excludeTypes: ['Resource:cloud-account'] },
      },
    });
    const result = readOwnershipMatcherConfig(config);
    expect(result.filters.excludeTypes).toEqual(['Resource:cloud-account']);
  });

  it.each(['cloud-account', 'Resource:', ':cloud-account', 'a:b:c'])(
    'rejects "%s", which is not in Kind:type form',
    entry => {
      const config = new ConfigReader({
        ownershipMatcher: { filters: { excludeTypes: [entry] } },
      });
      expect(() => readOwnershipMatcherConfig(config)).toThrow(
        /excludeTypes.*Kind:type/,
      );
    },
  );
});

describe('readOwnershipMatcherConfig — proposals.notificationThreshold', () => {
  it('defaults to 0.4 when proposals config is omitted', () => {
    const config = new ConfigReader({});
    const result = readOwnershipMatcherConfig(config);
    expect(result.proposals.notificationThreshold).toBe(0.4);
  });

  it('defaults to 0.4 when proposals is present but notificationThreshold is absent', () => {
    const config = new ConfigReader({
      ownershipMatcher: { proposals: { maxCandidatesPerEntity: 3 } },
    });
    const result = readOwnershipMatcherConfig(config);
    expect(result.proposals.notificationThreshold).toBe(0.4);
  });

  it('reads the configured value when present', () => {
    const config = new ConfigReader({
      ownershipMatcher: { proposals: { notificationThreshold: 0.65 } },
    });
    const result = readOwnershipMatcherConfig(config);
    expect(result.proposals.notificationThreshold).toBe(0.65);
  });
});

// ─── readOwnershipEmailConfig ──────────────────────────────────────────────────

describe('readOwnershipEmailConfig', () => {
  function makeEmailConfig(email?: JsonObject): ConfigReader {
    const raw: JsonObject = {};
    if (email !== undefined) {
      raw.ownershipMatcher = { email };
    }
    return new ConfigReader(raw);
  }

  it('returns undefined when ownershipMatcher.email block is absent', () => {
    const config = makeEmailConfig(undefined);
    expect(readOwnershipEmailConfig(config)).toBeUndefined();
  });

  it('returns undefined when the ownershipMatcher block itself is absent', () => {
    const config = new ConfigReader({});
    expect(readOwnershipEmailConfig(config)).toBeUndefined();
  });

  it('returns correct values when all fields are fully configured', () => {
    const config = makeEmailConfig({
      dryRun: true,
      supportUrl: 'https://issues.example.com/HELP',
      schedule: {
        frequency: { months: 1 },
        timeout: { minutes: 30 },
        initialDelay: { minutes: 5 },
      },
    });

    const result = readOwnershipEmailConfig(config);

    expect(result).not.toBeUndefined();
    expect(result!.dryRun).toBe(true);
    expect(result!.supportUrl).toBe('https://issues.example.com/HELP');
    expect(result!.schedule).toEqual({
      frequency: { months: 1 },
      timeout: { minutes: 30 },
      initialDelay: { minutes: 5 },
    });
  });

  it('dryRun defaults to false when omitted from config', () => {
    const config = makeEmailConfig({});

    const result = readOwnershipEmailConfig(config);

    expect(result).not.toBeUndefined();
    expect(result!.dryRun).toBe(false);
  });

  it('schedule defaults to { frequency: { months: 1 }, timeout: { minutes: 30 }, initialDelay: { minutes: 5 } } when omitted', () => {
    const config = makeEmailConfig({});

    const result = readOwnershipEmailConfig(config);

    expect(result).not.toBeUndefined();
    expect(result!.schedule).toEqual({
      frequency: { months: 1 },
      timeout: { minutes: 30 },
      initialDelay: { minutes: 5 },
    });
  });

  it('an explicit schedule block overrides the default', () => {
    const config = makeEmailConfig({
      schedule: {
        frequency: { days: 7 },
        timeout: { minutes: 10 },
      },
    });

    const result = readOwnershipEmailConfig(config);

    expect(result!.schedule.frequency).toEqual({ days: 7 });
    expect(result!.schedule.timeout).toEqual({ minutes: 10 });
  });

  it.each([
    'ftp://files.example.com/help',
    'mailto:help@example.com',
    'issues.example.com',
  ])('rejects a non-http(s) supportUrl (%s)', supportUrl => {
    expect(() =>
      readOwnershipEmailConfig(makeEmailConfig({ supportUrl })),
    ).toThrow(/supportUrl/);
  });

  it('enables the digest with defaults for an empty block (transport settings belong to the sender module)', () => {
    const result = readOwnershipEmailConfig(
      makeEmailConfig({ msgraph: { tenantId: 't' } }),
    );

    expect(result).toEqual({
      dryRun: false,
      supportUrl: undefined,
      schedule: {
        frequency: { months: 1 },
        timeout: { minutes: 30 },
        initialDelay: { minutes: 5 },
      },
    });
  });
});

describe('readPrCreationConfig', () => {
  it('defaults: enabled, 5 attempts, 24h merge grace', () => {
    expect(readPrCreationConfig(new ConfigReader({}))).toEqual({
      enabled: true,
      maxAttempts: 5,
      mergeGraceHours: 24,
    });
  });

  it('reads mergeGraceHours', () => {
    const config = new ConfigReader({
      ownershipMatcher: { prCreation: { mergeGraceHours: 6 } },
    });
    expect(readPrCreationConfig(config).mergeGraceHours).toBe(6);
  });

  it('rejects a negative mergeGraceHours', () => {
    const config = new ConfigReader({
      ownershipMatcher: { prCreation: { mergeGraceHours: -1 } },
    });
    expect(() => readPrCreationConfig(config)).toThrow(/mergeGraceHours/);
  });
});

describe('readOwnershipMatcherConfig — dangerouslyAllowAsUserOverride', () => {
  // This flag is the whole `?asUser=` trust boundary, so pin the default
  // explicitly: anything other than a literal `false` here fails open.
  it('defaults to false when the whole ownershipMatcher section is omitted', () => {
    const result = readOwnershipMatcherConfig(new ConfigReader({}));
    expect(result.dangerouslyAllowAsUserOverride).toBe(false);
  });

  it('defaults to false when the key is omitted', () => {
    const config = new ConfigReader({ ownershipMatcher: {} });
    expect(
      readOwnershipMatcherConfig(config).dangerouslyAllowAsUserOverride,
    ).toBe(false);
  });

  it('reads true', () => {
    const config = new ConfigReader({
      ownershipMatcher: { dangerouslyAllowAsUserOverride: true },
    });
    expect(
      readOwnershipMatcherConfig(config).dangerouslyAllowAsUserOverride,
    ).toBe(true);
  });

  it('reads false', () => {
    const config = new ConfigReader({
      ownershipMatcher: { dangerouslyAllowAsUserOverride: false },
    });
    expect(
      readOwnershipMatcherConfig(config).dangerouslyAllowAsUserOverride,
    ).toBe(false);
  });
});
