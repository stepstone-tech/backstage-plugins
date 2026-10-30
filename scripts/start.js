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
 * Local development for one workspace: `yarn start [workspace]`.
 *
 * Starts the workspace's Postgres (workspaces/<name>/docker-compose.yml, if
 * present), then the dev/ entry points of its plugins with
 * `backstage-cli repo start --plugin <name>`, using the workspace's
 * app-config.yaml and, if it exists, app-config.local.yaml. Passing --config
 * turns off Backstage's own app-config.local.yaml lookup, so it's added here.
 *
 * The workspace name doubles as the plugin ID that --plugin matches. With a
 * single workspace the argument can be left out.
 */
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const workspacesDir = path.join(root, 'workspaces');
const available = fs
  .readdirSync(workspacesDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name);

const workspace =
  process.argv[2] ?? (available.length === 1 ? available[0] : undefined);
if (!workspace || !available.includes(workspace)) {
  console.error(
    `Usage: yarn start <workspace>\nAvailable workspaces: ${available.join(
      ', ',
    )}`,
  );
  process.exit(1);
}

const workspaceDir = path.join(workspacesDir, workspace);

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

const child = spawn(
  'yarn',
  ['backstage-cli', 'repo', 'start', '--plugin', workspace, ...configArgs],
  { cwd: root, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 0));
