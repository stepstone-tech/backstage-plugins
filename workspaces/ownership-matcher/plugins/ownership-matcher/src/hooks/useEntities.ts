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
import { ownershipMatcherApiRef, OwnershipEntity } from '../api';
import { formatConfidenceReason } from '../utils/definitions';
import { queryKeys } from '../query/keys';

export interface EntityRow extends OwnershipEntity {
  suggested_owner?: string;
  suggested_score?: string;
  active_responder?: string;
  proposal_status?: string;
}

/**
 * Tracked-entities table on the admin Entities tab, each row enriched with
 * its top candidate and active responder.
 *
 * Lists every tracked entity and then issues one `getEntity` request per row
 * for the enrichment. `listEntities` already accepts `page`/`limit`, so this
 * is the place to move to server-side pagination.
 */
export function useEntities() {
  const api = useApi(ownershipMatcherApiRef);
  return useQuery({
    queryKey: queryKeys.entities({}),
    queryFn: async (): Promise<EntityRow[]> => {
      const items = await api.listAllEntities();

      return Promise.all(
        items.map(async entity => {
          try {
            const detail = await api.getEntity(entity.id);
            const proposals = detail.proposals || [];

            const topCandidate = proposals.sort(
              (a, b) => a.proposal_order - b.proposal_order,
            )[0];
            const activeProposal = proposals.find(p => p.status === 'pending');

            return {
              ...entity,
              suggested_owner: topCandidate?.proposed_owner_ref,
              suggested_score:
                topCandidate?.confidence_score !== null &&
                topCandidate?.confidence_score !== undefined
                  ? `${(topCandidate.confidence_score * 100).toFixed(
                      0,
                    )}% · ${formatConfidenceReason(
                      topCandidate.confidence_reason,
                    )}`
                  : undefined,
              active_responder: activeProposal?.proposed_owner_ref,
              proposal_status: activeProposal?.status,
            };
          } catch {
            return { ...entity };
          }
        }),
      );
    },
    staleTime: 0,
  });
}
