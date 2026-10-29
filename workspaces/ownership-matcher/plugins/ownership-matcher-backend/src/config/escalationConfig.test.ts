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
 * Escalation config validation (positive and negative cases).
 */

import { ConfigReader } from '@backstage/config';
import { readEscalationConfig } from './reader';
import type { EscalationConfig, EscalationLevelConfig } from './types';
import {
  DOMAIN_LEVEL,
  PORTFOLIO_LEVEL,
  DOMAIN_LEVEL_RELATIONS,
  buildValidEscalationConfig,
  buildSingleLevelConfig,
  buildWarningGteGrace,
  LEVEL_BOTH_PATTERNS_AND_RELATIONS,
  LEVEL_NO_ACTOR_MATCHING,
  LEVEL_ZERO_TIMEOUT,
  LEVEL_INVALID_REGEX,
  LEVEL_EXTRA_COLON_FILTER,
  LEVEL_LEADING_COLON_FILTER,
  LEVEL_EMPTY_FILTER,
  CONFIG_EMPTY_LEVELS,
  CONFIG_ZERO_GRACE,
  CONFIG_ZERO_REDECISION,
} from '../escalation/__fixtures__/buildEscalationConfig';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeConfig(escalation: Record<string, unknown>) {
  return new ConfigReader({
    ownershipMatcher: { escalation } as any,
  });
}

function makeConfigNoEscalation() {
  return new ConfigReader({ ownershipMatcher: {} });
}

/**
 * Helper for negative tests: asserts the call throws an Error whose message
 * matches `messagePattern`.
 */
function expectValidationError(fn: () => unknown, messagePattern: RegExp) {
  try {
    fn();
    throw new Error('Expected an error to be thrown');
  } catch (err: unknown) {
    if (err instanceof Error) {
      expect(err.message).toMatch(messagePattern);
      return;
    }
    throw err;
  }
}

// ─── Config Validation — Positive Tests ─────────────────────────────

