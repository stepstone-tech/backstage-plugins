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
 * Development backend for ownership-matcher, started by the workspace's
 * `yarn start` (scripts/start.js -> `backstage-cli repo start`).
 *
 * It runs the plugin against the sample catalog in the workspace's examples/
 * directory, with guest sign-in and an allow-all permission policy, and uses
 * the Postgres from the workspace's docker-compose.yml. Configuration lives in the workspace's app-config.yaml. See its README.
 *
 * The catalog is not read off disk: a throwaway copy of examples/ is served
 * over HTTP first, so every component gets a `url:` managed-by-location that
 * the dev SCM provider below can route. That provider is what gives
 * top-contributor commits to score and turns an accepted proposal into a pull
 * request that merges itself back into the served copy.
 */

import { createBackend } from '@backstage/backend-defaults';
import { resolvePackagePath } from '@backstage/backend-plugin-api';
import { DEV_SCM_PORT, startDevScmServer } from './devScmServer';
import { createDevScmModule } from './scm/module';

/**
 * How long a dev pull request stays open before it merges itself.
 *
 * Zero on purpose. One deadline-checker sweep raises the PR and reconciles it
 * in the same pass, so a PR with any delay at all is still open at its only
 * reconciliation — and `PR_RECONCILE_INTERVAL_MS` then puts the next check an
 * hour out, which strands the case in `accepted`. Merging immediately lets a
 * single sweep close the loop. Raise this to watch the open state in the UI,
 * and expect to wait out that hour.
 */
const MERGE_AFTER_MS = 0;

async function main() {
  // Must be up before the backend starts: the catalog reads its root location
  // from this server during initialisation.
  const catalog = await startDevScmServer({
    // Not `__dirname`: it moves between dev and a bundled build. This package
    // sits at <workspace>/packages/backend, so the sample catalog is two up.
    sourceDir: resolvePackagePath('backend', '..', '..', 'examples'),
    port: DEV_SCM_PORT,
  });
  console.log(`[dev] serving the example catalog on ${catalog.url}`);

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

  backend.add(
    import('@stepstone-tech/backstage-plugin-ownership-matcher-backend'),
  );
  backend.add(
    createDevScmModule({
      rootDir: catalog.rootDir,
      host: new URL(catalog.url).host,
      mergeAfterMs: MERGE_AFTER_MS,
    }),
  );
  // The Bitbucket Server and MS Graph e-mail modules need real credentials, so
  // they are not installed here. To try one, configure it in the workspace's
  // app-config.local.yaml (gitignored, loaded by `yarn start`), add the package
  // to this package.json and install it:
  // backend.add(
  //   import(
  //     '@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-bitbucket-server'
  //   ),
  // );

  backend.start();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
