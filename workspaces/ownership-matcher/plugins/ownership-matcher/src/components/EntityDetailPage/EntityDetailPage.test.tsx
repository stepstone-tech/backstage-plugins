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
import { configApiRef } from '@backstage/core-plugin-api';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { Route, Routes } from 'react-router-dom';
import { usePermission } from '@backstage/plugin-permission-react';
import {
  EntityDetailResponse,
  OwnershipEntity,
  OwnershipHistory,
  OwnershipMatcherApi,
  OwnershipProposal,
  ownershipMatcherApiRef,
} from '../../api';
import { EntityDetailPage } from './EntityDetailPage';
import { PR_POLL_FAST_MS } from '../PrStatus/usePrStatusPolling';
import { QueryProvider } from '../../query/QueryProvider';

// usePermission caches results across renders (SWR), so a real permission API
// mock would leak one test's decision into the next.
jest.mock('@backstage/plugin-permission-react', () => ({
  usePermission: jest.fn(),
}));
const mockUsePermission = usePermission as jest.MockedFunction<
  typeof usePermission
>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntity(over: Partial<OwnershipEntity> = {}): OwnershipEntity {
  return {
    id: 'e-1',
    entity_ref: 'component:default/my-service',
    entity_name: 'my-service',
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: '2026-10-01T00:00:00.000Z',
    last_scanned_at: '2026-10-01T00:00:00.000Z',
    current_status: 'open',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    resolved_at: null,
    resolved_by: null,
    resolution_type: null,
    assigned_to: null,
    pr_status: 'none',
    pr_url: null,
    pr_branch: null,
    pr_attempts: 0,
    pr_last_error: null,
    ...over,
  };
}

