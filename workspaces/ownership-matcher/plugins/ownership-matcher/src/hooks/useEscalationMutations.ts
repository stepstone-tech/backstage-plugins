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
import { ownershipMatcherApiRef } from '../api';
import { queryKeys } from '../query/keys';

export function useEscalationMutations() {
  const api = useApi(ownershipMatcherApiRef);
  const queryClient = useQueryClient();

  const invalidateAfterEscalation = (_: unknown, entityId: string) => {
    queryClient.invalidateQueries({
      queryKey: queryKeys.entityDetail(entityId),
    });
    queryClient.invalidateQueries({
      queryKey: queryKeys.leadershipEntitiesFamily(),
    });
  };

  const assign = useMutation({
    mutationFn: ({
      entityId,
      ownerRef,
    }: {
      entityId: string;
      ownerRef: string;
    }) => api.escalationAssign(entityId, ownerRef),
    onSuccess: (data, { entityId }) =>
      invalidateAfterEscalation(data, entityId),
  });

  const archive = useMutation({
    mutationFn: ({
      entityId,
      assigneeRef,
    }: {
      entityId: string;
      assigneeRef: string;
    }) => api.escalationArchive(entityId, assigneeRef),
    onSuccess: (data, { entityId }) =>
      invalidateAfterEscalation(data, entityId),
  });

  const triggerScan = useMutation({
    // The backend enqueues the scan rather than running it inline, so an
    // immediate refetch would race the new row's insert. The wait sits in the
    // mutation rather than in a delayed invalidation so the trigger button
    // stays disabled for its whole duration.
    mutationFn: async () => {
      const result = await api.triggerScan();
      await new Promise(resolve => setTimeout(resolve, 2000));
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.scansFamily() });
      queryClient.invalidateQueries({ queryKey: queryKeys.entitiesFamily() });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboardStats() });
    },
  });

  return { assign, archive, triggerScan };
}
