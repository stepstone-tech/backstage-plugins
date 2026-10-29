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
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ownershipMatcherApiRef, ProposalActionResponse } from '../api';
import { queryKeys } from '../query/keys';

/**
 * Accept/reject a proposal, invalidating every list the decision moves it
 * between: the team's pending and history lists, the possible-owner
 * candidates cancelled alongside it, and the leader stats counting it.
 *
 * The entity's own detail query goes too — `EntityDetailPage`'s Proposals
 * card acts through this hook, and without it that page would keep showing
 * the proposal's pre-decision status.
 */
export function useProposalMutations() {
  const api = useApi(ownershipMatcherApiRef);
  const queryClient = useQueryClient();

  const invalidateAfter = (response: ProposalActionResponse) => {
    // Every list a decision can move the proposal between or change a count
    // in. The admin and leadership lists are included because a decision is
    // visible there too; relying on `staleTime: 0` to paper over a missing
    // family only works while every one of those queries stays unmounted.
    for (const queryKey of [
      queryKeys.teamProposalsFamily(),
      queryKeys.allProposalsFamily(),
      queryKeys.leadershipProposalsFamily(),
      queryKeys.leadershipEntitiesFamily(),
      queryKeys.entitiesFamily(),
      queryKeys.unresolvedEntities(),
      queryKeys.leadershipStats(),
      queryKeys.dashboardStats(),
    ]) {
      queryClient.invalidateQueries({ queryKey });
    }
    if (response?.entity?.id) {
      queryClient.invalidateQueries({
        queryKey: queryKeys.entityDetail(response.entity.id),
      });
    }
  };

  const accept = useMutation({
    mutationFn: (proposalId: string) => api.acceptProposal(proposalId),
    onSuccess: invalidateAfter,
  });

  const reject = useMutation({
    mutationFn: ({
      proposalId,
      reason,
    }: {
      proposalId: string;
      reason: string;
    }) => api.rejectProposal(proposalId, reason),
    onSuccess: invalidateAfter,
  });

  return { accept, reject };
}
