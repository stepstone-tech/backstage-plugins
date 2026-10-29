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

import { getQueryClient, resetQueryClient } from './queryClient';

describe('queryClient', () => {
  afterEach(() => resetQueryClient());

  it('returns the same client instance across calls', () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });

  it('does not retry failed queries', () => {
    expect(getQueryClient().getDefaultOptions().queries?.retry).toBe(false);
  });

  it('does not refetch on window focus', () => {
    expect(
      getQueryClient().getDefaultOptions().queries?.refetchOnWindowFocus,
    ).toBe(false);
  });

  it('resetQueryClient drops cached data and hands back a fresh client', () => {
    const client = getQueryClient();
    client.setQueryData(['probe'], 'cached');

    resetQueryClient();

    expect(getQueryClient().getQueryData(['probe'])).toBeUndefined();
  });
});