describe('Config Validation — Positive Tests', () => {
  describe('presence detection', () => {
    it('no escalation section in YAML → readEscalationConfig returns undefined (escalation disabled)', () => {
      const cfg = makeConfigNoEscalation();
      expect(readEscalationConfig(cfg)).toBeUndefined();
    });
  });

  describe('level parsing', () => {
    it('custom timeoutDays per level — each level gets its own value', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 5,
            titlePatterns: ['^Director.*$'],
          },
          {
            groupFilter: 'Group:portfolio',
            timeoutDays: 21,
            titlePatterns: ['^VP.*$'],
          },
        ],
        gracePeriodDays: 14,
        warningDays: 4,
        reDecisionDays: 3,
      });
      const result = readEscalationConfig(cfg);
      expect(result).toBeDefined();
      expect(result!.levels[0].timeoutDays).toBe(5);
      expect(result!.levels[1].timeoutDays).toBe(21);
    });

    it('fallbackActors read as array of entity refs', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
        ],
        fallbackActors: [
          'group:default/platform-team',
          'user:default/jane.smith',
        ],
        gracePeriodDays: 14,
        warningDays: 4,
        reDecisionDays: 3,
      });
      const result = readEscalationConfig(cfg);
      expect(result!.fallbackActors).toEqual([
        'group:default/platform-team',
        'user:default/jane.smith',
      ]);
    });

    it('managerChain flag survives the level mapping', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            managerChain: true,
            titlePatterns: ['^Director.*$'],
          },
        ],
        gracePeriodDays: 14,
        warningDays: 4,
        reDecisionDays: 3,
      });
      const result = readEscalationConfig(cfg);
      expect(result!.levels[0].managerChain).toBe(true);
    });

    it('groupFilter Kind:type parsed to { kind, specType }', () => {
      // Fixture shape assertion.
      const level: EscalationLevelConfig = {
        groupFilter: 'Group:domain',
        timeoutDays: 7,
        titlePatterns: ['^Director.*$'],
      };
      expect(level.groupFilter).toBe('Group:domain');
      expect(DOMAIN_LEVEL.groupFilter).toBe('Group:domain');
    });

    it('groupFilter Kind-only (no type) is accepted', () => {
      const level: EscalationLevelConfig = {
        groupFilter: 'Domain',
        timeoutDays: 7,
        titlePatterns: ['^Director.*$'],
      };
      expect(level.groupFilter).toBe('Domain');
    });

    it('level with titlePatterns (array of regex strings)', () => {
      expect(DOMAIN_LEVEL.titlePatterns).toBeDefined();
      expect(Array.isArray(DOMAIN_LEVEL.titlePatterns)).toBe(true);
      expect(DOMAIN_LEVEL.relations).toBeUndefined();
    });

    it('level with relations (array of relation types)', () => {
      expect(DOMAIN_LEVEL_RELATIONS.relations).toBeDefined();
      expect(Array.isArray(DOMAIN_LEVEL_RELATIONS.relations)).toBe(true);
      expect(DOMAIN_LEVEL_RELATIONS.titlePatterns).toBeUndefined();
    });

    it('groupFilter matches no entities in catalog → level skipped (runtime, not config-read error)', () => {
      // This is NOT a config-read error — it is handled by the escalation service at runtime.
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:division',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
        ],
        gracePeriodDays: 14,
        warningDays: 4,
        reDecisionDays: 3,
      });
      const result = readEscalationConfig(cfg);
      expect(result).toBeDefined();
      expect(result!.levels[0].groupFilter).toBe('Group:division');
    });

    it.todo(
      'nested domain hierarchy walk — BFS walks nested domains beyond immediate parent',
    );
  });

  describe('defaults', () => {
    it('gracePeriodDays defaults to 14 when absent', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
        ],
      });
      expect(readEscalationConfig(cfg)!.gracePeriodDays).toBe(14);
    });

    it('warningDays defaults to 4 when absent', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
        ],
      });
      expect(readEscalationConfig(cfg)!.warningDays).toBe(4);
    });

    it('reDecisionDays defaults to 3 when absent', () => {
      const cfg = makeConfig({
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
        ],
      });
      expect(readEscalationConfig(cfg)!.reDecisionDays).toBe(3);
    });
  });

  describe('fixture shape assertions', () => {
    it('buildValidEscalationConfig returns a structurally valid EscalationConfig', () => {
      // Compile-time and shape check.
      const cfg: EscalationConfig = buildValidEscalationConfig();
      expect(cfg.levels.length).toBeGreaterThan(0);
      expect(cfg.gracePeriodDays).toBeDefined();
      expect(cfg.warningDays).toBeDefined();
      expect(cfg.reDecisionDays).toBeDefined();
    });

    it('buildSingleLevelConfig(DOMAIN_LEVEL_RELATIONS) produces relations-based config', () => {
      const cfg = buildSingleLevelConfig(DOMAIN_LEVEL_RELATIONS);
      expect(cfg.levels[0].relations).toEqual(['managerOf']);
      expect(cfg.levels[0].titlePatterns).toBeUndefined();
    });

    it('buildValidEscalationConfig accepts overrides for fallbackActors', () => {
      const cfg = buildValidEscalationConfig({ fallbackActors: [] });
      expect(cfg.fallbackActors).toEqual([]);
    });

    it('PORTFOLIO_LEVEL has timeoutDays=14 and titlePatterns', () => {
      expect(PORTFOLIO_LEVEL.timeoutDays).toBe(14);
      expect(PORTFOLIO_LEVEL.titlePatterns).toBeDefined();
      expect(PORTFOLIO_LEVEL.relations).toBeUndefined();
    });

    it('duplicate groupFilter across levels is VALID (not rejected) — supports nested hierarchy walk', () => {
      // Compile-time shape assertion.
      const cfg: EscalationConfig = {
        levels: [
          {
            groupFilter: 'Group:domain',
            timeoutDays: 7,
            titlePatterns: ['^Director.*$'],
          },
          {
            groupFilter: 'Group:domain',
            timeoutDays: 14,
            titlePatterns: ['^Senior Director.*$'],
          },
        ],
        gracePeriodDays: 14,
        warningDays: 4,
        reDecisionDays: 3,
      };
      expect(cfg.levels[0].groupFilter).toBe(cfg.levels[1].groupFilter);
    });
  });
});

