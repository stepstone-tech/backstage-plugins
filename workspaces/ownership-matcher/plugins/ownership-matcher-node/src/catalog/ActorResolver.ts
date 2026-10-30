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
import { EscalationConfig, EscalationLevelConfig } from '../config/types';
import { compileConfigRegex, testConfigRegex } from '../utils/regex';
import {
  CatalogGroupSummary,
  CatalogServiceExtensions,
  GroupFilter,
} from './CatalogServiceExtensions';

/** Parse the level's `groupFilter` shorthand (`Kind:type` or `Kind`). */
export function parseGroupFilter(raw: string | undefined): GroupFilter | null {
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length === 1) {
    if (!parts[0]) return null;
    return { kind: parts[0], specType: undefined };
  }
  if (parts.length === 2) {
    if (!parts[0] || !parts[1]) return null;
    return { kind: parts[0], specType: parts[1] };
  }
  return null;
}

/** Case-insensitive kind match plus optional specType match. */
export function matchesGroupFilter(
  group: CatalogGroupSummary,
  filter: GroupFilter,
): boolean {
  if (group.kind.toLowerCase() !== filter.kind.toLowerCase()) return false;
  if (filter.specType !== undefined && group.specType !== filter.specType) {
    return false;
  }
  return true;
}

/**
 * Resolves the escalation actor(s) for a group at a given escalation level by
 * matching each level's `titlePatterns` against group members / manager chains.
 *
 * This is the pure, stateless engine behind the escalation lifecycle in
 * `ownership-matcher-backend`. It depends only on {@link EscalationConfig} and
 * the {@link CatalogServiceExtensions} contract — no DB, clock, scanner, or
 * events — so backend modules can reuse it on their own.
 */
export interface ActorResolver {
  /** Resolve the actor user-ref for a group at the given escalation level. */
  resolveActorForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string | undefined>;

  /**
   * Like {@link ActorResolver.resolveActorForGroup} but returns ALL
   * title-matching members (deduped by userRef), not just the first. Shares the
   * compiled `titlePatterns` + manager-chain engine.
   */
  resolveAllActorsForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string[]>;
}

/** Concrete {@link ActorResolver} extracted from `DefaultEscalationService`. */
export class DefaultActorResolver implements ActorResolver {
  /** Pre-compiled `titlePatterns` per level index; populated once in the constructor. */
  private readonly compiledTitlePatterns: ReadonlyArray<readonly RegExp[]>;

  constructor(
    private readonly catalog: CatalogServiceExtensions,
    private readonly config: EscalationConfig,
    private readonly logger: LoggerService,
  ) {
    this.compiledTitlePatterns = (this.config.levels ?? []).map(level =>
      (level.titlePatterns ?? []).map(p => compileConfigRegex(p)),
    );
    this.logger.debug(
      `DefaultActorResolver initialised for ${this.compiledTitlePatterns.length} escalation level(s)`,
    );
  }

  /** {@inheritdoc ActorResolver.resolveActorForGroup} */
  async resolveActorForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string | undefined> {
    const matches = await this.matchActorsForGroup(groupRef, level, teamRefs, {
      stopAtFirst: true,
    });
    return matches[0];
  }

  /** {@inheritdoc ActorResolver.resolveAllActorsForGroup} */
  async resolveAllActorsForGroup(
    groupRef: string,
    level: number,
    teamRefs?: string[],
  ): Promise<string[]> {
    return this.matchActorsForGroup(groupRef, level, teamRefs, {
      stopAtFirst: false,
    });
  }

  /**
   * Shared actor-resolution engine behind {@link resolveActorForGroup} and
   * {@link resolveAllActorsForGroup}. Matches `titlePatterns` against either the
   * manager chains of `teamRefs`' members (when `managerChain` is set) or the
   * direct members of `groupRef`.
   *
   * @param stopAtFirst - When true, returns as soon as one actor matches
   *   (single-actor semantics). When false, collects every distinct matching
   *   actor. In both modes a given person's manager chain contributes at most
   *   its NEAREST matching manager — climbing stops once that person matches.
   * @returns Matching user refs, deduped, in discovery order.
   */
  private async matchActorsForGroup(
    groupRef: string,
    level: number,
    teamRefs: string[] | undefined,
    { stopAtFirst }: { stopAtFirst: boolean },
  ): Promise<string[]> {
    // 1-indexed level → array index
    const levelConfig: EscalationLevelConfig | undefined =
      this.config.levels?.[level - 1];
    if (!levelConfig) return [];

    const compiled = this.compiledTitlePatterns[level - 1] ?? [];
    if (compiled.length === 0) {
      return [];
    }

    const titleMatches = (title: string | undefined): boolean =>
      !!title && compiled.some(re => testConfigRegex(re, title));

    // Set preserves insertion order and dedupes by userRef.
    const matches = new Set<string>();

    if (levelConfig.managerChain && teamRefs && teamRefs.length > 0) {
      for (const teamRef of teamRefs) {
        const members = await this.catalog.getGroupMembersWithTitles(teamRef);
        for (const member of members) {
          let currentRef: string | undefined = member.userRef;
          const visited = new Set<string>();
          while (currentRef && !visited.has(currentRef)) {
            visited.add(currentRef);
            const managerRef = await this.catalog.getManagerRef(currentRef);
            if (!managerRef) break;
            const managerTitle = await this.catalog.getUserJobTitle(managerRef);
            if (titleMatches(managerTitle)) {
              matches.add(managerRef);
              // Nearest matching manager only — stop climbing this person's
              // chain (further ancestors, e.g. a VP above a Director, belong
              // to a higher escalation level, not this one).
              break;
            }
            currentRef = managerRef;
          }
          if (stopAtFirst && matches.size > 0) return [...matches];
        }
      }
      return [...matches];
    }

    const members = await this.catalog.getGroupMembersWithTitles(groupRef);
    for (const member of members) {
      if (titleMatches(member.jobTitle)) {
        matches.add(member.userRef);
        if (stopAtFirst) return [...matches];
      }
    }
    return [...matches];
  }
}
