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

import { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  ScmIntegration,
  ScmIntegrationRegistry,
  ScmIntegrations,
} from '@backstage/integration';
import {
  createRestrictedFetch,
  integrationHosts,
  readScmHostConfigs,
  type ScmClient,
  type ScmFileLocation,
  type ScmHostConfig,
  type ScmProvider,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

/** Outcome of routing a `managed-by-location` to an SCM provider. */
export type ScmLocationResolution =
  | { status: 'ok'; client: ScmClient; location: ScmFileLocation }
  /** No (or a non-`url:`) managed-by-location. */
  | { status: 'missing' }
  /** No `integrations.*` entry serves this host. */
  | { status: 'no-integration'; host: string }
  /** An integration exists, but no provider module is installed for its type. */
  | { status: 'no-provider'; host: string; type: string }
  /** The provider does not recognise the URL as a file location. */
  | { status: 'unparseable'; url: string };

/**
 * Routes entities to SCM providers: `managed-by-location` URL →
 * `integrations.byUrl` → provider registered for the integration's `type` →
 * `client.parseLocation`. One client is created (lazily) per integration host
 * and reused; each gets a `fetch` restricted to that integration's hosts.
 */
export class ScmRegistry {
  private readonly providers: ReadonlyMap<string, ScmProvider>;
  private readonly clients = new Map<string, Promise<ScmClient>>();

  constructor(
    private readonly integrations: ScmIntegrationRegistry,
    providers: Iterable<ScmProvider>,
    private readonly hostConfigs: ReadonlyArray<ScmHostConfig>,
    private readonly logger: LoggerService,
  ) {
    this.providers = new Map([...providers].map(p => [p.type, p]));
  }

  static fromConfig(
    config: Config,
    providers: Iterable<ScmProvider>,
    logger: LoggerService,
  ): ScmRegistry {
    return new ScmRegistry(
      ScmIntegrations.fromConfig(config),
      providers,
      readScmHostConfigs(config),
      logger,
    );
  }

  /** Types of the registered providers, e.g. `['bitbucketServer']`. */
  get providerTypes(): string[] {
    return [...this.providers.keys()];
  }

  /** Resolve the provider client and file location for a `backstage.io/managed-by-location` value. */
  async forLocation(
    managedByLocation: string | undefined,
  ): Promise<ScmLocationResolution> {
    const url = toTargetUrl(managedByLocation);
    if (!url) return { status: 'missing' };

    const integration = this.integrations.byUrl(url);
    if (!integration) return { status: 'no-integration', host: hostOf(url) };

    const host = integrationHosts(integration)[0] ?? hostOf(url);
    const client = await this.clientForIntegration(integration, host);
    if (!client) {
      return { status: 'no-provider', host, type: integration.type };
    }

    const location = client.parseLocation(url);
    if (!location) return { status: 'unparseable', url };
    return { status: 'ok', client, location };
  }

  /**
   * Best-effort repository identity for an entity: `undefined` when the
   * location can't be routed to a provider. Never throws (a failing provider
   * is logged), so scans don't depend on SCM availability.
   */
  async repoFor(
    managedByLocation: string | undefined,
  ): Promise<ScmRepoRef | undefined> {
    try {
      const resolved = await this.forLocation(managedByLocation);
      return resolved.status === 'ok' ? resolved.location.repo : undefined;
    } catch (err) {
      this.logger.warn(
        `SCM provider failed to resolve ${managedByLocation}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /** The client serving `repo`'s host, or `undefined` when no provider is installed for it. */
  async clientFor(repo: ScmRepoRef): Promise<ScmClient | undefined> {
    const integration = this.integrations.byHost(repo.host);
    return integration
      ? this.clientForIntegration(integration, repo.host)
      : undefined;
  }

  private async clientForIntegration(
    integration: ScmIntegration,
    host: string,
  ): Promise<ScmClient | undefined> {
    const provider = this.providers.get(integration.type);
    if (!provider) return undefined;

    let client = this.clients.get(host);
    if (!client) {
      client = Promise.resolve().then(() =>
        provider.createClient({
          integration,
          hostConfig: this.hostConfigs.find(h => h.host === host),
          logger: this.logger.child({
            scmHost: host,
            scmType: integration.type,
          }),
          fetch: createRestrictedFetch([
            host,
            ...integrationHosts(integration),
          ]),
        }),
      );
      this.clients.set(host, client);
      // Don't cache a failed creation: the next call tries again.
      client.catch(() => this.clients.delete(host));
    }
    return client;
  }
}

/** `url:https://...` (or a bare URL) → the http(s) target; anything else → undefined. */
function toTargetUrl(
  managedByLocation: string | undefined,
): string | undefined {
  if (!managedByLocation) return undefined;
  const target = managedByLocation.replace(/^url:/, '');
  return /^https?:\/\//i.test(target) ? target : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
