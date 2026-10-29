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

import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { z } from 'zod';
import { compileConfigRegex } from '../utils/regex';
import { EscalationConfig, EscalationLevelConfig } from './types';

// ─── Zod schemas for escalation validation ──────────────────────────────────
//
// satisfies; refines run AFTER base type-checks so the error chain stays
// readable.

const positiveInt = z
  .number()
  .int('must be an integer')
  .positive('must be a positive integer (greater than 0)');

/**
 * Schema for a non-empty list of regex `titlePatterns`, validating each entry
 * compiles. Used by the escalation-level schema and exported for module
 * config readers via {@link validateTitlePatterns}.
 */
export const titlePatternsSchema = z
  .array(z.string().min(1, 'titlePattern must be non-empty'))
  .min(1, 'titlePatterns must contain at least one entry')
  .superRefine((patterns, ctx) => {
    // Invalid regex must fail at config-read time, not runtime.
    patterns.forEach((p, i) => {
      try {
        compileConfigRegex(p);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `invalid regex titlePattern ${JSON.stringify(p)}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    });
  });

/**
 * Validates a `titlePatterns`-shaped string array against
 * {@link titlePatternsSchema}, throwing `InputError` with `path` prefixed for a
 * clear config-key trail.
 */
export function validateTitlePatterns(raw: string[], path: string): string[] {
  const parsed = titlePatternsSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => {
        const suffix = i.path.length > 0 ? `[${i.path.join('.')}]` : '';
        return `${suffix}: ${i.message}`;
      })
      .join('; ');
    throw new InputError(`Invalid ${path}: ${issues}`);
  }
  return parsed.data;
}

// colon, and extra colons are all rejected.
const GROUP_FILTER_REGEX = /^[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z][A-Za-z0-9-]*)?$/;
const groupFilterSchema = z
  .string()
  .min(1, 'groupFilter must be non-empty')
  .regex(
    GROUP_FILTER_REGEX,
    'groupFilter must be of the form "Kind" or "Kind:type" (no leading colon, no extra colons)',
  );

const escalationLevelSchema = z
  .object({
    groupFilter: groupFilterSchema,
    timeoutDays: positiveInt,
    titlePatterns: titlePatternsSchema.optional(),
    relations: z.array(z.string().min(1)).min(1).optional(),
    managerChain: z.boolean().optional(),
  })
  .strict()
  .superRefine((level, ctx) => {
    const hasTitlePatterns =
      level.titlePatterns !== undefined && level.titlePatterns.length > 0;
    const hasRelations =
      level.relations !== undefined && level.relations.length > 0;
    if (hasTitlePatterns && hasRelations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'titlePatterns and relations are mutually exclusive — set exactly one ',
      });
    }
    if (!hasTitlePatterns && !hasRelations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'level requires actor matching: set either titlePatterns or relations',
      });
    }
    // The relations resolver is not yet implemented — rejecting at config
    // load is louder than silently skipping every level at runtime. The
    // mutual-exclusivity check above already rules out the both-set case.
    if (hasRelations) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'relations-based actor resolution is not yet implemented; use titlePatterns',
      });
    }
  });

const escalationConfigSchema = z
  .object({
    levels: z
      .array(escalationLevelSchema)
      .min(1, 'levels must contain at least one entry'),
    fallbackActors: z.array(z.string().min(1)).optional(),
    gracePeriodDays: positiveInt.optional(),
    warningDays: positiveInt.optional(),
    reDecisionDays: positiveInt.optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const grace = cfg.gracePeriodDays ?? 14;
    const warning = cfg.warningDays ?? 4;
    if (warning >= grace) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['warningDays'],
        message: `warningDays (${warning}) must be less than gracePeriodDays (${grace})`,
      });
    }
  });

/** Reads and validates the `ownershipMatcher.escalation` block. */
export function readEscalationConfig(
  config: Config,
): EscalationConfig | undefined {
  // disabled, not an error.
  const root = config.getOptionalConfig('ownershipMatcher');
  const escalationCfg = root?.getOptionalConfig('escalation');
  if (!escalationCfg) {
    return undefined;
  }

  // Convert Backstage Config → plain object via .get and validate with Zod.
  const raw = escalationCfg.get() as unknown;
  const parsed = escalationConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => {
        const path = i.path.length > 0 ? `${i.path.join('.')}: ` : '';
        return `${path}${i.message}`;
      })
      .join('; ');
    throw new InputError(
      `Invalid ownershipMatcher.escalation config: ${issues}`,
    );
  }

  const validated = parsed.data;
  const levels: EscalationLevelConfig[] = validated.levels.map(l => ({
    groupFilter: l.groupFilter,
    timeoutDays: l.timeoutDays,
    titlePatterns: l.titlePatterns,
    relations: l.relations,
    managerChain: l.managerChain,
  }));

  return {
    levels,
    fallbackActors: validated.fallbackActors,
    gracePeriodDays: validated.gracePeriodDays ?? 14,
    warningDays: validated.warningDays ?? 4,
    reDecisionDays: validated.reDecisionDays ?? 3,
  };
}
