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

import { assertSafeUrl } from '../utils/assertSafeUrl';

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * A `fetch` that only reaches `allowedHosts` over http(s) — the SSRF guard
 * handed to SCM providers as `ScmProviderContext.fetch`. A disallowed URL
 * rejects before any request is made. Redirects are not followed, so a
 * response cannot bounce the request to another host.
 *
 * @public
 */
export function createRestrictedFetch(
  allowedHosts: ReadonlyArray<string>,
  baseFetch: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (allowedHosts.length === 0) {
    throw new Error(
      'createRestrictedFetch: at least one allowed host is required',
    );
  }
  const restricted = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    assertSafeUrl(requestUrl(input), allowedHosts);
    return baseFetch(input, { ...init, redirect: 'manual' });
  };
  return restricted as typeof fetch;
}

/**
 * Hosts an integration may be reached on: its `config.host` plus the host of
 * its `config.apiBaseUrl` (they differ for e.g. GitHub Enterprise or a
 * Bitbucket Server API on another host). Every built-in `@backstage/integration`
 * class exposes these on `config`; the `ScmIntegration` interface doesn't.
 *
 * @public
 */
export function integrationHosts(integration: object): string[] {
  const config = (
    integration as { config?: { host?: unknown; apiBaseUrl?: unknown } }
  ).config;
  const hosts = new Set<string>();
  if (typeof config?.host === 'string' && config.host) hosts.add(config.host);
  if (typeof config?.apiBaseUrl === 'string') {
    try {
      hosts.add(new URL(config.apiBaseUrl).host);
    } catch {
      // A malformed apiBaseUrl contributes no host.
    }
  }
  return [...hosts];
}
