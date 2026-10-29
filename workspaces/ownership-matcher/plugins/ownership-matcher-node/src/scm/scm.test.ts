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

import { ScmError, isScmError } from './ScmError';
import { createRestrictedFetch } from './restrictedFetch';

describe('ScmError', () => {
  it.each([
    ['conflict', true],
    ['read-only', true],
    ['rate-limited', true],
    ['unavailable', true],
    ['unknown', true],
    ['auth', false],
    ['not-found', false],
    ['invalid', false],
  ] as const)('defaults %s to retryable=%s', (kind, retryable) => {
    expect(new ScmError(kind, 'x').retryable).toBe(retryable);
  });

  it('lets the provider override retryable and keeps the http status', () => {
    const err = new ScmError('auth', 'expired', {
      retryable: true,
      httpStatus: 401,
    });
    expect(err).toMatchObject({
      kind: 'auth',
      retryable: true,
      httpStatus: 401,
      name: 'ScmError',
    });
  });

  it('is recognised by isScmError, also when structurally cloned by name', () => {
    expect(isScmError(new ScmError('conflict', 'stale'))).toBe(true);
    const foreign = Object.assign(new Error('x'), {
      name: 'ScmError',
      kind: 'auth',
    });
    expect(isScmError(foreign)).toBe(true);
    expect(isScmError(new Error('x'))).toBe(false);
    expect(isScmError('ScmError')).toBe(false);
  });
});

describe('createRestrictedFetch', () => {
  const base = jest.fn(async () => new Response('ok'));
  const restricted = createRestrictedFetch(
    ['scm.example.com', 'api.example.com:8443'],
    base as typeof fetch,
  );

  beforeEach(() => base.mockClear());

  it('passes allowed hosts through without following redirects', async () => {
    await restricted('https://scm.example.com/a', { method: 'POST' });
    await restricted(new URL('https://api.example.com:8443/b'));
    expect(base).toHaveBeenCalledTimes(2);
    expect(base).toHaveBeenNthCalledWith(1, 'https://scm.example.com/a', {
      method: 'POST',
      redirect: 'manual',
    });
  });

  it('rejects other hosts, ports and schemes before calling fetch', async () => {
    await expect(restricted('https://evil.example.com/a')).rejects.toThrow(
      /allowed-hosts/,
    );
    await expect(restricted('https://api.example.com/b')).rejects.toThrow(
      /allowed-hosts/,
    );
    await expect(restricted('ftp://scm.example.com/a')).rejects.toThrow(
      /scheme/,
    );
    expect(base).not.toHaveBeenCalled();
  });

  it('requires at least one host', () => {
    expect(() => createRestrictedFetch([])).toThrow(/at least one/);
  });
});
