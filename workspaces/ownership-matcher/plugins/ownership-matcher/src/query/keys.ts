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

const PLUGIN_ID = 'ownership-matcher';

/**
 * Query-key factory. Every entry starts with the plugin id so
 * `invalidateQueries` can target a whole family by prefix (e.g. every
 * `team-proposals` key regardless of team/status) without stringly-typed
 * keys scattered across call sites.
 */
export const queryKeys = {
  definitions: () => [PLUGIN_ID, 'definitions'] as const,
  leadershipStats: () => [PLUGIN_ID, 'leadership-stats'] as const,
  teamProposals: (teamRefs: string[], statuses?: string[]) =>
    [PLUGIN_ID, 'team-proposals', teamRefs, statuses] as const,
  entities: (params: {
    status?: string;
    kind?: string;
    page?: number;
    limit?: number;
  }) => [PLUGIN_ID, 'entities', params] as const,
  entityDetail: (id: string) => [PLUGIN_ID, 'entity-detail', id] as const,
  scans: (limit?: number) => [PLUGIN_ID, 'scans', limit] as const,
  allProposals: (params: { status?: string[]; search?: string }) =>
    [PLUGIN_ID, 'all-proposals', params] as const,
  leadershipEntities: (params: { status?: string[] }) =>
    [PLUGIN_ID, 'leadership-entities', params] as const,
  leadershipProposals: (params: { status?: string[] }) =>
    [PLUGIN_ID, 'leadership-proposals', params] as const,
  dashboardStats: () => [PLUGIN_ID, 'dashboard-stats'] as const,
  unresolvedEntities: () => [PLUGIN_ID, 'unresolved-entities'] as const,

  // Identity and catalog lookups. Not wrapped in named hooks — each has a
  // single call site — but they belong here so no caller hand-writes the
  // plugin prefix.
  identity: () => [PLUGIN_ID, 'identity'] as const,
  identityGroups: () => [PLUGIN_ID, 'identity-groups'] as const,
  userTeamGroups: (groupRefs: string[], teamGroupTypes: string[]) =>
    [PLUGIN_ID, 'user-team-groups', groupRefs, teamGroupTypes] as const,
  escalationTeamOptions: (teamGroupTypes: string[]) =>
    [PLUGIN_ID, 'escalation-team-options', teamGroupTypes] as const,

  // Family-root prefixes, for `invalidateQueries({ queryKey })` — react-query
  // matches every key with this prefix regardless of the trailing params, so
  // mutations invalidate every team/status or filter variant in one call.
  teamProposalsFamily: () => [PLUGIN_ID, 'team-proposals'] as const,
  leadershipProposalsFamily: () => [PLUGIN_ID, 'leadership-proposals'] as const,
  allProposalsFamily: () => [PLUGIN_ID, 'all-proposals'] as const,
  entitiesFamily: () => [PLUGIN_ID, 'entities'] as const,
  leadershipEntitiesFamily: () => [PLUGIN_ID, 'leadership-entities'] as const,
  scansFamily: () => [PLUGIN_ID, 'scans'] as const,
};