function makeProposal(
  over: Partial<OwnershipProposal> = {},
): OwnershipProposal {
  return {
    id: 'p-1',
    entity_id: 'e-1',
    proposed_owner_ref: 'group:default/team-a',
    proposed_owner_type: 'Group',
    confidence_reason: '["top_contributor"]',
    confidence_score: 0.8,
    proposal_order: 1,
    status: 'pending',
    escalation_level: 0,
    notified_at: null,
    responded_at: null,
    response_note: null,
    created_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function historyEntry(
  action: string,
  details: Record<string, unknown>,
  id = action,
): OwnershipHistory {
  return {
    id,
    entity_id: 'e-1',
    proposal_id: null,
    scan_id: null,
    action,
    actor: 'system',
    details: JSON.stringify(details),
    created_at: '2026-10-01T10:00:00.000Z',
  } as OwnershipHistory;
}

function detail(
  over: Partial<EntityDetailResponse> = {},
): EntityDetailResponse {
  return { entity: makeEntity(), proposals: [], history: [], ...over };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

const mockToastApi = { post: jest.fn() };
const mockCatalogApi = {
  getEntities: jest.fn().mockResolvedValue({ items: [] }),
};

function createApi(
  getEntity: jest.Mock,
  extra: Partial<OwnershipMatcherApi> = {},
) {
  return {
    getEntity,
    acceptProposal: jest.fn().mockResolvedValue({
      status: 'accepted',
      proposal: makeProposal({ status: 'accepted' }),
      entity: makeEntity(),
    }),
    rejectProposal: jest.fn(),
    retryPrCreation: jest.fn(),
    ...extra,
  } as unknown as jest.Mocked<OwnershipMatcherApi>;
}

async function renderPage(
  api: jest.Mocked<OwnershipMatcherApi>,
  { teamGroupTypes }: { teamGroupTypes?: string[] } = {},
) {
  const config = teamGroupTypes
    ? { ownershipMatcher: { catalog: { teamGroupTypes } } }
    : {};
  return renderInTestApp(
    <QueryProvider>
      <TestApiProvider
        apis={[
          [configApiRef, mockApis.config({ data: config })],
          [ownershipMatcherApiRef, api],
          [toastApiRef, mockToastApi],
          [catalogApiRef, mockCatalogApi],
        ]}
      >
        <Routes>
          <Route path="/entities/:entityId" element={<EntityDetailPage />} />
        </Routes>
      </TestApiProvider>
    </QueryProvider>,
    { routeEntries: ['/entities/e-1'] },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePermission.mockReturnValue({ loading: false, allowed: false });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('EntityDetailPage — access', () => {
  it('explains who can see the case when the backend returns 403', async () => {
    const getEntity = jest
      .fn()
      .mockRejectedValue(new Error('Request failed: 403 Forbidden — {}'));
    await renderPage(createApi(getEntity));

    expect(
      await screen.findByText(/do not have access to this ownership case/),
    ).toBeTruthy();
  });

  it('shows other errors as-is', async () => {
    const getEntity = jest
      .fn()
      .mockRejectedValue(
        new Error('Request failed: 500 Internal Server Error'),
      );
    await renderPage(createApi(getEntity));

    expect(
      await screen.findByText('Request failed: 500 Internal Server Error'),
    ).toBeTruthy();
  });
});

describe('EntityDetailPage — catalog PR', () => {
  it('shows the Catalog PR row with a link once the PR is raised', async () => {
    const api = createApi(
      jest.fn().mockResolvedValue(
        detail({
          entity: makeEntity({
            current_status: 'accepted',
            pr_status: 'raised',
            pr_url: 'https://repo/pr/1',
          }),
        }),
      ),
    );

    await renderPage(api);

    expect(await screen.findByText('Catalog PR')).not.toBeNull();
    expect(
      screen
        .getByRole('link', { name: /View pull request/i })
        .getAttribute('href'),
    ).toBe('https://repo/pr/1');
  });

  it.each([['none' as const], [undefined]])(
    'hides the Catalog PR row when pr_status is %p',
    async prStatus => {
      const api = createApi(
        jest
          .fn()
          .mockResolvedValue(
            detail({ entity: makeEntity({ pr_status: prStatus }) }),
          ),
      );

      await renderPage(api);

      expect(await screen.findByText('Entity Info')).not.toBeNull();
      expect(screen.queryByText('Catalog PR')).toBeNull();
    },
  );

  it('refreshes while the PR is being raised, keeping the page on screen', async () => {
    const getEntity = jest
      .fn()
      .mockResolvedValueOnce(
        detail({
          entity: makeEntity({
            current_status: 'accepted',
            pr_status: 'pending',
          }),
        }),
      )
      .mockResolvedValue(
        detail({
          entity: makeEntity({
            current_status: 'accepted',
            pr_status: 'raised',
            pr_url: 'https://repo/pr/2',
          }),
        }),
      );
    const api = createApi(getEntity);

    await renderPage(api);

    expect(
      await screen.findByText(/Raising catalog-info pull request/i),
    ).not.toBeNull();
    const link = await screen.findByRole(
      'link',
      { name: /View pull request/i },
      { timeout: PR_POLL_FAST_MS + 2000 },
    );
    expect(link.getAttribute('href')).toBe('https://repo/pr/2');
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(getEntity).toHaveBeenCalledTimes(2);
  }, 10_000);

  // The payload is deeply equal across polls, so react-query's structural
  // sharing hands back the *same* `data` reference and isLoading never flips.
  // If the page passes isLoading rather than isFetching to usePrStatusPolling,
  // the effect stops re-arming and polling dies after the first attempt.
  it('keeps polling while the PR stays pending across several refreshes', async () => {
    const pendingDetail = () =>
      detail({
        entity: makeEntity({
          current_status: 'accepted',
          pr_status: 'pending',
        }),
      });
    // Deliberately not instant: react-query sets isFetching true and then
    // false, and an immediately-resolved promise lets React batch both into a
    // single commit, so the page never observes the flag change. A real fetch
    // always spans a render; this models that.
    const slow = (v: unknown) => () =>
      new Promise(r => setTimeout(() => r(v), 50));
    const getEntity = jest
      .fn()
      .mockImplementationOnce(slow(pendingDetail()))
      .mockImplementationOnce(slow(pendingDetail()))
      .mockImplementationOnce(slow(pendingDetail()))
      .mockResolvedValue(
        detail({
          entity: makeEntity({
            current_status: 'accepted',
            pr_status: 'raised',
            pr_url: 'https://repo/pr/9',
          }),
        }),
      );
    const api = createApi(getEntity);

    await renderPage(api);

    expect(
      await screen.findByText(/Raising catalog-info pull request/i),
    ).not.toBeNull();

    const link = await screen.findByRole(
      'link',
      { name: /View pull request/i },
      { timeout: PR_POLL_FAST_MS * 6 },
    );
    expect(link.getAttribute('href')).toBe('https://repo/pr/9');
    // Three pending responses before the raised one: polling survived them.
    expect(getEntity.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('retrying a failed PR calls the API and refreshes', async () => {
    const getEntity = jest.fn().mockResolvedValue(
      detail({
        entity: makeEntity({
          current_status: 'accepted',
          pr_status: 'failed',
          pr_last_error: 'boom',
        }),
      }),
    );
    const api = createApi(getEntity, {
      retryPrCreation: jest.fn().mockResolvedValue({ entity: makeEntity() }),
    });

    await renderPage(api);

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /Retry/i }));
    });

    expect(api.retryPrCreation).toHaveBeenCalledWith('e-1');
    await waitFor(() => expect(getEntity).toHaveBeenCalledTimes(2));
  });
});

describe('EntityDetailPage — accept feedback', () => {
  const withPending = () => detail({ proposals: [makeProposal()] });

  it('posts a success toast that a PR is being raised', async () => {
    const api = createApi(jest.fn().mockResolvedValue(withPending()));

    await renderPage(api);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^Accept$/ }));
    });

    expect(api.acceptProposal).toHaveBeenCalledWith('p-1');
    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'success',
        title: expect.stringMatching(/pull request/i),
      }),
    );
  });

  it.each([
    [new Error('Request failed: 409 Conflict'), /409 Conflict/],
    ['plain string failure', /plain string failure/],
  ])('reports a failed accept (%#)', async (failure, message) => {
    const api = createApi(jest.fn().mockResolvedValue(withPending()), {
      acceptProposal: jest.fn().mockRejectedValue(failure),
    });

    await renderPage(api);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: /^Accept$/ }));
    });

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'danger',
        title: expect.stringMatching(message),
      }),
    );
  });
});

