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

/** Single entity detail (entity + proposals + history). Zero staleTime, since
 * the page is where owners act on a case and must never show a decision that
 * has already been taken.
 *
 * Note this entry is *not* shared with the per-row enrichment in
 * `useEntities`/`useUnresolvedEntities`: those call `api.getEntity` inside
 * their own `queryFn` under their own key, so invalidating `entityDetail`
 * does not refresh those table rows. Sharing it would mean routing the
 * enrichment through `queryClient.fetchQuery`. */
export function useEntityDetail(entityId: string | undefined) {
  const api = useApi(ownershipMatcherApiRef);
  return useQuery({
    queryKey: queryKeys.entityDetail(entityId ?? ''),
    queryFn: () => api.getEntity(entityId!),
    enabled: Boolean(entityId),
    staleTime: 0,
  });
}
