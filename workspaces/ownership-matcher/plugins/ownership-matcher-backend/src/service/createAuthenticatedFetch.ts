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

import { AuthService } from '@backstage/backend-plugin-api';

/**
 * Returns a `fetchApi` that adds a service token for `targetPluginId` to every
 * request that doesn't already carry an Authorization header. Pass it to
 * `CatalogClient` so plugin-to-plugin calls work under Backstage's default
 * auth policy, without threading a token through every call site.
 */
export function createAuthenticatedFetch(
  auth: AuthService,
  targetPluginId: string,
): { fetch: typeof fetch } {
  return {
    fetch: async (input, init) => {
      // Same precedence as fetch itself: headers on a Request input, then init.
      const headers = new Headers(
        input instanceof Request ? input.headers : undefined,
      );
      new Headers(init?.headers).forEach((value, key) =>
        headers.set(key, value),
      );
      if (!headers.has('authorization')) {
        const { token } = await auth.getPluginRequestToken({
          onBehalfOf: await auth.getOwnServiceCredentials(),
          targetPluginId,
        });
        headers.set('authorization', `Bearer ${token}`);
      }
      return fetch(input, { ...init, headers });
    },
  };
}
