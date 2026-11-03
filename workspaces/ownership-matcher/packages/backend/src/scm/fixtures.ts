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

/** A commit author. The local part of the address must name a User in the workspace's examples/root/org.yaml. */
export interface CommitAuthor {
  email: string;
  name: string;
}

const BOB: CommitAuthor = { email: 'bob@example.com', name: 'Bob Example' };
const ALICE: CommitAuthor = {
  email: 'alice@example.com',
  name: 'Alice Example',
};
const CAROL: CommitAuthor = {
  email: 'carol@example.com',
  name: 'Carol Example',
};

const times = (count: number, author: CommitAuthor): CommitAuthor[] =>
  Array.from({ length: count }, () => author);

/**
 * Synthetic commit history per repository, newest first, keyed by
 * `ScmRepoRef.path`.
 *
 * `top-contributor` scores a team at its share of the commits, so the shape of
 * these lists is what gives the dev app a spread of confidence scores rather
 * than one value everywhere. With the default weights (top-contributor 0.5,
 * org-proximity 0.3) and a system owner scoring 0.6:
 *
 * - `orphaned-service` — 8/10 to team-example, which also owns its system:
 *   (0.5 * 0.8 + 0.3 * 0.6) / 0.8 = 0.725. Well over the 0.4 notification
 *   threshold, so it reaches `pending` on the user-facing tab.
 * - `placeholder-owner-library` — an even split. team-platform owns its
 *   system, so it lands at 0.5375 (`pending`, admin tab) while team-example
 *   reaches only 0.3125 (`possible_owner`). The contested case.
 * - `etl-pipeline` — all team-data, which also owns its system: 0.85, the
 *   `pending` proposal on the signed-in user's *second* team.
 * - `docs-portal` — deliberately absent: with no commits, org-proximity alone
 *   scores its system owner 0.225, which is `possible_owner`.
 * - `legacy-batch-job` — absent and without a system, so nothing scores it at
 *   all and the case goes `unresolved`.
 */
export const COMMIT_AUTHORS: Record<string, CommitAuthor[]> = {
  'dev/orphaned-service': [...times(8, BOB), ...times(2, ALICE)],
  'dev/placeholder-owner-library': [...times(5, ALICE), ...times(5, BOB)],
  'dev/owned-service': times(4, BOB),
  'dev/etl-pipeline': times(6, CAROL),
};
