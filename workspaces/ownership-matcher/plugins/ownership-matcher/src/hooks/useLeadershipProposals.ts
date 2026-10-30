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

import { useApi } from '@backstage/core-plugin-api';
import { useQuery } from '@tanstack/react-query';
import { ownershipMatcherApiRef } from '../api';
import { queryKeys } from '../query/keys';

/** All-proposals table on the My Teams tab, across every team a leader
 * manages. Distinct from `useLeadershipEntities`, which lists the entities
 * behind those teams' escalations. */
export function useLeadershipProposals(params: { status?: string[] } = {}) {
  const api = useApi(ownershipMatcherApiRef);
  return useQuery({
    queryKey: queryKeys.leadershipProposals(params),
    queryFn: () => api.listAllLeadershipProposals(params),
    staleTime: 0,
  });
}
