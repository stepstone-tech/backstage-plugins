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

/** Catalog-side helper surface required by the escalation feature. */

/** A catalog Group with the metadata the escalation feature needs to evaluate member titles and walk the hierarchy. */
export interface CatalogGroupSummary {
  /** Entity ref of the form `group:<namespace>/<name>`. */
  ref: string;
  kind: string;
  /** `spec.type` — `team` / `domain` / `portfolio` / etc. */
  specType: string | undefined;
}

/** A direct member of a Group with the title used for `titlePatterns` matching. */
export interface CatalogGroupMember {
  /** User entity ref (`user:<namespace>/<name>`). */
  userRef: string;
  /** `metadata.userDetails.jobTitle`. */
  jobTitle: string | undefined;
}

/** Direction for `walkGroupHierarchy` — `up` walks via `childOf` to parents, `down` walks via `parentOf` to children. */
export type HierarchyDirection = 'up' | 'down';

/** Parsed shorthand from `EscalationLevelConfig.groupFilter`. */
export interface GroupFilter {
  kind: string;
  /** `spec.type` filter; `undefined` means "match all entities of this kind". */
  specType: string | undefined;
}

/** Catalog-side helpers consumed by the escalation feature. */
export interface CatalogServiceExtensions {
  /** Returns the set of all currently live group refs in the catalog. */
  getLiveGroupRegistry(): Promise<Set<string>>;

  /**
   * Returns the direct members (User entities) of a group along with their job titles.
   *
   * @param groupRef - `group:<namespace>/<name>`
   */
  getGroupMembersWithTitles(groupRef: string): Promise<CatalogGroupMember[]>;

  /**
   * Walks the group hierarchy starting at `startRef` in the requested direction and returns the visited groups (excluding the starting group).
   *
   * @param startRef - Group ref to start from.
   * @param direction - `up` (childOf) or `down` (parentOf).
   */
  walkGroupHierarchy(
    startRef: string,
    direction: HierarchyDirection,
  ): Promise<CatalogGroupSummary[]>;

  /** Returns groups that match the level's `groupFilter` shorthand. */
  getGroupsByFilter(groupFilter: GroupFilter): Promise<CatalogGroupSummary[]>;

  /**
   * Returns the Backstage user ref of the given user's manager,
   * read from the configured manager annotation
   * (`ownershipMatcher.catalog.annotations.manager`). Returns undefined if the
   * annotations aren't configured, the user has no manager annotation, or the
   * manager entity is not in the catalog.
   */
  getManagerRef(userRef: string): Promise<string | undefined>;

  /**
   * Returns the job title of the given user from `metadata.userDetails.jobTitle`.
   * Returns undefined if the entity is not found or has no job title.
   */
  getUserJobTitle(userRef: string): Promise<string | undefined>;
}