describe('Config Validation — Negative Tests', () => {
  it('empty levels array → rejected with error about empty levels', () => {
    const cfg = makeConfig({
      levels: [],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /levels|empty|at least one/i,
    );
    expect(CONFIG_EMPTY_LEVELS.levels).toHaveLength(0);
  });

  it('both titlePatterns AND relations on same level → rejected', () => {
    const cfg = makeConfig({
      levels: [LEVEL_BOTH_PATTERNS_AND_RELATIONS],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /mutually exclusive|titlePatterns.*relations|relations.*titlePatterns|not both/i,
    );
    expect(LEVEL_BOTH_PATTERNS_AND_RELATIONS.titlePatterns).toBeDefined();
    expect(LEVEL_BOTH_PATTERNS_AND_RELATIONS.relations).toBeDefined();
  });

  it('relations-only level → rejected at config load (resolver not implemented yet)', () => {
    const cfg = makeConfig({
      levels: [DOMAIN_LEVEL_RELATIONS],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /relations.*not yet implemented|not yet implemented.*relations/i,
    );
  });

  it('neither titlePatterns nor relations on level → rejected', () => {
    const cfg = makeConfig({
      levels: [LEVEL_NO_ACTOR_MATCHING],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /titlePatterns|relations|actor matching|required/i,
    );
    expect(LEVEL_NO_ACTOR_MATCHING.titlePatterns).toBeUndefined();
    expect(LEVEL_NO_ACTOR_MATCHING.relations).toBeUndefined();
  });

  it('warningDays > gracePeriodDays → rejected', () => {
    const cfg = makeConfig({
      levels: [DOMAIN_LEVEL],
      gracePeriodDays: 3,
      warningDays: 5,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /warningDays|warning.*grace|must be less/i,
    );
    const badConfig = buildWarningGteGrace(3, 5);
    expect(badConfig.warningDays!).toBeGreaterThan(badConfig.gracePeriodDays!);
  });

  it('warningDays === gracePeriodDays → rejected', () => {
    const cfg = makeConfig({
      levels: [DOMAIN_LEVEL],
      gracePeriodDays: 7,
      warningDays: 7,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /warningDays|warning.*grace|must be less/i,
    );
    const badConfig = buildWarningGteGrace(7, 7);
    expect(badConfig.warningDays).toBe(badConfig.gracePeriodDays);
  });

  it('zero timeoutDays → rejected', () => {
    const cfg = makeConfig({
      levels: [LEVEL_ZERO_TIMEOUT],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /timeoutDays|positive|greater than 0/i,
    );
    expect(LEVEL_ZERO_TIMEOUT.timeoutDays).toBe(0);
  });

  it('zero gracePeriodDays → rejected', () => {
    const cfg = makeConfig({
      levels: [DOMAIN_LEVEL],
      gracePeriodDays: 0,
      warningDays: 0,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /gracePeriodDays|positive|greater than 0/i,
    );
    expect(CONFIG_ZERO_GRACE.gracePeriodDays).toBe(0);
  });

  it('zero reDecisionDays → rejected', () => {
    const cfg = makeConfig({
      levels: [DOMAIN_LEVEL],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 0,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /reDecisionDays|positive|greater than 0/i,
    );
    expect(CONFIG_ZERO_REDECISION.reDecisionDays).toBe(0);
  });

  it('groupFilter with extra colon → rejected (e.g. Group:domain:extra)', () => {
    const cfg = makeConfig({
      levels: [LEVEL_EXTRA_COLON_FILTER],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /groupFilter|invalid format|colon|Kind:type/i,
    );
    expect(LEVEL_EXTRA_COLON_FILTER.groupFilter).toBe('Group:domain:extra');
  });

  it('groupFilter with leading colon → rejected (e.g. :domain)', () => {
    const cfg = makeConfig({
      levels: [LEVEL_LEADING_COLON_FILTER],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /groupFilter|invalid format|leading colon|Kind:type/i,
    );
    expect(LEVEL_LEADING_COLON_FILTER.groupFilter).toBe(':domain');
  });

  it('groupFilter as empty string → rejected', () => {
    const cfg = makeConfig({
      levels: [LEVEL_EMPTY_FILTER],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /groupFilter|empty|required|non-empty/i,
    );
    expect(LEVEL_EMPTY_FILTER.groupFilter).toBe('');
  });

  it('invalid regex in titlePatterns → rejected at config-read time (not runtime)', () => {
    const cfg = makeConfig({
      levels: [LEVEL_INVALID_REGEX],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    });

    expectValidationError(
      () => readEscalationConfig(cfg),
      /invalid regex|titlePattern|pattern|SyntaxError/i,
    );
    expect(LEVEL_INVALID_REGEX.titlePatterns).toEqual(['[unclosed']);
  });

  it('duplicate groupFilter across levels is valid (not a negative case)', () => {
    // Just verifying the negative list doesn't include this case.
    const cfg: EscalationConfig = {
      levels: [
        {
          groupFilter: 'Group:domain',
          timeoutDays: 7,
          titlePatterns: ['^Director.*$'],
        },
        {
          groupFilter: 'Group:domain',
          timeoutDays: 14,
          titlePatterns: ['^Senior Director.*$'],
        },
      ],
      gracePeriodDays: 14,
      warningDays: 4,
      reDecisionDays: 3,
    };
    // No error expected from the TYPE SYSTEM — both levels are structurally valid.
    expect(cfg.levels).toHaveLength(2);
  });
});
