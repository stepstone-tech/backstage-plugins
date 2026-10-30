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
import { reasonLabel, latestUnresolvedReason } from '../utils/history';
import { queryKeys } from '../query/keys';

export interface UnresolvedRow extends OwnershipEntity {
  reason_action?: string;
  reason_label?: string;
  reason_at?: string;
}

/**
 * Unresolved-cases table on the admin Unresolved tab.
 *
 * Fetches a filtered subset through the unbounded `listAllEntities` call and
 * enriches each row with one `getEntity` request. The kind/reason filter
 * chips count across the whole result set and derive `reason` from per-entity
 * history, so this view cannot be paginated without backend facet
 * aggregation.
 */
export function useUnresolvedEntities() {
  const api = useApi(ownershipMatcherApiRef);
  return useQuery({
    queryKey: queryKeys.unresolvedEntities(),
    queryFn: async (): Promise<UnresolvedRow[]> => {
      const items = await api.listAllEntities({ status: 'unresolved' });

      return Promise.all(
        items.map(async entity => {
          try {
            const detail = await api.getEntity(entity.id);
            const reason = latestUnresolvedReason(detail.history);
            return {
              ...entity,
              reason_action: reason?.action,
              reason_label: reason ? reasonLabel(reason.action) : undefined,
              reason_at: reason?.created_at,
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
