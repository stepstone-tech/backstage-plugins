#!/usr/bin/env node
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
 * `yarn start` for this workspace.
 *
 * Starts the workspace's Postgres (docker-compose.yml), then packages/app and
 * packages/backend with `backstage-cli repo start`, using this workspace's
 * app-config.yaml and, if it exists, app-config.local.yaml.
 *
 * The wrapper exists for two reasons: ownership-matcher's migrations use
 * Postgres-only features, so the database has to be up first; and passing
 * --config turns off Backstage's own app-config.local.yaml lookup, so it has to
 * be added back here by absolute path.
 */
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const workspaceDir = path.resolve(__dirname, '..');

const composeFile = path.join(workspaceDir, 'docker-compose.yml');
if (fs.existsSync(composeFile)) {
  const db = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'up', '-d', '--wait'],
    { stdio: 'inherit' },
  );
  if (db.status !== 0) {
    process.exit(db.status ?? 1);
  }
}

const configArgs = ['app-config.yaml', 'app-config.local.yaml']
  .map(file => path.join(workspaceDir, file))
  .filter(file => fs.existsSync(file))
  .flatMap(file => ['--config', file]);

const child = spawn('yarn', ['backstage-cli', 'repo', 'start', ...configArgs], {
  cwd: workspaceDir,
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 0));
