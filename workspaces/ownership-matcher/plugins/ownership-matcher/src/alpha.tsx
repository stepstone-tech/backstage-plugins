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

import {
  ApiBlueprint,
  PageBlueprint,
  createFrontendPlugin,
  FrontendPlugin,
} from '@backstage/frontend-plugin-api';
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import {
  compatWrapper,
  convertLegacyRouteRef,
  convertLegacyRouteRefs,
} from '@backstage/core-compat-api';
import { rootRouteRef, userProposalsRouteRef } from './routes';
import { ownershipMatcherApiRef, OwnershipMatcherClient } from './api';
import { QueryProvider } from './query/QueryProvider';

/** @alpha */
export const ownershipMatcherApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: ownershipMatcherApiRef,
      deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
      factory: ({ discoveryApi, fetchApi }) =>
        new OwnershipMatcherClient({ discoveryApi, fetchApi }),
    }),
});

// Admin page — full catalogue-wide inventory + scan controls.
/** @alpha */
export const ownershipMatcherPage = PageBlueprint.make({
  params: {
    path: '/ownership-matcher',
    // Child pages render their own <Page>/<Header>; suppress the redundant
    // new-frontend PluginHeader.
    noHeader: true,
    routeRef: convertLegacyRouteRef(rootRouteRef),
    loader: () =>
      import('./Router').then(m =>
        compatWrapper(
          <QueryProvider>
            <m.Router />
          </QueryProvider>,
        ),
      ),
  },
});

// User-facing page — scoped to the current user's teams.
/** @alpha */
export const userOwnershipPage = PageBlueprint.make({
  name: 'user-proposals',
  params: {
    path: '/my-ownership-proposals',
    // Component renders its own <Page>/<Header>; suppress the redundant
    // new-frontend PluginHeader.
    noHeader: true,
    routeRef: convertLegacyRouteRef(userProposalsRouteRef),
    loader: () =>
      import('./Router').then(m =>
        compatWrapper(
          <QueryProvider>
            <m.UserOwnershipPage />
          </QueryProvider>,
        ),
      ),
  },
});

/** @alpha */
const plugin: FrontendPlugin = createFrontendPlugin({
  pluginId: 'ownership-matcher',
  extensions: [ownershipMatcherApi, ownershipMatcherPage, userOwnershipPage],
  routes: convertLegacyRouteRefs({
    root: rootRouteRef,
    myProposals: userProposalsRouteRef,
  }),
});

export default plugin;
