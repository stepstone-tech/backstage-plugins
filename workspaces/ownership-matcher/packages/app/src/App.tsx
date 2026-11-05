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

import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import notificationsPlugin from '@backstage/plugin-notifications/alpha';
import orgPlugin from '@backstage/plugin-org/alpha';
import signalsPlugin from '@backstage/plugin-signals/alpha';
import ownershipMatcherPlugin from '@stepstone-tech/backstage-plugin-ownership-matcher/alpha';

/*
 * No sign-in page is declared here on purpose. The app plugin already ships
 * `sign-in-page:app`, which offers the `guest` provider, and `app.extensions`
 * in app-config.yaml enables it explicitly.
 *
 * Do not add a custom one under pluginId 'app': SignInPageBlueprint derives its
 * extension id from the plugin id, so it collides with the built-in and is
 * dropped as a duplicate (`EXTENSION_IGNORED`). The app then renders with no
 * sign-in page at all, every request goes out unauthenticated, and the catalog,
 * notifications and ownership-matcher all answer 401 — which the UI reports as
 * "you are not an administrator" rather than as an auth failure.
 */
export default createApp({
  features: [
    ownershipMatcherPlugin,
    catalogPlugin,
    notificationsPlugin,
    orgPlugin,
    signalsPlugin,
  ],
});
