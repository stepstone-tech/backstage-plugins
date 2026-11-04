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

import { CatalogApi } from '@backstage/catalog-client';
import { Entity } from '@backstage/catalog-model';
import { LoggerService } from '@backstage/backend-plugin-api';
import { EntityFilters, CatalogComponent, CatalogUserDetail } from '../types';
import { buildExcludeTypeSet, isTypeExcluded } from './typeFilter';
import {
  CatalogGroupMember,
  CatalogGroupSummary,
  CatalogServiceExtensions,
  GroupFilter,
  HierarchyDirection,
} from './CatalogServiceExtensions';
import {
  CatalogConventions,
  DEFAULT_CATALOG_CONVENTIONS,
} from '../config/catalogConventions';

const QUERY_LIMIT = 500;

/** Backstage `CatalogApi` wrapper used by the ownership matcher plugin. */
export class CatalogService implements CatalogServiceExtensions {
  private liveGroupRegistryCache: Set<string> | null = null;
  private liveUserRegistryCache: Set<string> | null = null;
  private teamGroupRegistryCache: Set<string> | null = null;
  // Per-instance cache for ancestor walks. The same team is often walked once
  // per proposal during BFS plan construction; without this cache, an entity
  // with N candidate proposals triggers N × depth catalog round-trips for
  // identical results. Reset between scans via `resetCache`.
  private readonly walkHierarchyCache = new Map<
    string,
    CatalogGroupSummary[]
  >();

  constructor(
    private readonly catalogClient: CatalogApi,
    private readonly logger: LoggerService,
    private readonly conventions: CatalogConventions = DEFAULT_CATALOG_CONVENTIONS,
  ) {}

