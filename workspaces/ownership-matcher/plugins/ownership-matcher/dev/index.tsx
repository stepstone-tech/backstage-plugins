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
 * Development app for ownership-matcher, started with `yarn start` at the
 * repository root together with the backend's dev/index.ts. See the workspace
 * README.
 */
import { createDevApp } from '@backstage/frontend-dev-utils';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import notificationsPlugin from '@backstage/plugin-notifications/alpha';
import orgPlugin from '@backstage/plugin-org/alpha';
import signalsPlugin from '@backstage/plugin-signals/alpha';
import plugin from '../src/alpha';

createDevApp({
  features: [
    plugin,
    catalogPlugin,
    notificationsPlugin,
    orgPlugin,
    signalsPlugin,
  ],
});
