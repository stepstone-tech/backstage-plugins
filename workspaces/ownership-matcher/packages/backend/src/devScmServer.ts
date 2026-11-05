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

import { createServer, type Server, type ServerResponse } from 'node:http';
import { cp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Project key every mock repository lives under. The served URLs follow the
 * URL shape of the integration type the dev host is configured as (see
 * `MOCK_SCM_TYPE`): Backstage's URL reader for that type claims every read on
 * the host and rewrites the target to `<apiBaseUrl>/projects/<key>/repos/<slug>/raw/<path>`.
 */
export const DEV_PROJECT_KEY = 'dev';

/**
 * Port the dev SCM server listens on. 3000 and 7007 are taken by `yarn start`
 * and 54321 by the workspace's Postgres, so this is a fourth fixed port —
 * `examples/root/root.yaml` and `app-config.yaml` both hardcode it.
 */
export const DEV_SCM_PORT = 7008;

/** The repository holding `root.yaml` and `org.yaml` — everything that is not a component. */
export const ROOT_REPO_SLUG = 'root';

/** API path the catalog's URL reader fetches a file through. */
export function rawUrlPath(repoSlug: string, filePath: string): string {
  return `/rest/api/1.0/projects/${DEV_PROJECT_KEY}/repos/${repoSlug}/raw/${filePath}`;
}

/** Browse URL a catalog location points at, i.e. the entity's `managed-by-location`. */
export function browseUrl(
  baseUrl: string,
  repoSlug: string,
  filePath: string,
): string {
  return `${baseUrl}/projects/${DEV_PROJECT_KEY}/repos/${repoSlug}/browse/${filePath}`;
}

/**
 * Absolute path of a file inside a mock repository, or `undefined` when the
 * repo slug or the path would escape the served directory. The one mapping
 * rule: a top-level directory of the served copy is a repository.
 */
export function repoFilePath(
  rootDir: string,
  repoSlug: string,
  filePath: string,
): string | undefined {
  if (!repoSlug || repoSlug.includes('/') || repoSlug.includes('\\')) {
    return undefined;
  }
  const base = resolve(rootDir);
  const target = resolve(base, repoSlug, filePath);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

/** A running dev SCM server. `rootDir` is the writable copy it serves. */
export interface DevScmServer {
  /** Origin to build catalog locations from, e.g. `http://127.0.0.1:7008`. */
  url: string;
  rootDir: string;
  close(): Promise<void>;
}

const RAW_PATH =
  /^\/rest\/api\/1\.0\/projects\/([^/]+)\/repos\/([^/]+)\/raw\/(.+)$/;

/**
 * Serve a throwaway copy of `sourceDir` over HTTP, so the dev catalog's
 * entities get a `url:` `managed-by-location` that an SCM provider can route.
 *
 * The copy is recreated on every start: a previous run's demo writes the fixed
 * owner back into it, and a second `yarn start` reading those would find
 * nothing left to flag.
 */
export async function startDevScmServer(opts: {
  sourceDir: string;
  port: number;
}): Promise<DevScmServer> {
  // Named after the port, not randomised: the port is the server's identity
  // (two of these cannot run at once anyway), and a predictable path is what
  // lets you `cat` the served file while walking a case.
  const rootDir = join(tmpdir(), `ownership-matcher-dev-catalog-${opts.port}`);
  await rm(rootDir, { recursive: true, force: true });
  await cp(opts.sourceDir, rootDir, { recursive: true });

  const server = createServer((req, res) => {
    void serve(rootDir, req.url ?? '', res);
  });

  const port = await listen(server, opts.port);

  return {
    url: `http://127.0.0.1:${port}`,
    rootDir,
    close: () => new Promise<void>(done => server.close(() => done())),
  };
}

async function serve(
  rootDir: string,
  url: string,
  res: ServerResponse,
): Promise<void> {
  const match = RAW_PATH.exec(url.split('?')[0]);
  let file: string | undefined;
  if (match && decodeSegment(match[1]) === DEV_PROJECT_KEY) {
    const repoSlug = decodeSegment(match[2]);
    const filePath = decodeSegment(match[3]);
    if (repoSlug !== undefined && filePath !== undefined) {
      file = repoFilePath(rootDir, repoSlug, filePath);
    }
  }

  const content = file
    ? await readFile(file, 'utf8').catch(() => undefined)
    : undefined;
  if (content === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(content);
}

function decodeSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((ok, fail) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      fail(
        err.code === 'EADDRINUSE'
          ? new Error(
              `The dev SCM server cannot bind 127.0.0.1:${port} — something already holds it. ` +
                `Find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`,
              { cause: err },
            )
          : err,
      );
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      ok(typeof address === 'object' && address ? address.port : port);
    });
  });
}
