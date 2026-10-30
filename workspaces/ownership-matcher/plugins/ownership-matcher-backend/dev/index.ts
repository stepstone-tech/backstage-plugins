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

/*
 * Development backend for ownership-matcher, started with `yarn start` at the
 * repository root (`backstage-cli repo start --plugin ownership-matcher`).
 *
 * It runs the plugin against the sample catalog in the workspace's examples/
 * directory, with guest sign-in and an allow-all permission policy, and uses
 * the Postgres from the workspace's docker-compose.yml. Configuration lives in
 * workspaces/ownership-matcher/app-config.yaml. See the workspace README.
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-events-backend'));

backend.add(import('@backstage/plugin-permission-backend'));
backend.add(
  import('@backstage/plugin-permission-backend-module-allow-all-policy'),
);

backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

backend.add(import('../src'));
// The Bitbucket Server and MS Graph e-mail modules need real credentials, so
// they are not installed here. To try one, configure it in the workspace's
// app-config.local.yaml (gitignored, loaded by `yarn start`) and add it with a
// relative import, since the modules depend on this package and not the other
// way round:
// backend.add(
//   import('../../ownership-matcher-backend-module-bitbucket-server/src'),
// );

backend.start();
