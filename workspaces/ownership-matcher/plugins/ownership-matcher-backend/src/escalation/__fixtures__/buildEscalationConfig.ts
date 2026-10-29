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

import { EscalationConfig, EscalationLevelConfig } from '../../config/types';

/**
 * Builder helpers for valid and invalid EscalationConfig objects.
 *
 * Used by: escalationConfig.test.ts (groups 4, 17) and any test that needs a
 * quick config stub.
 */

/** Default domain-level config using titlePatterns. */
export const DOMAIN_LEVEL: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  titlePatterns: [
    '^(Senior )?Engineering Director.*$',
    '^(Senior )?Product Director.*$',
    '^Head of Product.*$',
  ],
};

/** Default portfolio-level config using titlePatterns. */
export const PORTFOLIO_LEVEL: EscalationLevelConfig = {
  groupFilter: 'Group:portfolio',
  timeoutDays: 14,
  titlePatterns: [
    '(?:VP|Vice President).*(?:Tech|Engineering)',
    '^Senior Director.*Technology$',
  ],
};

/** Domain-level config using relations instead of titlePatterns. */
export const DOMAIN_LEVEL_RELATIONS: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  relations: ['managerOf'],
};

/**
 * Build a minimal valid EscalationConfig with two levels.
 */
export function buildValidEscalationConfig(
  overrides: Partial<EscalationConfig> = {},
): EscalationConfig {
  return {
    levels: [DOMAIN_LEVEL, PORTFOLIO_LEVEL],
    gracePeriodDays: 14,
    warningDays: 4,
    reDecisionDays: 3,
    fallbackActors: ['group:default/platform-team', 'user:default/jane.smith'],
    ...overrides,
  };
}

/**
 * Build a single-level config with the given level entry.
 */
export function buildSingleLevelConfig(
  level: EscalationLevelConfig,
  overrides: Partial<EscalationConfig> = {},
): EscalationConfig {
  return buildValidEscalationConfig({ levels: [level], ...overrides });
}

// ── Invalid config shapes for negative tests ────────────────────────────────

/** Level with both titlePatterns AND relations — mutually exclusive. */
export const LEVEL_BOTH_PATTERNS_AND_RELATIONS: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  titlePatterns: ['^Engineering Director.*$'],
  relations: ['managerOf'],
};

/** Level with neither titlePatterns nor relations. */
export const LEVEL_NO_ACTOR_MATCHING: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
};

/** Level with zero timeoutDays. */
export const LEVEL_ZERO_TIMEOUT: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 0,
  titlePatterns: ['^Engineering Director.*$'],
};

/** Level with invalid regex in titlePatterns. */
export const LEVEL_INVALID_REGEX: EscalationLevelConfig = {
  groupFilter: 'Group:domain',
  timeoutDays: 7,
  titlePatterns: ['[unclosed'],
};

/** Level with groupFilter that has an extra colon. */
export const LEVEL_EXTRA_COLON_FILTER: EscalationLevelConfig = {
  groupFilter: 'Group:domain:extra',
  timeoutDays: 7,
  titlePatterns: ['^Engineering Director.*$'],
};

/** Level with leading colon in groupFilter. */
export const LEVEL_LEADING_COLON_FILTER: EscalationLevelConfig = {
  groupFilter: ':domain',
  timeoutDays: 7,
  titlePatterns: ['^Engineering Director.*$'],
};

/** Level with empty groupFilter. */
export const LEVEL_EMPTY_FILTER: EscalationLevelConfig = {
  groupFilter: '',
  timeoutDays: 7,
  titlePatterns: ['^Engineering Director.*$'],
};

/** Config where warningDays >= gracePeriodDays. */
export function buildWarningGteGrace(
  gracePeriodDays: number,
  warningDays: number,
): EscalationConfig {
  return buildValidEscalationConfig({ gracePeriodDays, warningDays });
}

/** Config with empty levels array. */
export const CONFIG_EMPTY_LEVELS: EscalationConfig = {
  levels: [],
  gracePeriodDays: 14,
  warningDays: 4,
  reDecisionDays: 3,
};

/** Config with zero gracePeriodDays. */
export const CONFIG_ZERO_GRACE: EscalationConfig = {
  levels: [DOMAIN_LEVEL],
  gracePeriodDays: 0,
  warningDays: 4,
  reDecisionDays: 3,
};

/** Config with zero reDecisionDays. */
export const CONFIG_ZERO_REDECISION: EscalationConfig = {
  levels: [DOMAIN_LEVEL],
  gracePeriodDays: 14,
  warningDays: 4,
  reDecisionDays: 0,
};