  /** Returns the set of all currently live group refs in the catalog. */
  async getLiveGroupRegistry(): Promise<Set<string>> {
    if (this.liveGroupRegistryCache) {
      return this.liveGroupRegistryCache;
    }

    try {
      const response = await this.catalogClient.getEntities({
        filter: { kind: 'Group' },
        fields: ['metadata.name', 'metadata.namespace'],
      });

      const registry = new Set<string>();
      for (const entity of response.items) {
        const ns = entity.metadata.namespace ?? 'default';
        registry.add(`group:${ns}/${entity.metadata.name}`);
      }

      this.liveGroupRegistryCache = registry;
      return registry;
    } catch (error) {
      this.logger.error(
        `CatalogService.getLiveGroupRegistry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Set();
    }
  }

  /**
   * Returns the set of all currently live user refs in the catalog, lowercased
   * (entity refs are case-insensitive).
   *
   * Unlike `getLiveGroupRegistry`, catalog errors are rethrown: an empty set
   * would make every User-owned entity look like a zombie.
   */
  async getLiveUserRegistry(): Promise<Set<string>> {
    if (this.liveUserRegistryCache) {
      return this.liveUserRegistryCache;
    }

    const response = await this.catalogClient.getEntities({
      filter: { kind: 'User' },
      fields: ['metadata.name', 'metadata.namespace'],
    });

    const registry = new Set<string>();
    for (const entity of response.items) {
      const ns = entity.metadata.namespace ?? 'default';
      registry.add(`user:${ns}/${entity.metadata.name}`.toLowerCase());
    }

    this.liveUserRegistryCache = registry;
    return registry;
  }

  async getTeamGroupRegistry(): Promise<Set<string>> {
    if (this.teamGroupRegistryCache) {
      return this.teamGroupRegistryCache;
    }

    try {
      const response = await this.catalogClient.getEntities({
        filter: { kind: 'Group', 'spec.type': this.conventions.teamGroupTypes },
        fields: ['metadata.name', 'metadata.namespace'],
      });

      const registry = new Set<string>();
      for (const entity of response.items) {
        const ns = entity.metadata.namespace ?? 'default';
        registry.add(`group:${ns}/${entity.metadata.name}`);
      }

      this.teamGroupRegistryCache = registry;
      return registry;
    } catch (error) {
      this.logger.error(
        `CatalogService.getTeamGroupRegistry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Set();
    }
  }

  /** Async generator that paginates through all catalog entities using cursor-based pagination via queryEntities, applying config-based filters client-side. */
  async *paginateEntities(
    filters: EntityFilters,
  ): AsyncGenerator<CatalogComponent> {
    const excludeKindsLower = new Set(
      filters.excludeKinds.map(k => k.toLowerCase()),
    );
    const excludeNamespacesLower = new Set(
      filters.excludeNamespaces.map(n => n.toLowerCase()),
    );
    const excludeOwnerRefs = new Set(filters.excludeOwners);
    const excludeTypeSet = buildExcludeTypeSet(filters.excludeTypes);

    let cursor: string | undefined;

    while (true) {
      let items: Entity[];
      let nextCursor: string | undefined;

      try {
        const request = {
          fields: [
            'kind',
            'metadata.name',
            'metadata.namespace',
            'metadata.annotations',
            'spec.owner',
            'spec.memberOf',
            'spec.system',
            'spec.domain',
            'spec.lifecycle',
            'spec.type',
          ],
          limit: QUERY_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        };

        const response = await this.catalogClient.queryEntities(request as any);
        items = response.items;
        nextCursor = response.pageInfo?.nextCursor;
      } catch (error) {
        this.logger.error(
          `CatalogService.paginateEntities failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      if (items.length === 0) {
        return;
      }

      for (const entity of items) {
        const kind = entity.kind?.toLowerCase() ?? '';
        const ns = (entity.metadata.namespace ?? 'default').toLowerCase();

        if (excludeKindsLower.has(kind)) continue;
        if (excludeNamespacesLower.has(ns)) continue;
        const type = (entity as any).spec?.type as string | undefined;
        if (isTypeExcluded(entity.kind, type, excludeTypeSet)) continue;

        if (filters.requireAnnotations.length > 0) {
          const annotations = entity.metadata.annotations ?? {};
          const hasAll = filters.requireAnnotations.every(
            a => annotations[a] !== undefined,
          );
          if (!hasAll) continue;
        }

        const owner = (entity as any).spec?.owner as string | undefined;
        if (owner && excludeOwnerRefs.has(owner)) continue;

        const component: CatalogComponent = {
          kind: entity.kind,
          metadata: {
            name: entity.metadata.name,
            namespace: entity.metadata.namespace ?? 'default',
            annotations: entity.metadata.annotations as
              | Record<string, string>
              | undefined,
          },
          spec: {
            owner,
            memberOf: (entity as any).spec?.memberOf,
            system: (entity as any).spec?.system,
            domain: (entity as any).spec?.domain,
            lifecycle: (entity as any).spec?.lifecycle,
            type,
          },
        };

        yield component;
      }

      if (!nextCursor) {
        return;
      }

      cursor = nextCursor;
    }
  }

  /** Fetches all User entities (name, annotations, memberOf, profile email) to resolve email → team membership. */
  async getUserData(): Promise<CatalogComponent[]> {
    try {
      const response = await this.catalogClient.getEntities({
        filter: { kind: 'User' },
        fields: [
          'metadata.name',
          'metadata.annotations',
          'spec.memberOf',
          'spec.profile.email',
        ],
      });
      return response.items.map(e => {
        const email = (e as any).spec?.profile?.email;
        return {
          kind: e.kind,
          metadata: {
            name: e.metadata.name,
            annotations: e.metadata.annotations as
              | Record<string, string>
              | undefined,
          },
          spec: {
            memberOf: (e as any).spec?.memberOf,
            ...(typeof email === 'string' && email
              ? { profile: { email } }
              : {}),
          },
        };
      });
    } catch (error) {
      this.logger.error(
        `CatalogService.getUserData failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /**
   * Fetches all User entities with the fields needed for org-wide job-title
   * matching and CODEOWNERS owner-token resolution (alias, email). Used
   * to resolve the universal-approver set (e.g. Staff Architects / Principal
   * Engineers) without requiring group membership.
   */
  async getAllUserDetails(): Promise<CatalogUserDetail[]> {
    try {
      const response = await this.catalogClient.getEntities({
        filter: { kind: 'User' },
        fields: [
          'metadata.name',
          'metadata.namespace',
          'metadata.annotations',
          'metadata.userDetails',
          'spec.profile',
        ],
      });
      return response.items.map(e => {
        const ns = e.metadata.namespace ?? 'default';
        const userDetails = (e.metadata as any)?.userDetails as
          | { jobTitle?: string }
          | undefined;
        const profile = (e as any).spec?.profile as
          | { title?: string; email?: string }
          | undefined;
        const { userAliasAnnotation } = this.conventions;
        return {
          userRef: `user:${ns}/${e.metadata.name}`,
          jobTitle: userDetails?.jobTitle ?? profile?.title,
          alias: userAliasAnnotation
            ? (e.metadata.annotations ?? {})[userAliasAnnotation]
            : undefined,
          email: profile?.email,
        };
      });
    } catch (error) {
      this.logger.error(
        `CatalogService.getAllUserDetails failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** Fetches a single entity by ref. */
  async getEntityByRef(
    entityRef: string,
  ): Promise<CatalogComponent | undefined> {
    const entity = await this.catalogClient.getEntityByRef(entityRef);
    if (!entity) return undefined;

    return {
      kind: entity.kind,
      metadata: {
        name: entity.metadata.name,
        namespace: entity.metadata.namespace ?? 'default',
        annotations: entity.metadata.annotations as
          | Record<string, string>
          | undefined,
        userDetails: (entity.metadata as any).userDetails,
      },
      spec: {
        owner: (entity as any).spec?.owner,
        memberOf: (entity as any).spec?.memberOf,
        system: (entity as any).spec?.system,
        domain: (entity as any).spec?.domain,
        lifecycle: (entity as any).spec?.lifecycle,
        type: (entity as any).spec?.type,
        profile: (entity as any).spec?.profile,
      },
    };
  }

  async getManagerRef(userRef: string): Promise<string | undefined> {
    const { managerAnnotation, userAliasAnnotation } = this.conventions;
    // Manager lookup matches the manager annotation against other users'
    // alias annotation, so it needs both keys.
    if (!managerAnnotation || !userAliasAnnotation) return undefined;
    const entity = await this.catalogClient.getEntityByRef(userRef);
    if (!entity) return undefined;
    const managerAlias = (entity.metadata.annotations ?? {})[managerAnnotation];
    if (!managerAlias) return undefined;
    const { items } = await this.catalogClient.getEntities({
      filter: {
        kind: 'User',
        [`metadata.annotations.${userAliasAnnotation}`]: managerAlias,
      },
      fields: ['metadata.name', 'metadata.namespace'],
      limit: 1,
    });
    const mgr = items[0];
    if (!mgr) return undefined;
    return `user:${mgr.metadata.namespace ?? 'default'}/${mgr.metadata.name}`;
  }

  async getUserJobTitle(userRef: string): Promise<string | undefined> {
    const entity = await this.catalogClient.getEntityByRef(userRef);
    return (entity?.metadata as any)?.userDetails?.jobTitle;
  }

  /** Returns true if the given user is a (direct) member of the given group. */
  async isUserMemberOfGroup(
    userRef: string,
    groupRef: string,
  ): Promise<boolean> {
    try {
      const entity = await this.catalogClient.getEntityByRef(userRef);
      if (!entity) return false;
      const memberOf: string[] = (entity as any).spec?.memberOf ?? [];
      // Normalize both sides: strip kind prefix and lowercase for comparison
      const normalize = (ref: string) =>
        ref.replace(/^group:[^/]+\//, '').toLowerCase();
      const target = normalize(groupRef);
      return memberOf.some(g => normalize(g) === target);
    } catch (error) {
      this.logger.warn(
        `CatalogService.isUserMemberOfGroup(${userRef}, ${groupRef}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /** Returns the user refs that are members of the given group. */
  async getGroupMembers(groupRef: string): Promise<string[]> {
    try {
      const entity = await this.catalogClient.getEntityByRef(groupRef);
      if (!entity) {
        this.logger.warn(
          `CatalogService.getGroupMembers: group not found: ${groupRef}`,
        );
        return [];
      }

      const relations = (entity as any).relations as
        | { type: string; targetRef: string }[]
        | undefined;
      const fromRelations = (relations ?? [])
        .filter(r => r.type === 'hasMember')
        .map(r => r.targetRef);
      if (fromRelations.length > 0) return fromRelations;

      const specMembers = (entity as any).spec?.members as string[] | undefined;
      if (specMembers && specMembers.length > 0) {
        return specMembers.map(m =>
          m.includes(':') ? m : `user:default/${m}`,
        );
      }

      return [];
    } catch (error) {
      this.logger.warn(
        `CatalogService.getGroupMembers(${groupRef}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** Reset caches between scans. */
  resetCache(): void {
    this.liveGroupRegistryCache = null;
    this.liveUserRegistryCache = null;
    this.teamGroupRegistryCache = null;
    this.walkHierarchyCache.clear();
  }

  // ── CatalogServiceExtensions ──────────────────────────────────────────────

  /** {@inheritdoc CatalogServiceExtensions.getGroupMembersWithTitles} */
  async getGroupMembersWithTitles(
    groupRef: string,
  ): Promise<CatalogGroupMember[]> {
    try {
      const memberRefs = await this.getGroupMembers(groupRef);
      if (memberRefs.length === 0) return [];

      const { items } = await this.catalogClient.getEntitiesByRefs({
        entityRefs: memberRefs,
        fields: [
          'kind',
          'metadata.name',
          'metadata.namespace',
          'metadata.userDetails',
          'spec.profile',
        ],
      });

      const result: CatalogGroupMember[] = [];
      for (let i = 0; i < items.length; i++) {
        const entity = items[i];
        if (!entity) continue;
        const userRef = memberRefs[i];
        const userDetails = (entity.metadata as any)?.userDetails as
          | { jobTitle?: string }
          | undefined;
        const profile = (entity as any).spec?.profile as
          | { title?: string }
          | undefined;
        result.push({
          userRef,
          jobTitle: userDetails?.jobTitle ?? profile?.title,
        });
      }
      return result;
    } catch (error) {
      this.logger.warn(
        `CatalogService.getGroupMembersWithTitles(${groupRef}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** {@inheritdoc CatalogServiceExtensions.walkGroupHierarchy} */
  async walkGroupHierarchy(
    startRef: string,
    direction: HierarchyDirection,
  ): Promise<CatalogGroupSummary[]> {
    const cached = this.walkHierarchyCache.get(`${startRef}|${direction}`);
    if (cached) return cached;

    const relationType = direction === 'up' ? 'childOf' : 'parentOf';
    const visited = new Set<string>([startRef]);
    const result: CatalogGroupSummary[] = [];
    let frontier = [startRef];
    let isStartLevel = true;

    try {
      while (frontier.length > 0) {
        const { items } = await this.catalogClient.getEntitiesByRefs({
          entityRefs: frontier,
          fields: [
            'kind',
            'metadata.name',
            'metadata.namespace',
            'spec.type',
            'relations',
          ],
        });

        const next: string[] = [];
        for (const entity of items) {
          if (!entity) continue;

          // Emit summary for non-start groups; the start node is excluded
          // from the result per the FR contract.
          if (!isStartLevel && entity.kind === 'Group') {
            const ns = entity.metadata.namespace ?? 'default';
            result.push({
              ref: `group:${ns}/${entity.metadata.name}`,
              kind: entity.kind,
              specType: (entity as any).spec?.type as string | undefined,
            });
          }

          const relations = ((entity as any).relations ?? []) as {
            type: string;
            targetRef: string;
          }[];
          for (const r of relations) {
            if (r.type !== relationType) continue;
            if (!r.targetRef) continue;
            if (visited.has(r.targetRef)) continue;
            visited.add(r.targetRef);
            next.push(r.targetRef);
          }
        }
        isStartLevel = false;
        frontier = next;
      }
      this.walkHierarchyCache.set(`${startRef}|${direction}`, result);
      return result;
    } catch (error) {
      this.logger.warn(
        `CatalogService.walkGroupHierarchy(${startRef}, ${direction}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  /** {@inheritdoc CatalogServiceExtensions.getGroupsByFilter} */
  async getGroupsByFilter(
    groupFilter: GroupFilter,
  ): Promise<CatalogGroupSummary[]> {
    try {
      const filter: Record<string, string> = { kind: groupFilter.kind };
      if (groupFilter.specType !== undefined) {
        filter['spec.type'] = groupFilter.specType;
      }

      // Pagination via cursor — getEntities silently caps at QUERY_LIMIT,
      // which would drop tail teams in deployments where the matched-group
      // count exceeds 500. queryEntities has cursor pagination so we walk
      // the full set.
      const out: CatalogGroupSummary[] = [];
      let cursor: string | undefined;
      do {
        const page: any = await this.catalogClient.queryEntities({
          filter,
          fields: ['kind', 'metadata.name', 'metadata.namespace', 'spec.type'],
          limit: QUERY_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        for (const entity of page.items as Entity[]) {
          const ns = entity.metadata.namespace ?? 'default';
          out.push({
            ref: `group:${ns}/${entity.metadata.name}`,
            kind: entity.kind,
            specType: (entity as any).spec?.type as string | undefined,
          });
        }
        cursor = page.pageInfo?.nextCursor;
      } while (cursor);
      return out;
    } catch (error) {
      this.logger.warn(
        `CatalogService.getGroupsByFilter(${groupFilter.kind}${
          groupFilter.specType ? `:${groupFilter.specType}` : ''
        }) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }
}
