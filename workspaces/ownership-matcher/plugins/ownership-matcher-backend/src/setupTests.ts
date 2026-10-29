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

// 30s gives Postgres connection-pool drain room to finish under
// --runInBand when many suites tear down TestDatabases pools sequentially.
jest.setTimeout(30_000);

// Backstage's `TestDatabases` auto-spawns a Postgres container via
// `testcontainers` when Docker is enabled — gated on `process.env.CI` being
// truthy. Set it unconditionally so the same default works in CI and locally
// (Docker socket required either way). Users can still bypass with their own
// `BACKSTAGE_TEST_DATABASE_POSTGRES16_CONNECTION_STRING`.
process.env.CI ??= 'true';

export {};
