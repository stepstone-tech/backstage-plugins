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

/**
 * EntityStore repo mapping: SCM-neutral repository identity round-trips
 * through `ownership_entities`, on in-memory SQLite so it runs without Docker.
 */
import { TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from './service/DatabaseOwnershipStore';
import { entityRepo } from './types';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

describe('EntityStore repo mapping', () => {
  const bitbucket = {
    type: 'bitbucketServer',
    host: 'repo.example.com',
    path: 'PROJ/my-repo',
    webUrl: 'https://repo.example.com/projects/PROJ/repos/my-repo/browse',
  };
  const gitlab = {
    type: 'gitlab',
    host: 'gitlab.com',
    path: 'acme/platform/my-repo',
    webUrl: 'https://gitlab.com/acme/platform/my-repo',
  };

  async function createStore() {
    const knex = await databases.init('SQLITE_3');
    const database = {
      getClient: async () => knex,
      migrations: { skip: false },
    } as any;
    return { store: await DatabaseOwnershipStore.create({ database }), knex };
  }

  it('writes an ScmRepoRef on create and reads it back with entityRepo', async () => {
    const { store } = await createStore();
    const id = await store.createEntity({
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_check: 'orphaned',
      repo: bitbucket,
    });

    const row = (await store.getEntityById(id))!;
    expect(row).toMatchObject({
      scm_type: 'bitbucketServer',
      repo_host: 'repo.example.com',
      repo_path: 'PROJ/my-repo',
      repo_url: bitbucket.webUrl,
    });
    expect(entityRepo(row)).toEqual(bitbucket);
  });

  it('a repo that moved hosts updates the same row; no repo keeps the stored one', async () => {
    const { store, knex } = await createStore();
    const id = await store.createEntity({
      entity_ref: 'component:default/svc',
      entity_name: 'svc',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_check: 'orphaned',
      repo: bitbucket,
    });

    await store.updateEntityLastScanned(id, 'scan-2', gitlab);
    await store.updateEntityLastScanned(id, 'scan-3', undefined);

    const rows = await knex('ownership_entities');
    expect(rows).toHaveLength(1);
    expect(entityRepo(rows[0])).toEqual(gitlab);
  });

  it('entityRepo is undefined for rows without repo data', () => {
    expect(
      entityRepo({
        scm_type: null,
        repo_host: null,
        repo_path: null,
        repo_url: null,
      }),
    ).toBeUndefined();
  });
});
