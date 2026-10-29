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

import { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { TestApiProvider } from '@backstage/test-utils';
import { useQuery } from '@tanstack/react-query';
import { ownershipMatcherApiRef, OwnershipMatcherApi } from '../api';
import { QueryProvider } from '../query/QueryProvider';
import { queryKeys } from '../query/keys';
import { useProposalMutations } from './useProposalMutations';

// The point of the react-query migration is that a decision refreshes the
// sibling lists without the pages threading refresh counters through props.
// These use a REAL query client, so deleting an entry from `invalidateAfter`
// fails here — mocking the mutation, as the page tests do, would not.

const ENTITY_ID = 'e-1';

function makeApi(listForTeam: jest.Mock): jest.Mocked<OwnershipMatcherApi> {
  return {
    listProposalsForTeam: listForTeam,
    acceptProposal: jest.fn().mockResolvedValue({
      status: 'accepted',
      proposal: { id: 'prop-1', status: 'accepted' },
      entity: { id: ENTITY_ID },
    }),
    rejectProposal: jest.fn().mockResolvedValue({
      status: 'rejected',
      proposal: { id: 'prop-1', status: 'rejected' },
      entity: { id: ENTITY_ID },
    }),
  } as unknown as jest.Mocked<OwnershipMatcherApi>;
}

/** Mounts a team-proposals query alongside the mutations, sharing one client. */
function setup(api: jest.Mocked<OwnershipMatcherApi>) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryProvider>
      <TestApiProvider apis={[[ownershipMatcherApiRef, api]]}>
        {children}
      </TestApiProvider>
    </QueryProvider>
  );
  return renderHook(
    () => {
      const list = useQuery({
        queryKey: queryKeys.teamProposals(
          ['group:default/team-a'],
          ['pending'],
        ),
        queryFn: () =>
          api.listProposalsForTeam(['group:default/team-a'], ['pending']),
      });
      return { list, ...useProposalMutations() };
    },
    { wrapper },
  );
}

describe('useProposalMutations invalidation', () => {
  it.each([
    ['accept', (m: any) => m.accept.mutateAsync('prop-1')],
    [
      'reject',
      (m: any) => m.reject.mutateAsync({ proposalId: 'prop-1', reason: 'no' }),
    ],
  ])('refetches the team proposals list after %s', async (_label, act) => {
    const listForTeam = jest.fn().mockResolvedValue({ items: [] });
    const api = makeApi(listForTeam);
    const { result } = setup(api);

    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    expect(listForTeam).toHaveBeenCalledTimes(1);

    await act(result.current);

    // The list refetched because the mutation invalidated its family — no
    // refresh counter, no prop threading.
    await waitFor(() => expect(listForTeam).toHaveBeenCalledTimes(2));
  });
});
