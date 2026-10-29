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

import { queryKeys } from './keys';

describe('queryKeys', () => {
  it('namespaces every key under the plugin id', () => {
    expect(queryKeys.definitions()[0]).toBe('ownership-matcher');
    expect(queryKeys.entities({})[0]).toBe('ownership-matcher');
  });

  it('produces a stable key for the same params', () => {
    expect(queryKeys.entities({ status: 'unresolved', page: 1 })).toEqual(
      queryKeys.entities({ status: 'unresolved', page: 1 }),
    );
  });

  it('produces a different key for different params', () => {
    expect(queryKeys.entities({ page: 1 })).not.toEqual(
      queryKeys.entities({ page: 2 }),
    );
  });

  it('scopes team proposals by team refs and statuses', () => {
    const key = queryKeys.teamProposals(['group:default/a'], ['pending']);
    expect(key).toEqual([
      'ownership-matcher',
      'team-proposals',
      ['group:default/a'],
      ['pending'],
    ]);
  });

  it('scopes entity detail by id', () => {
    expect(queryKeys.entityDetail('e-1')).toEqual([
      'ownership-matcher',
      'entity-detail',
      'e-1',
    ]);
  });
});