describe('EntityDetailPage — PR history entries', () => {
  it.each([
    ['pr_creation_enqueued', 'PR Requested', {}, null],
    [
      'pr_raised',
      'PR Raised',
      { prUrl: 'https://repo/pr/1' },
      'https://repo/pr/1',
    ],
    ['pr_reused', 'PR Updated', {}, null],
    [
      'pr_creation_failed',
      'PR Failed',
      { attempt: 2, reason: 'HTTP 503' },
      'Attempt 2: HTTP 503',
    ],
    [
      'pr_creation_failed',
      'PR Failed',
      { reason: 'boom', nextRetryAt: '2026-10-01T10:05:00.000Z' },
      /Attempt \?: boom, retry at /,
    ],
    ['pr_creation_failed', 'PR Failed', {}, 'Attempt ?: unknown error'],
    [
      'pr_creation_skipped',
      'PR Skipped',
      { reason: 'already_up_to_date' },
      'catalog-info.yaml already has this owner',
    ],
    [
      'pr_creation_skipped',
      'PR Skipped',
      { reason: 'entity_open' },
      'entity_open',
    ],
    ['pr_creation_skipped', 'PR Skipped', {}, '—'],
    ['pr_retry_requested', 'PR Retry', {}, null],
    [
      'pr_completed',
      'PR Completed',
      { acceptedOwner: 'group:default/team-new' },
      'Catalog owner is now team-new',
    ],
    ['pr_completed', 'PR Completed', {}, 'Catalog owner updated'],
    [
      'pr_superseded',
      'PR Superseded',
      { catalogOwner: 'team-x' },
      'Owner changed to team-x outside this case',
    ],
    ['pr_superseded', 'PR Superseded', {}, 'Owner changed outside this case'],
    ['pr_declined', 'PR Declined', {}, 'Pull request declined'],
    [
      'pr_declined',
      'PR Declined',
      { reason: 'pr_not_found' },
      'Pull request not found (deleted, or the repository moved)',
    ],
    [
      'pr_not_applied',
      'PR Not Applied',
      { catalogOwner: 'team-old' },
      'Merged, but the catalog still shows owner team-old',
    ],
    [
      'pr_not_applied',
      'PR Not Applied',
      {},
      'Merged, but the catalog still shows owner none',
    ],
  ] as const)('%s renders as "%s"', async (action, label, details, text) => {
    const api = createApi(
      jest
        .fn()
        .mockResolvedValue(
          detail({ history: [historyEntry(action, details)] }),
        ),
    );

    await renderPage(api);

    expect(await screen.findByText(label)).not.toBeNull();
    // `null` = the action renders no detail text; only the label is checked.
    expect(text === null || screen.getByText(text) !== null).toBe(true);
  });
});

