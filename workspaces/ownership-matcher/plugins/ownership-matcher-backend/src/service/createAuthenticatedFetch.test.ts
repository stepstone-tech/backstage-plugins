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
import { createAuthenticatedFetch } from './createAuthenticatedFetch';

describe('createAuthenticatedFetch', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response('{}'));
    global.fetch = fetchMock;
  });

  it('adds a service token for the target plugin', async () => {
    const auth = mockServices.auth();
    const { fetch } = createAuthenticatedFetch(auth, 'catalog');

    await fetch('http://localhost/api/catalog/entities');

    const headers: Headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.get('authorization')).toBe(
      `Bearer ${
        (
          await auth.getPluginRequestToken({
            onBehalfOf: await auth.getOwnServiceCredentials(),
            targetPluginId: 'catalog',
          })
        ).token
      }`,
    );
  });

  it('keeps an Authorization header the caller already set', async () => {
    const auth = mockServices.auth();
    const getToken = jest.spyOn(auth, 'getPluginRequestToken');
    const { fetch } = createAuthenticatedFetch(auth, 'catalog');

    await fetch('http://localhost/api/catalog/validate-entity', {
      method: 'POST',
      headers: { Authorization: 'Bearer caller-token' },
    });

    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('authorization')).toBe(
      'Bearer caller-token',
    );
    expect(getToken).not.toHaveBeenCalled();
  });

  it('keeps headers set on a Request input', async () => {
    const auth = mockServices.auth();
    const getToken = jest.spyOn(auth, 'getPluginRequestToken');
    const { fetch } = createAuthenticatedFetch(auth, 'catalog');

    await fetch(
      new Request('http://localhost/api/catalog/entities', {
        headers: { Authorization: 'Bearer request-token', 'X-Trace': 'abc' },
      }),
    );

    const headers: Headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.get('authorization')).toBe('Bearer request-token');
    expect(headers.get('x-trace')).toBe('abc');
    expect(getToken).not.toHaveBeenCalled();
  });
});
