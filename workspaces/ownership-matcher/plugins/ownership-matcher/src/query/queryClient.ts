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

import { QueryClient } from '@tanstack/react-query';

let client: QueryClient | undefined;

/** Tuned for reference data (definitions, leadership stats), which the views
 * re-read constantly but which almost never changes. Hooks over volatile data
 * (entities, proposals, scans) override this with a zero staleTime. */
const DEFAULT_STALE_TIME = 5 * 60 * 1000;

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: DEFAULT_STALE_TIME,
      },
    },
  });
}

/**
 * Module-level singleton rather than a client created per provider mount.
 * The plugin's pages mount independently, with no component of ours above
 * them to host a shared provider, so a per-mount client would hand each page
 * its own cache and lose every cross-page invalidation.
 */
export function getQueryClient(): QueryClient {
  if (!client) {
    client = createClient();
  }
  return client;
}

/** Called from setupTests.ts so the singleton cache cannot leak between test files. */
export function resetQueryClient(): void {
  client?.clear();
  client = undefined;
}