describe('EntityDetailPage — unresolved self-heal history', () => {
  it('explains why and with which candidates the case left unresolved', async () => {
    const entry = historyEntry('reopened_candidates_found', {
      previousReason: 'escalation_exhausted',
      previousReasonDetail: 'all_escalation_paths',
      previousReasonAt: '2026-09-01T06:00:00.000Z',
      candidates: [
        {
          ownerRef: 'group:default/team-a',
          score: 0.24,
          status: 'possible_owner',
        },
        { ownerRef: 'group:default/team-b', score: 0.7, status: 'pending' },
      ],
    });
    const api = createApi(
      jest.fn().mockResolvedValue(detail({ history: [entry] })),
    );

    await renderPage(api);

    expect(
      await screen.findByText('Reopened, Candidates Found'),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /^Left unresolved: Escalation exhausted \(since .+\)\. Candidates found: team-a \(0\.24, possible owner\), team-b \(0\.70, proposal\)$/,
      ),
    ).not.toBeNull();
  });
});

describe('EntityDetailPage — escalation actions', () => {
  function apiFor(status: OwnershipEntity['current_status']) {
    return createApi(
      jest
        .fn()
        .mockResolvedValue(
          detail({ entity: makeEntity({ current_status: status }) }),
        ),
    );
  }

  it.each([[false], [true]])(
    'shows actions for escalated entities (admin=%p)',
    async isAdmin => {
      mockUsePermission.mockReturnValue({ loading: false, allowed: isAdmin });

      await renderPage(apiFor('escalated'));

      expect(await screen.findByText('Escalation Actions')).not.toBeNull();
    },
  );

  it.each([
    ['the default team type', undefined, ['team']],
    ['the configured team types', ['team', 'squad'], ['team', 'squad']],
  ])('offers owner groups of %s', async (_, teamGroupTypes, expected) => {
    await renderPage(apiFor('escalated'), { teamGroupTypes });

    await screen.findByText('Escalation Actions');
    await waitFor(() =>
      expect(mockCatalogApi.getEntities).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { kind: 'Group', 'spec.type': expected },
        }),
      ),
    );
  });

  it('shows actions for unresolved entities to admins', async () => {
    mockUsePermission.mockReturnValue({ loading: false, allowed: true });

    await renderPage(apiFor('unresolved'));

    expect(await screen.findByText('Unresolved Case Actions')).not.toBeNull();
  });

  it('hides actions for unresolved entities from non-admins', async () => {
    await renderPage(apiFor('unresolved'));

    expect(await screen.findByText('Entity Info')).not.toBeNull();
    expect(screen.queryByText(/Case Actions|Escalation Actions/)).toBeNull();
  });

  it.each([['open' as const], ['accepted' as const], ['to_archive' as const]])(
    'hides actions for %p entities even for admins',
    async status => {
      mockUsePermission.mockReturnValue({ loading: false, allowed: true });

      await renderPage(apiFor(status));

      expect(await screen.findByText('Entity Info')).not.toBeNull();
      expect(screen.queryByText(/Case Actions|Escalation Actions/)).toBeNull();
    },
  );
});
