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

import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  rawUrlPath,
  startDevScmServer,
  type DevScmServer,
} from './devScmServer';

const ORIGINAL = 'kind: Component\n';

async function makeSourceDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dev-catalog-src-'));
  await mkdir(join(dir, 'a'), { recursive: true });
  await writeFile(join(dir, 'a', 'catalog-info.yaml'), ORIGINAL, 'utf8');
  return dir;
}

describe('startDevScmServer', () => {
  const started: DevScmServer[] = [];

  async function start(opts: { sourceDir: string; port?: number }) {
    const server = await startDevScmServer({ port: 0, ...opts });
    started.push(server);
    return server;
  }

  afterEach(async () => {
    await Promise.all(started.splice(0).map(s => s.close()));
  });

  it('serves a file from a fresh copy of the source directory', async () => {
    const sourceDir = await makeSourceDir();
    const server = await start({ sourceDir });

    const res = await fetch(
      `${server.url}${rawUrlPath('a', 'catalog-info.yaml')}`,
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe(ORIGINAL);
    // The copy is writable and separate from the source.
    expect(server.rootDir).not.toBe(sourceDir);
    await expect(
      readFile(join(server.rootDir, 'a', 'catalog-info.yaml'), 'utf8'),
    ).resolves.toBe(ORIGINAL);
  });

  it('resets the copy on every start, discarding earlier writes', async () => {
    const sourceDir = await makeSourceDir();
    const first = await start({ sourceDir });
    await writeFile(
      join(first.rootDir, 'a', 'catalog-info.yaml'),
      'kind: Tampered\n',
      'utf8',
    );
    await first.close();

    const second = await start({ sourceDir });
    const res = await fetch(
      `${second.url}${rawUrlPath('a', 'catalog-info.yaml')}`,
    );

    await expect(res.text()).resolves.toBe(ORIGINAL);
  });

  it('404s for an unknown path', async () => {
    const server = await start({ sourceDir: await makeSourceDir() });

    await expect(
      fetch(`${server.url}${rawUrlPath('a', 'nope.yaml')}`).then(r => r.status),
    ).resolves.toBe(404);
    await expect(
      fetch(`${server.url}/nope.yaml`).then(r => r.status),
    ).resolves.toBe(404);
  });

  it('404s for a path that escapes the served directory', async () => {
    const server = await start({ sourceDir: await makeSourceDir() });

    const res = await fetch(
      `${server.url}/rest/api/1.0/projects/dev/repos/a/raw/..%2F..%2Fetc%2Fpasswd`,
    );

    expect(res.status).toBe(404);
  });

  it('refuses to start when the port is taken, naming the port', async () => {
    const blocker = createServer();
    const port: number = await new Promise(resolve =>
      blocker.listen(0, '127.0.0.1', () =>
        resolve((blocker.address() as { port: number }).port),
      ),
    );

    try {
      await expect(
        startDevScmServer({ sourceDir: await makeSourceDir(), port }),
      ).rejects.toThrow(String(port));
    } finally {
      await new Promise(resolve => blocker.close(resolve));
    }
  });
});
