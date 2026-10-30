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
import { ownershipMatcherApiRef, DefinitionsResponse } from '../api';
import { queryKeys } from '../query/keys';

const EMPTY_DEFINITIONS: DefinitionsResponse = { signals: [], checks: [] };

/** Signal/check titles and descriptions, read by every view that renders a
 * proposal's reason. Static reference data, so it keeps the client's long
 * default staleTime and is fetched once per session rather than per view. */
export function useDefinitions() {
  const api = useApi(ownershipMatcherApiRef);
  const query = useQuery({
    queryKey: queryKeys.definitions(),
    queryFn: () => api.getDefinitions(),
  });
  return { ...query, definitions: query.data ?? EMPTY_DEFINITIONS };
}
