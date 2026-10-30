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

import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { EscalationConfig } from './types';

/**
 * Organisation-specific catalog conventions, read from
 * `ownershipMatcher.catalog`. Every field has a neutral default so the plugin
 * runs against a stock Backstage catalog.
 */
export interface CatalogConventions {
  /**
   * User annotation holding an alternative login/alias (e.g. a directory
   * account name). Commit-email local parts are matched against it, and it is
   * the CODEOWNERS owner token. Unset → alias matching is disabled.
   */
  userAliasAnnotation?: string;
  /**
   * User annotation holding the manager's alias, i.e. the value of the
   * manager's `userAliasAnnotation`. Unset → manager-chain escalation is
   * disabled.
   */
  managerAnnotation?: string;
  /** `spec.type` values of Group entities treated as teams. */
  teamGroupTypes: string[];
}

export const DEFAULT_CATALOG_CONVENTIONS: CatalogConventions = {
  teamGroupTypes: ['team'],
};

/** Reads `ownershipMatcher.catalog`, applying defaults. */
export function readCatalogConventions(config: Config): CatalogConventions {
  const catalogCfg = config.getOptionalConfig('ownershipMatcher.catalog');
  const annotationsCfg = catalogCfg?.getOptionalConfig('annotations');
  const teamGroupTypes = catalogCfg?.getOptionalStringArray('teamGroupTypes');
  if (teamGroupTypes && teamGroupTypes.length === 0) {
    throw new InputError(
      'ownershipMatcher.catalog.teamGroupTypes must contain at least one group type',
    );
  }
  return {
    userAliasAnnotation: annotationsCfg?.getOptionalString('userAlias'),
    managerAnnotation: annotationsCfg?.getOptionalString('manager'),
    teamGroupTypes:
      teamGroupTypes ?? DEFAULT_CATALOG_CONVENTIONS.teamGroupTypes,
  };
}

/**
 * Manager lookup matches a user's manager annotation against other users'
 * alias annotation, so it needs both keys.
 */
export function isManagerChainAvailable(
  conventions: CatalogConventions,
): boolean {
  return Boolean(
    conventions.managerAnnotation && conventions.userAliasAnnotation,
  );
}

/**
 * Logs a startup warning when escalation levels rely on `managerChain` but the
 * annotations needed to walk the manager chain aren't configured.
 */
export function warnIfManagerChainUnavailable(
  escalation: EscalationConfig | undefined,
  conventions: CatalogConventions,
  logger: LoggerService,
): void {
  if (isManagerChainAvailable(conventions)) return;
  if (!escalation?.levels.some(l => l.managerChain)) return;
  logger.warn(
    'Manager-chain escalation is disabled: set ownershipMatcher.catalog.annotations.userAlias ' +
      'and ownershipMatcher.catalog.annotations.manager to enable it. Escalation levels with ' +
      '`managerChain: true` will resolve no actors.',
  );
}
