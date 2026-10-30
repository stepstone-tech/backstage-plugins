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

/** Backs the Pending, Possible-Owners and History sections, scoped by
 * proposal status. Zero staleTime: a decision on one list moves the proposal
 * onto another, so every mount re-reads rather than showing a cached list the
 * user has already acted on.
 *
 * Pass `enabled: false` while the caller's team refs are still loading —
 * `listProposalsForTeam` with an empty ref list queries every team rather
 * than none. */
export function useTeamProposals(
  teamRefs: string[],
  statuses: string[],
  options: { enabled?: boolean } = {},
) {
  const api = useApi(ownershipMatcherApiRef);
  return useQuery({
    queryKey: queryKeys.teamProposals(teamRefs, statuses),
    queryFn: () => api.listProposalsForTeam(teamRefs, statuses),
    staleTime: 0,
    enabled: options.enabled ?? true,
  });
}
