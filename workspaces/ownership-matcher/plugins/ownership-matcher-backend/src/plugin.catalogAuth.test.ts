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

import { startTestBackend } from '@backstage/backend-test-utils';
import { ownershipMatcherPlugin } from './plugin';

// Records the options the plugin passes to CatalogClient, so the test can check
// that catalog requests are authenticated (they got a 401 without a token).
const catalogClientOptions: Array<{ fetchApi?: { fetch: typeof fetch } }> = [];

jest.mock('@backstage/catalog-client', () => {
  const actual = jest.requireActual('@backstage/catalog-client');
  return {
    ...actual,
    CatalogClient: jest.fn().mockImplementation(options => {
      catalogClientOptions.push(options);
      return new actual.CatalogClient(options);
    }),
  };
});

describe('ownershipMatcherPlugin catalog client', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('sends a service token with catalog requests', async () => {
    await startTestBackend({ features: [ownershipMatcherPlugin] });

    const fetchApi = catalogClientOptions[0]?.fetchApi;
    expect(fetchApi).toBeDefined();

    const fetchMock = jest.fn().mockResolvedValue(new Response('{}'));
    global.fetch = fetchMock;
    await fetchApi!.fetch('http://localhost/api/catalog/entities');

    const headers: Headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.get('authorization')).toMatch(/^Bearer .+/);
  });
});
