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

import { configApiRef, useApi } from '@backstage/core-plugin-api';

const DEFAULT_TEAM_GROUP_TYPES = ['team'];

/**
 * `spec.type` values of Group entities that can own entities, from
 * `ownershipMatcher.catalog.teamGroupTypes` (default `['team']`). Mirrors the
 * backend `CatalogService.getTeamGroupRegistry`.
 */
export function useTeamGroupTypes(): string[] {
  const configApi = useApi(configApiRef);
  return (
    configApi.getOptionalStringArray(
      'ownershipMatcher.catalog.teamGroupTypes',
    ) ?? DEFAULT_TEAM_GROUP_TYPES
  );
}
