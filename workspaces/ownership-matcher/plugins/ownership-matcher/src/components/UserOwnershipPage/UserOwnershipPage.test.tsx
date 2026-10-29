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

import {
  mockApis,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { configApiRef, identityApiRef } from '@backstage/core-plugin-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  ownershipMatcherApiRef,
  OwnershipMatcherApi,
  OwnershipEntity,
  TeamProposalItem,
} from '../../api';
import {
  TEAM_REF,
  makeEntity,
  makeProposal,
  possibleOwnerItem,
  createMockApi,
  mockIdentityApi,
  mockCatalogApi,
} from '../../__testUtils__/fixtures';
import type { StatusedFetch } from '../../__testUtils__/fixtures';
import { UserOwnershipPage } from './UserOwnershipPage';
import { rootRouteRef } from '../../routes';
import { QueryProvider } from '../../query/QueryProvider';

// usePermission caches results across renders (SWR), so a real permission API
// mock would leak one test's decision into the next.
jest.mock('@backstage/plugin-permission-react', () => ({
  usePermission: jest.fn(),
}));
const mockUsePermission = usePermission as jest.MockedFunction<
  typeof usePermission
>;

const mockToastApi = { post: jest.fn() };

async function renderPage(
  api: jest.Mocked<OwnershipMatcherApi>,
  {
    isAdmin = false,
    teamGroupTypes,
  }: { isAdmin?: boolean; teamGroupTypes?: string[] } = {},
) {
  mockUsePermission.mockReturnValue({ loading: false, allowed: isAdmin });
  const config = teamGroupTypes
    ? { ownershipMatcher: { catalog: { teamGroupTypes } } }
    : {};
  return renderInTestApp(
    <QueryProvider>
      <TestApiProvider
        apis={[
          [configApiRef, mockApis.config({ data: config })],
          [ownershipMatcherApiRef, api],
          [identityApiRef, mockIdentityApi],
          [catalogApiRef, mockCatalogApi],
          [toastApiRef, mockToastApi],
        ]}
      >
        <UserOwnershipPage />
      </TestApiProvider>
    </QueryProvider>,
    // Entity detail links are absolute, built from the admin page's route ref.
    { mountedRoutes: { '/ownership-matcher': rootRouteRef } },
  );
}

/** Route the for-team mock by status, defaulting both lists to empty. */
function routedForTeam(opts: {
  pending?: TeamProposalItem[];
  possible?: TeamProposalItem[];
  history?: TeamProposalItem[];
}): StatusedFetch {
  return async (_refs, statuses) => {
    const s = statuses ?? ['pending'];
    if (s.includes('possible_owner')) return { items: opts.possible ?? [] };
    if (s.includes('accepted') || s.includes('rejected'))
      return { items: opts.history ?? [] };
    return { items: opts.pending ?? [] };
  };
}

beforeEach(() => jest.clearAllMocks());

