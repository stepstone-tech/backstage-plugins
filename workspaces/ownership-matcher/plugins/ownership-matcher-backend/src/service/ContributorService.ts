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
import { ServiceUnavailableError } from '@backstage/errors';
import { ContributorInfo, ContributorCache } from '../types';
import {
  CatalogComponent,
  CatalogService,
  compileConfigRegex,
  testConfigRegex,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ContributorsConfig } from '../config/types';

export class ContributorService {
  private cache: ContributorCache = {};
  private userDataCache: CatalogComponent[] | null = null;
  private readonly excludeEmailsLower: Set<string>;
  private readonly excludeUsernamesLower: Set<string>;
  private readonly excludePatternRegexes: RegExp[];

  constructor(
    private readonly catalogService: CatalogService,
    private readonly logger: LoggerService,
    config: ContributorsConfig,
    /** User annotation holding an alias (`ownershipMatcher.catalog.annotations.userAlias`). */
    private readonly userAliasAnnotation?: string,
  ) {
    this.excludeEmailsLower = new Set(
      config.excludeEmails.map(e => e.toLowerCase()),
    );
    this.excludeUsernamesLower = new Set(
      config.excludeUsernames.map(u => u.toLowerCase()),
    );
    this.excludePatternRegexes = config.excludePatterns.map(p =>
      compileConfigRegex(p, 'i'),
    );
  }

  /** Returns whether this email address belongs to a bot/automated system and should be excluded from contributor analysis. */
  isBot(email: string): boolean {
    const lower = email.toLowerCase();

    if (this.excludeEmailsLower.has(lower)) return true;

    const username = lower.split('@')[0];
    if (this.excludeUsernamesLower.has(username)) return true;

    return this.excludePatternRegexes.some(re => testConfigRegex(re, email));
  }

  /** Resolves an email address to the teams the contributor belongs to. */
  async getContributorInfo(email: string): Promise<ContributorInfo | null> {
    if (this.isBot(email)) {
      return null;
    }

    if (this.cache[email]) {
      return this.cache[email];
    }

    const userData = await this.loadUserData();

    // First, match the full commit email against the user's
    // `spec.profile.email` (case-insensitive) — exact and provider-independent
    // for anyone who commits with their work address. Failing that, match on
    // the portion before any '_' suffix in both the email prefix and the
    // catalog user name — accommodates common LDAP conventions. Failing that,
    // match the whole local part against the user's configured alias
    // annotation (case-insensitive: directories store some as e.g. `DoeJ01`),
    // since many people commit under their alias rather than their name.
    const emailLower = email.toLowerCase();
    const localPart = emailLower.split('@')[0];
    const emailPrefix = localPart.split('_')[0];

    // Require `memberOf` inside each lookup so a match without memberOf
    // doesn't hide a later one.
    const hasMembership = (user: CatalogComponent) =>
      Boolean(user.spec?.memberOf);
    const aliasAnnotation = this.userAliasAnnotation;
    const matchingUser =
      userData.find(
        user =>
          hasMembership(user) &&
          typeof user.spec?.profile?.email === 'string' &&
          user.spec.profile.email.toLowerCase() === emailLower,
      ) ??
      userData.find(
        user =>
          hasMembership(user) &&
          user.metadata.name.split('_')[0].toLowerCase() === emailPrefix,
      ) ??
      (aliasAnnotation
        ? userData.find(
            user =>
              hasMembership(user) &&
              user.metadata.annotations?.[aliasAnnotation]?.toLowerCase() ===
                localPart,
          )
        : undefined);

    if (!matchingUser?.spec?.memberOf) {
      return null;
    }

    const teams = matchingUser.spec.memberOf
      .filter(m => m.startsWith('group:default/'))
      .map(m => m.replace('group:default/', ''));

    const info: ContributorInfo = { email, teams };
    this.cache[email] = info;
    return info;
  }

  /**
   * `CatalogService.getUserData` returns `[]` on a catalog error. An empty
   * user list is never legitimate, so throw instead of caching it — otherwise
   * every contributor lookup reads as "unknown user" until the next reset and
   * TopContributorStrategy silently reports zero candidates.
   */
  private async loadUserData(): Promise<CatalogComponent[]> {
    if (this.userDataCache) return this.userDataCache;

    const userData = await this.catalogService.getUserData();
    if (userData.length === 0) {
      this.logger.warn(
        'ContributorService: catalog returned no User entities; not caching',
      );
      throw new ServiceUnavailableError(
        'Catalog user data unavailable (no User entities returned)',
      );
    }
    this.userDataCache = userData;
    return userData;
  }

  resetCache(): void {
    this.cache = {};
    this.userDataCache = null;
  }
}
