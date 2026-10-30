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

import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import type {
  ScmClient,
  ScmProvider,
  ScmProviderContext,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { ScmRegistry } from './ScmRegistry';

const HOST = 'repo.example.com';
const LOCATION = `url:https://${HOST}/projects/PROJ/repos/my-repo/browse/catalog-info.yaml`;

const config = new ConfigReader({
  integrations: {
    bitbucketServer: [
      {
        host: HOST,
        apiBaseUrl: `https://${HOST}/rest/api/1.0`,
        token: 'read',
      },
    ],
    gitlab: [
      {
        host: 'gitlab.example.com',
        apiBaseUrl: 'https://gitlab-api.example.com/api/v4',
        token: 't',
      },
    ],
  },
  ownershipMatcher: {
    scm: { hosts: [{ host: HOST, writeToken: 'write' }] },
  },
});

/** A Bitbucket-ish provider that records the contexts it was given. */
function bitbucketProvider() {
  const contexts: ScmProviderContext[] = [];
  const client: ScmClient = {
    parseLocation: jest.fn((url: string) => {
      const m = /\/projects\/([^/]+)\/repos\/([^/]+)\/browse\/(.+)$/.exec(
        new URL(url).pathname,
      );
      if (!m) return undefined;
      return {
        repo: {
          type: 'bitbucketServer',
          host: HOST,
          path: `${m[1]}/${m[2]}`,
          webUrl: `https://${HOST}/projects/${m[1]}/repos/${m[2]}`,
        },
        path: m[3],
      };
    }),
  };
  const provider: ScmProvider & { createClient: jest.Mock } = {
    type: 'bitbucketServer',
    createClient: jest.fn((ctx: ScmProviderContext) => {
      contexts.push(ctx);
      return client;
    }),
  };
  return { provider, client, contexts };
}

function makeRegistry(providers: ScmProvider[]) {
  return ScmRegistry.fromConfig(config, providers, mockServices.logger.mock());
}

describe('ScmRegistry.forLocation', () => {
  it('routes a known host to its provider and parses the file location', async () => {
    const { provider, client } = bitbucketProvider();
    const registry = makeRegistry([provider]);

    const resolved = await registry.forLocation(LOCATION);

    expect(resolved).toEqual({
      status: 'ok',
      client,
      location: {
        repo: {
          type: 'bitbucketServer',
          host: HOST,
          path: 'PROJ/my-repo',
          webUrl: `https://${HOST}/projects/PROJ/repos/my-repo`,
        },
        path: 'catalog-info.yaml',
      },
    });
    // The provider receives the target URL without the `url:` prefix.
    expect(client.parseLocation).toHaveBeenCalledWith(
      LOCATION.slice('url:'.length),
    );
  });

  it('reports an unknown host as no-integration', async () => {
    const registry = makeRegistry([bitbucketProvider().provider]);

    await expect(
      registry.forLocation(
        'url:https://git.unknown.example/acme/repo/-/blob/main/catalog-info.yaml',
      ),
    ).resolves.toEqual({
      status: 'no-integration',
      host: 'git.unknown.example',
    });
  });

  it('reports a configured host without a provider module as no-provider', async () => {
    const registry = makeRegistry([bitbucketProvider().provider]);

    await expect(
      registry.forLocation(
        'url:https://gitlab.example.com/acme/repo/-/blob/main/catalog-info.yaml',
      ),
    ).resolves.toEqual({
      status: 'no-provider',
      host: 'gitlab.example.com',
      type: 'gitlab',
    });
  });

  it('with no providers installed, a configured host is no-provider', async () => {
    const registry = makeRegistry([]);

    expect(registry.providerTypes).toEqual([]);
    await expect(registry.forLocation(LOCATION)).resolves.toMatchObject({
      status: 'no-provider',
    });
  });

  it('reports a URL the provider cannot parse as unparseable', async () => {
    const registry = makeRegistry([bitbucketProvider().provider]);

    await expect(
      registry.forLocation(`url:https://${HOST}/projects/PROJ`),
    ).resolves.toEqual({
      status: 'unparseable',
      url: `https://${HOST}/projects/PROJ`,
    });
  });

  it.each([
    undefined,
    '',
    'file:/tmp/catalog-info.yaml',
    'url:ftp://repo.example.com/x',
  ])('reports %p as missing', async location => {
    const registry = makeRegistry([bitbucketProvider().provider]);
    await expect(registry.forLocation(location)).resolves.toEqual({
      status: 'missing',
    });
  });
});

describe('ScmRegistry client creation', () => {
  it('creates one client per host and reuses it', async () => {
    const { provider } = bitbucketProvider();
    const registry = makeRegistry([provider]);

    await registry.forLocation(LOCATION);
    await registry.forLocation(LOCATION.replace('my-repo', 'other-repo'));
    const resolved = await registry.forLocation(LOCATION);
    if (resolved.status !== 'ok') throw new Error('expected ok');
    await registry.clientFor(resolved.location.repo);

    expect(provider.createClient).toHaveBeenCalledTimes(1);
  });

  it('hands the provider its integration, per-host config and a host-restricted fetch', async () => {
    const { provider, contexts } = bitbucketProvider();
    const registry = makeRegistry([provider]);

    await registry.forLocation(LOCATION);

    const [ctx] = contexts;
    expect(ctx.integration.type).toBe('bitbucketServer');
    expect(ctx.hostConfig).toEqual({ host: HOST, writeToken: 'write' });
    await expect(ctx.fetch('https://evil.example.com/steal')).rejects.toThrow(
      /allowed-hosts/,
    );
  });

  it('allows the API host when it differs from the integration host', async () => {
    const contexts: ScmProviderContext[] = [];
    const gitlab: ScmProvider = {
      type: 'gitlab',
      createClient: ctx => {
        contexts.push(ctx);
        return { parseLocation: () => undefined };
      },
    };
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response('ok')) as typeof fetch;
    try {
      await makeRegistry([gitlab]).forLocation(
        'url:https://gitlab.example.com/a/b/-/blob/main/c.yaml',
      );
      await contexts[0].fetch('https://gitlab-api.example.com/api/v4/projects');
      await contexts[0].fetch('https://gitlab.example.com/a/b');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(contexts[0].hostConfig).toBeUndefined();
    } finally {
      global.fetch = realFetch;
    }
  });

  it('does not cache a failed client creation', async () => {
    const { provider, client } = bitbucketProvider();
    provider.createClient
      .mockRejectedValueOnce(new Error('bad config'))
      .mockReturnValue(client);
    const registry = makeRegistry([provider]);

    await expect(registry.forLocation(LOCATION)).rejects.toThrow('bad config');
    await expect(registry.forLocation(LOCATION)).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('clientFor returns undefined for a host without integration or provider', async () => {
    const registry = makeRegistry([bitbucketProvider().provider]);
    const repo = {
      type: 'gitlab',
      host: 'gitlab.example.com',
      path: 'a/b',
      webUrl: 'x',
    };

    await expect(registry.clientFor(repo)).resolves.toBeUndefined();
    await expect(
      registry.clientFor({ ...repo, host: 'nowhere.example' }),
    ).resolves.toBeUndefined();
  });
});

describe('ScmRegistry.repoFor', () => {
  it('returns the repo for a routable location and undefined otherwise', async () => {
    const registry = makeRegistry([bitbucketProvider().provider]);

    await expect(registry.repoFor(LOCATION)).resolves.toMatchObject({
      path: 'PROJ/my-repo',
    });
    await expect(registry.repoFor(undefined)).resolves.toBeUndefined();
    await expect(
      registry.repoFor('url:https://gitlab.example.com/a/b/-/blob/main/c.yaml'),
    ).resolves.toBeUndefined();
  });

  it('never throws: a failing provider is logged and yields undefined', async () => {
    const { provider } = bitbucketProvider();
    provider.createClient.mockRejectedValue(new Error('boom'));
    const logger = mockServices.logger.mock();
    const registry = ScmRegistry.fromConfig(config, [provider], logger);

    await expect(registry.repoFor(LOCATION)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
