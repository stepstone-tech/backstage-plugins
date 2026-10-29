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

import { ConfigReader } from '@backstage/config';
import { mockServices } from '@backstage/backend-test-utils';
import {
  isManagerChainAvailable,
  readCatalogConventions,
  warnIfManagerChainUnavailable,
} from './catalogConventions';
import { EscalationConfig } from './types';

describe('readCatalogConventions', () => {
  it('applies defaults when ownershipMatcher.catalog is absent', () => {
    expect(readCatalogConventions(new ConfigReader({}))).toEqual({
      userAliasAnnotation: undefined,
      managerAnnotation: undefined,
      teamGroupTypes: ['team'],
    });
  });

  it('reads configured values', () => {
    const config = new ConfigReader({
      ownershipMatcher: {
        catalog: {
          annotations: {
            userAlias: 'example.com/alias',
            manager: 'example.com/manager-alias',
          },
          teamGroupTypes: ['team', 'squad'],
        },
      },
    });
    expect(readCatalogConventions(config)).toEqual({
      userAliasAnnotation: 'example.com/alias',
      managerAnnotation: 'example.com/manager-alias',
      teamGroupTypes: ['team', 'squad'],
    });
  });

  it('rejects an empty teamGroupTypes list', () => {
    const config = new ConfigReader({
      ownershipMatcher: { catalog: { teamGroupTypes: [] } },
    });
    expect(() => readCatalogConventions(config)).toThrow(/teamGroupTypes/);
  });
});

describe('isManagerChainAvailable', () => {
  it.each([
    [{}, false],
    [{ userAliasAnnotation: 'a' }, false],
    [{ managerAnnotation: 'm' }, false],
    [{ userAliasAnnotation: 'a', managerAnnotation: 'm' }, true],
  ])('%j → %s', (annotations, expected) => {
    expect(
      isManagerChainAvailable({ ...annotations, teamGroupTypes: ['team'] }),
    ).toBe(expected);
  });
});

describe('warnIfManagerChainUnavailable', () => {
  const level = {
    groupFilter: 'Group:domain',
    timeoutDays: 7,
    titlePatterns: ['Director'],
  };
  const withManagerChain: EscalationConfig = {
    levels: [level, { ...level, managerChain: true }],
  };
  const withoutManagerChain: EscalationConfig = { levels: [level] };

  it('warns when a level uses managerChain and the annotations are missing', () => {
    const logger = mockServices.logger.mock();
    warnIfManagerChainUnavailable(
      withManagerChain,
      { teamGroupTypes: ['team'] },
      logger,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Manager-chain escalation is disabled/),
    );
  });

  it('stays silent when the annotations are configured', () => {
    const logger = mockServices.logger.mock();
    warnIfManagerChainUnavailable(
      withManagerChain,
      {
        userAliasAnnotation: 'a',
        managerAnnotation: 'm',
        teamGroupTypes: ['team'],
      },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['no level uses managerChain', withoutManagerChain],
    ['escalation is not configured', undefined],
  ])('stays silent when %s', (_, escalation) => {
    const logger = mockServices.logger.mock();
    warnIfManagerChainUnavailable(
      escalation,
      { teamGroupTypes: ['team'] },
      logger,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