describe('<UserOwnershipPage /> — Possible Owners', () => {
  it('hides the section entirely when there are no possible owners', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [], possible: [] }),
    });

    await renderPage(api);

    await screen.findByText(/No pending proposals/i);
    await act(async () => {});
    expect(screen.queryByText('Possible owners')).toBeNull();
  });

  it('renders an entry with entity name and reason, but no confidence score', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({ possible: [possibleOwnerItem()] }),
    });

    await renderPage(api);

    expect(await screen.findByText('Possible owners')).not.toBeNull();
    expect(screen.getByText('my-service')).not.toBeNull();
    expect(
      screen.getByText('Top contributor by commit history'),
    ).not.toBeNull();
    // Confidence score must not be surfaced to users.
    expect(screen.queryByText('82%')).toBeNull();
  });

  it('claiming calls acceptProposal, then opens the decision in the History tab', async () => {
    const accept = jest.fn().mockResolvedValue({ status: 'accepted' });
    const claimed = possibleOwnerItem({ status: 'accepted' });
    const api = createMockApi({
      forTeam: routedForTeam({
        possible: [possibleOwnerItem()],
        history: [claimed],
      }),
      accept,
    });

    await renderPage(api);

    fireEvent.click(await screen.findByText('my-service'));

    const claimBtn = await screen.findByRole('button', {
      name: /Claim ownership/i,
    });
    await act(async () => {
      fireEvent.click(claimBtn);
    });

    expect(accept).toHaveBeenCalledWith('prop-1');
    // History tab is selected and its list (accepted + rejected) is fetched.
    await waitFor(() =>
      expect(
        screen.getByRole('tab', {
          name: 'History',
          selected: true,
          hidden: true,
        }),
      ).not.toBeNull(),
    );
    const statusArgs = api.listProposalsForTeam.mock.calls.map(c => c[1]);
    expect(statusArgs).toContainEqual(['accepted', 'rejected']);
  });

  it('confirms that a catalog-info PR is being raised after a successful claim', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({ possible: [possibleOwnerItem()] }),
    });

    await renderPage(api);

    fireEvent.click(await screen.findByText('my-service'));
    const claimBtn = await screen.findByRole('button', {
      name: /Claim ownership/i,
    });
    await act(async () => {
      fireEvent.click(claimBtn);
    });

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        title: expect.stringMatching(/pull request .* is being raised/i),
      }),
    );
  });

  it('surfaces an error in the drawer when the claim fails', async () => {
    const accept = jest
      .fn()
      .mockRejectedValue(new Error('Request failed: 409 Conflict'));
    const api = createMockApi({
      forTeam: routedForTeam({ possible: [possibleOwnerItem()] }),
      accept,
    });

    await renderPage(api);

    fireEvent.click(await screen.findByText('my-service'));
    const claimBtn = await screen.findByRole('button', {
      name: /Claim ownership/i,
    });
    await act(async () => {
      fireEvent.click(claimBtn);
    });

    expect(accept).toHaveBeenCalledWith('prop-1');
    // The drawer stays open and the failure is shown to the user.
    expect(
      await screen.findByText(/Failed to claim ownership: .*409/i),
    ).not.toBeNull();
  });

  it('shows the "done" pending state above the possible owners section', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [], possible: [possibleOwnerItem()] }),
    });

    await renderPage(api);

    expect(await screen.findByText(/No pending proposals/i)).not.toBeNull();
    expect(screen.getByText('Possible owners')).not.toBeNull();
  });

  it('opens a claim-only drawer (no reject path) for a possible owner', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({ possible: [possibleOwnerItem()] }),
    });

    await renderPage(api);

    fireEvent.click(await screen.findByText('my-service'));

    // The possible-owner drawer offers Claim only — it must not surface the
    // pending drawer's Accept/Reject controls.
    expect(
      await screen.findByRole('button', { name: /Claim ownership/i }),
    ).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: /Reject proposal/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: /Accept ownership/i }),
    ).toBeNull();
  });
});

// ─── Helpers: pending → accept → History / PR status ───────────────

function pendingItem(): TeamProposalItem {
  return {
    proposal: makeProposal({ status: 'pending' }),
    entity: makeEntity(),
    actor: null,
  };
}

function acceptedItem(entity: Partial<OwnershipEntity>): TeamProposalItem {
  return {
    proposal: makeProposal({ status: 'accepted' }),
    entity: makeEntity({ current_status: 'accepted', ...entity }),
    actor: null,
  };
}

/** Render the page, open the pending proposal's drawer and click "Accept ownership". */
async function acceptFromPending(api: jest.Mocked<OwnershipMatcherApi>) {
  await renderPage(api);
  fireEvent.click(await screen.findByText('my-service'));
  const acceptBtn = await screen.findByRole('button', {
    name: /Accept ownership/i,
  });
  await act(async () => {
    fireEvent.click(acceptBtn);
  });
}

/** Render the page, switch to History and open the accepted decision's drawer. */
async function openHistoryDecision(entity: Partial<OwnershipEntity>) {
  const api = createMockApi({
    forTeam: routedForTeam({
      history: [acceptedItem({ repo_url: 'https://repo/browse', ...entity })],
    }),
  });
  await renderPage(api);
  fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
  fireEvent.click(await screen.findByText('my-service'));
}

