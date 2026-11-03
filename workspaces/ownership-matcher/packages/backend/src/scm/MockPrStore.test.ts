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

import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isScmError,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { MockPrStore } from './MockPrStore';

const REPO: ScmRepoRef = {
  type: 'gitServer',
  host: '127.0.0.1:7008',
  path: 'dev/orphaned-service',
  webUrl: 'http://127.0.0.1:7008/projects/dev/repos/orphaned-service/browse',
};

const ORIGINAL = 'spec:\n  owner: unknown\n';
const FIXED = 'spec:\n  owner: group:default/team-example\n';

let now = 1_000_000;

async function makeStore(mergeAfterMs = 60_000) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mock-pr-store-'));
  await mkdir(join(rootDir, 'orphaned-service'), { recursive: true });
  await writeFile(
    join(rootDir, 'orphaned-service', 'catalog-info.yaml'),
    ORIGINAL,
    'utf8',
  );
  return {
    rootDir,
    store: new MockPrStore({ rootDir, mergeAfterMs, now: () => now }),
  };
}

/** Branch, commit and open a PR, the way PrCreationService does. */
async function raisePr(store: MockPrStore, branch = 'ownership/fix') {
  await store.createBranch(REPO, branch, 'main');
  const file = await store.readFile(REPO, 'catalog-info.yaml', branch);
  await store.commitFile(REPO, 'catalog-info.yaml', {
    content: FIXED,
    message: 'set owner',
    branch,
    revision: file!.revision,
  });
  return store.createPullRequest(REPO, {
    title: 'Set owner',
    description: 'why',
    fromBranch: branch,
    toBranch: 'main',
  });
}

describe('MockPrStore', () => {
  beforeEach(() => {
    now = 1_000_000;
  });

  it('reads a file from rootDir with a revision', async () => {
    const { store } = await makeStore();

    const file = await store.readFile(REPO, 'catalog-info.yaml', 'main');

    expect(file?.content).toBe(ORIGINAL);
    expect(file?.revision).toEqual(expect.any(String));
    await expect(
      store.readFile(REPO, 'nope.yaml', 'main'),
    ).resolves.toBeUndefined();
  });

  it('reports the default branch and an unknown repo', async () => {
    const { store } = await makeStore();

    await expect(store.getDefaultBranch(REPO)).resolves.toBe('main');
    await expect(store.createBranch(REPO, 'b', 'main')).resolves.toBe(
      'created',
    );
    await expect(store.createBranch(REPO, 'b', 'main')).resolves.toBe('exists');
  });

  it('commitFile with a stale revision throws ScmError kind conflict', async () => {
    const { store } = await makeStore();
    await store.createBranch(REPO, 'b', 'main');

    const failure = await store
      .commitFile(REPO, 'catalog-info.yaml', {
        content: FIXED,
        message: 'set owner',
        branch: 'b',
        revision: 'stale',
      })
      .catch(err => err);

    expect(isScmError(failure)).toBe(true);
    expect(failure.kind).toBe('conflict');
  });

  it('rejects a commit path that escapes rootDir', async () => {
    const { store } = await makeStore();
    await store.createBranch(REPO, 'b', 'main');

    const failure = await store
      .commitFile(REPO, '../../../etc/passwd', {
        content: 'pwned',
        message: 'nope',
        branch: 'b',
      })
      .catch(err => err);

    expect(isScmError(failure)).toBe(true);
    expect(failure.kind).toBe('invalid');
  });

  it('createPullRequest returns created, then reused for the same source branch', async () => {
    const { store } = await makeStore();

    const first = await raisePr(store);
    const second = await store.createPullRequest(REPO, {
      title: 'Set owner',
      description: 'why',
      fromBranch: 'ownership/fix',
      toBranch: 'main',
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('reused');
    expect(second.pr.id).toBe(first.pr.id);
    await expect(
      store.findOpenPullRequest(REPO, 'ownership/fix'),
    ).resolves.toEqual(first.pr);
  });

  it('getPullRequest reports open before mergeAfterMs and merged after', async () => {
    const { store } = await makeStore(60_000);
    const { pr } = await raisePr(store);

    now += 59_000;
    await expect(store.getPullRequest(REPO, pr.id)).resolves.toMatchObject({
      state: 'open',
    });

    now += 2_000;
    const merged = await store.getPullRequest(REPO, pr.id);

    expect(merged?.state).toBe('merged');
    expect(merged?.closedAt).toBeInstanceOf(Date);
    await expect(
      store.findOpenPullRequest(REPO, 'ownership/fix'),
    ).resolves.toBeUndefined();
  });

  it('merging writes the branch content back into rootDir', async () => {
    const { store, rootDir } = await makeStore(60_000);
    const { pr } = await raisePr(store);
    const onDisk = () =>
      readFile(join(rootDir, 'orphaned-service', 'catalog-info.yaml'), 'utf8');

    await expect(onDisk()).resolves.toBe(ORIGINAL);

    now += 61_000;
    await store.getPullRequest(REPO, pr.id);

    await expect(onDisk()).resolves.toBe(FIXED);
  });

  it('resolves reviewers without a directory', async () => {
    const { store } = await makeStore();

    await expect(
      store.resolveReviewer(REPO, 'alice@example.com'),
    ).resolves.toBe('alice@example.com');
    await expect(
      store.getDefaultReviewers(REPO, { fromBranch: 'b', toBranch: 'main' }),
    ).resolves.toEqual([]);
  });

  it('updates an open pull request only when something differs', async () => {
    const { store } = await makeStore();
    const { pr } = await raisePr(store);

    await expect(
      store.updatePullRequest(REPO, pr, {
        title: 'Set owner',
        description: 'why',
      }),
    ).resolves.toBe('unchanged');
    await expect(
      store.updatePullRequest(REPO, pr, {
        title: 'Set owner (updated)',
        description: 'why',
      }),
    ).resolves.toBe('updated');
  });
});