/** Render the page on the History tab with the given decisions loaded. */
async function renderHistory(items: TeamProposalItem[]) {
  const api = createMockApi({ forTeam: routedForTeam({ history: items }) });
  await renderPage(api);
  fireEvent.click(await screen.findByRole('tab', { name: 'History' }));
  await screen.findByText('my-service');
}

describe('UserOwnershipPage — pending accept & PR status', () => {
  it('accepting a pending proposal posts a success alert about the PR', async () => {
    const accept = jest.fn().mockResolvedValue({ status: 'accepted' });
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [pendingItem()] }),
      accept,
    });

    await acceptFromPending(api);

    expect(accept).toHaveBeenCalledWith('prop-1');
    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        title: expect.stringMatching(/pull request/i),
      }),
    );
  });

  it('a failed accept is reported instead of silently swallowed', async () => {
    const accept = jest
      .fn()
      .mockRejectedValue(new Error('Request failed: 403 Forbidden'));
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [pendingItem()] }),
      accept,
    });

    await acceptFromPending(api);

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'danger',
        title: expect.stringContaining('403'),
      }),
    );
  });
});

describe('UserOwnershipPage — after accept, show the PR in History', () => {
  it('switches to History with the decision open, showing a "View pull request" link', async () => {
    const api = createMockApi({
      forTeam: routedForTeam({
        pending: [pendingItem()],
        history: [
          acceptedItem({ pr_status: 'raised', pr_url: 'https://repo/pr/42' }),
        ],
      }),
    });

    await acceptFromPending(api);

    expect(
      screen.getByRole('tab', {
        name: 'History',
        selected: true,
        hidden: true,
      }),
    ).not.toBeNull();
    const link = await screen.findByRole('link', {
      name: /View pull request/i,
    });
    expect(link.getAttribute('href')).toBe('https://repo/pr/42');
  });

  it('polls while the PR is still being raised, then shows the link', async () => {
    let historyCalls = 0;
    const api = createMockApi({
      forTeam: async (_refs, statuses) => {
        const s = statuses ?? ['pending'];
        if (s.includes('accepted')) {
          historyCalls += 1;
          return {
            items: [
              historyCalls === 1
                ? acceptedItem({ pr_status: 'pending' })
                : acceptedItem({
                    pr_status: 'raised',
                    pr_url: 'https://repo/pr/7',
                  }),
            ],
          };
        }
        if (s.includes('possible_owner')) return { items: [] };
        return { items: [pendingItem()] };
      },
    });

    await acceptFromPending(api);

    expect(
      await screen.findByText(/Raising catalog-info pull request/i),
    ).not.toBeNull();
    const link = await screen.findByRole(
      'link',
      { name: /View pull request/i },
      { timeout: 5000 },
    );
    expect(link.getAttribute('href')).toBe('https://repo/pr/7');
  }, 10_000);

  it('stays on Pending when the accept fails', async () => {
    const accept = jest
      .fn()
      .mockRejectedValue(new Error('Request failed: 409 Conflict'));
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [pendingItem()] }),
      accept,
    });

    await acceptFromPending(api);

    expect(
      screen.getByRole('tab', {
        name: 'Pending',
        selected: true,
        hidden: true,
      }),
    ).not.toBeNull();
  });
});

// ─── Leadership tab gating ───────────────────────────────────────────────────

const CHAPTER_REF = 'group:default/chapter-platform';

const LEADER_STATS = {
  isLeader: true,
  totalOpen: 0,
  perCheck: {},
  pendingProposals: 0,
  totalProposals: 0,
  avgConfidence: null,
};

function leaderApi(isLeader: boolean): jest.Mocked<OwnershipMatcherApi> {
  const api = createMockApi({ forTeam: routedForTeam({}) });
  api.getLeadershipStats.mockResolvedValue({
    ...LEADER_STATS,
    isLeader,
  } as any);
  api.listAllLeadershipProposals.mockResolvedValue({ items: [] } as any);
  api.listLeadershipEntities.mockResolvedValue({ items: [] } as any);
  return api;
}

/** Give the current user `refs` as their groups, with catalog types `types` (aligned by index). */
function givenGroups(refs: string[], types: string[]) {
  mockIdentityApi.getBackstageIdentity.mockResolvedValueOnce({
    userEntityRef: 'user:default/mock',
    ownershipEntityRefs: ['user:default/mock', ...refs],
    type: 'user',
  });
  // The page skips the catalog lookup when there are no group refs; queueing a
  // once-value anyway would leak into the next test (clearAllMocks keeps it).
  if (refs.length === 0) return;
  mockCatalogApi.getEntitiesByRefs.mockResolvedValueOnce({
    items: types.map(type => ({ kind: 'Group', spec: { type } })),
  });
}

function tabLabels(): string[] {
  return screen
    .queryAllByRole('tab', { hidden: true })
    .map(t => t.textContent ?? '');
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('UserOwnershipPage — Escalations tab', () => {
  it('links each escalation to the entity detail page, not a relative path', async () => {
    givenGroups([CHAPTER_REF], ['chapter']);
    const api = leaderApi(true);
    api.listLeadershipEntities.mockResolvedValue({
      items: [makeEntity({ id: 'e-42', current_status: 'escalated' })],
    } as any);

    await renderPage(api);
    fireEvent.click(
      await screen.findByRole('tab', { name: 'Escalations', hidden: true }),
    );

    const view = await screen.findByRole('link', { name: 'View' });
    expect(view.getAttribute('href')).toBe('/ownership-matcher/entities/e-42');
  });
});

describe('UserOwnershipPage — leadership tab gating', () => {
  it('shows only My Teams / Escalations to a leader whose groups are all non-team', async () => {
    givenGroups([CHAPTER_REF], ['chapter']);
    const api = leaderApi(true);

    await renderPage(api);

    await screen.findByRole('tab', {
      name: 'My Teams',
      selected: true,
      hidden: true,
    });
    expect(tabLabels()).toEqual(['My Teams', 'Escalations']);
    expect(screen.queryByText(/not a member of any/i)).toBeNull();
    expect(screen.queryByText(/aren't a member of any team/i)).toBeNull();
    expect(api.listProposalsForTeam).not.toHaveBeenCalled();
    expect(api.listAllLeadershipProposals).toHaveBeenCalled();
  });

  it('shows all four tabs to a leader with a team group, defaulting to Pending', async () => {
    givenGroups([TEAM_REF], ['team']);
    const api = leaderApi(true);

    await renderPage(api);

    await screen.findByRole('tab', {
      name: 'Pending',
      selected: true,
      hidden: true,
    });
    expect(tabLabels()).toEqual([
      'Pending',
      'History',
      'My Teams',
      'Escalations',
    ]);
    await screen.findByText(/No pending proposals/i);
  });

  it('treats groups of a configured teamGroupTypes value as teams', async () => {
    givenGroups([CHAPTER_REF], ['chapter']);
    const api = leaderApi(true);

    await renderPage(api, { teamGroupTypes: ['team', 'chapter'] });

    await screen.findByRole('tab', {
      name: 'Pending',
      selected: true,
      hidden: true,
    });
    expect(tabLabels()).toEqual([
      'Pending',
      'History',
      'My Teams',
      'Escalations',
    ]);
  });

  it('shows the team-specific empty state to a non-leader with only non-team groups', async () => {
    givenGroups([CHAPTER_REF], ['chapter']);

    await renderPage(leaderApi(false));

    expect(
      await screen.findByText(/aren't a member of any team in the catalog/i),
    ).not.toBeNull();
    expect(tabLabels()).toEqual([]);
  });

  it('shows the no-groups empty state to a non-leader with no groups at all', async () => {
    givenGroups([], []);

    await renderPage(leaderApi(false));

    expect(
      await screen.findByText(
        /You are not a member of any groups in the catalog/i,
      ),
    ).not.toBeNull();
    expect(tabLabels()).toEqual([]);
  });

  it.each([
    ['leadership stats first', true],
    ['groups first', false],
  ])(
    'keeps the loading state until both resolve (%s)',
    async (_label, statsFirst) => {
      mockIdentityApi.getBackstageIdentity.mockResolvedValueOnce({
        userEntityRef: 'user:default/mock',
        ownershipEntityRefs: [CHAPTER_REF],
        type: 'user',
      });
      const groupsDeferred = deferred<{ items: any[] }>();
      mockCatalogApi.getEntitiesByRefs.mockReturnValueOnce(
        groupsDeferred.promise,
      );
      const statsDeferred = deferred<any>();
      const api = leaderApi(true);
      api.getLeadershipStats.mockReturnValue(statsDeferred.promise);

      await renderPage(api);
      expect(screen.getByText('Loading your teams...')).not.toBeNull();

      const resolveStats = () => statsDeferred.resolve(LEADER_STATS);
      const resolveGroups = () =>
        groupsDeferred.resolve({
          items: [{ kind: 'Group', spec: { type: 'chapter' } }],
        });

      await act(async () => (statsFirst ? resolveStats() : resolveGroups()));
      expect(screen.getByText('Loading your teams...')).not.toBeNull();
      expect(screen.queryByText(/member of any/i)).toBeNull();
      expect(tabLabels()).toEqual([]);

      await act(async () => (statsFirst ? resolveGroups() : resolveStats()));
      await screen.findByRole('tab', {
        name: 'My Teams',
        selected: true,
        hidden: true,
      });
      expect(tabLabels()).toEqual(['My Teams', 'Escalations']);
      expect(screen.queryByText(/member of any/i)).toBeNull();
    },
  );
});

describe('UserOwnershipPage — History drawer PR status & manual fallback', () => {
  it.each([
    ['no PR tracked (older acceptance)', { pr_status: undefined }],
    ['no PR raised', { pr_status: 'none' as const }],
    ['PR failed', { pr_status: 'failed' as const, pr_last_error: 'boom' }],
    [
      'PR declined',
      {
        pr_status: 'declined' as const,
        pr_last_error: 'The pull request was declined',
      },
    ],
    [
      'PR not supported',
      { pr_status: 'unsupported_scm' as const, pr_last_error: 'no provider' },
    ],
  ])('offers the manual repository link when %s', async (_label, entity) => {
    await openHistoryDecision(entity);
    expect(
      await screen.findByText('Update ownership in repository'),
    ).not.toBeNull();
  });

  it('hides the manual link while the automated PR is pending or raised', async () => {
    await openHistoryDecision({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/1',
    });
    expect(
      await screen.findByRole('link', { name: /View pull request/i }),
    ).not.toBeNull();
    expect(screen.queryByText('Update ownership in repository')).toBeNull();
  });

  it.each([
    [
      'completed',
      { pr_status: 'completed' as const, pr_url: 'https://repo/pr/1' },
    ],
    [
      'superseded',
      { pr_status: 'superseded' as const, pr_url: 'https://repo/pr/1' },
    ],
  ])(
    'hides the manual link once the PR outcome is %s',
    async (_label, entity) => {
      await openHistoryDecision(entity);
      expect(
        await screen.findByRole('link', { name: /View pull request/i }),
      ).not.toBeNull();
      expect(screen.queryByText('Update ownership in repository')).toBeNull();
    },
  );

  it('a non-Error accept failure is reported too', async () => {
    const accept = jest.fn().mockRejectedValue('gateway timeout');
    const api = createMockApi({
      forTeam: routedForTeam({ pending: [pendingItem()] }),
      accept,
    });

    await acceptFromPending(api);

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'danger',
        title: expect.stringContaining('gateway timeout'),
      }),
    );
  });
});

describe('UserOwnershipPage — History card warns when the PR failed', () => {
  it('shows a warning (with the reason as tooltip) on an accepted card whose PR failed', async () => {
    await renderHistory([
      acceptedItem({
        pr_status: 'failed',
        pr_last_error: 'catalog-info.yaml not found',
      }),
    ]);

    const warning = screen.getByText(/Catalog-info pull request failed/i);
    expect(warning).not.toBeNull();
    expect(warning.closest('[title]')?.getAttribute('title')).toBe(
      'catalog-info.yaml not found',
    );
  });

  it.each([
    ['declined', 'Catalog-info pull request declined'],
    ['unsupported_scm', 'Catalog-info pull request not supported'],
  ] as const)(
    'shows a warning on an accepted card whose PR is %s',
    async (prStatus, label) => {
      await renderHistory([
        acceptedItem({ pr_status: prStatus, pr_last_error: 'why' }),
      ]);

      const warning = screen.getByText(label);
      expect(warning.closest('[title]')?.getAttribute('title')).toBe('why');
    },
  );

  it.each([
    [
      'raised',
      acceptedItem({ pr_status: 'raised', pr_url: 'https://repo/pr/1' }),
    ],
    ['pending', acceptedItem({ pr_status: 'pending' })],
    [
      'completed',
      acceptedItem({ pr_status: 'completed', pr_url: 'https://repo/pr/1' }),
    ],
    [
      'superseded',
      acceptedItem({ pr_status: 'superseded', pr_url: 'https://repo/pr/1' }),
    ],
    [
      'rejected decisions',
      {
        ...acceptedItem({ pr_status: 'failed' }),
        proposal: makeProposal({ status: 'rejected' }),
      },
    ],
  ])('shows no warning for %s', async (_label, item) => {
    await renderHistory([item]);

    expect(
      screen.queryByText(
        /Catalog-info pull request (failed|declined|not supported)/i,
      ),
    ).toBeNull();
  });

  it.each(['failed', 'declined'] as const)(
    'clicking a card whose PR is %s opens the drawer with Retry',
    async prStatus => {
      await renderHistory([
        acceptedItem({ pr_status: prStatus, pr_last_error: 'boom' }),
      ]);

      fireEvent.click(screen.getByText('my-service'));

      expect(
        await screen.findByRole('button', { name: /Retry/i }),
      ).not.toBeNull();
    },
  );
});

// ─── Admin tab gating ────────────────────────────────────────────────────────

describe('UserOwnershipPage — Admin tab gating', () => {
  function adminApi(): jest.Mocked<OwnershipMatcherApi> {
    const api = leaderApi(false);
    api.getDashboardStats.mockResolvedValue({
      totalOpen: 0,
      perCheck: {},
      pendingProposals: 0,
    } as any);
    api.listAllProposalsPaginated.mockResolvedValue({
      items: [],
      total: 0,
    } as any);
    return api;
  }

  it('hides the Admin tab from users without the admin permission', async () => {
    givenGroups([TEAM_REF], ['team']);

    await renderPage(leaderApi(false));

    await screen.findByRole('tab', {
      name: 'Pending',
      selected: true,
      hidden: true,
    });
    expect(tabLabels()).toEqual(['Pending', 'History']);
  });

  it('appends the Admin tab for admins', async () => {
    givenGroups([TEAM_REF], ['team']);

    await renderPage(adminApi(), { isAdmin: true });

    await screen.findByRole('tab', {
      name: 'Pending',
      selected: true,
      hidden: true,
    });
    expect(tabLabels()).toEqual(['Pending', 'History', 'Admin']);
  });

  it('shows the admin dashboard to an admin with no teams instead of the empty state', async () => {
    givenGroups([], []);
    const api = adminApi();

    await renderPage(api, { isAdmin: true });

    await screen.findByRole('tab', {
      name: 'Admin',
      selected: true,
      hidden: true,
    });
    expect(screen.queryByText(/not a member of any/i)).toBeNull();
    expect(
      screen.getByRole('tab', { name: 'Dashboard', hidden: true }),
    ).not.toBeNull();
    await waitFor(() => expect(api.getDashboardStats).toHaveBeenCalled());
  });
});
