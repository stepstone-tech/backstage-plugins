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

import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { errorApiRef, identityApiRef } from '@backstage/core-plugin-api';
import { signalApiRef } from '@backstage/plugin-signals-react';
import { ownershipMatcherApiRef, OwnershipMatcherApi } from '../../api';
import { PendingProposalsBanner } from './PendingProposalsBanner';

type Listener = (msg: unknown) => void;

function createMockSignalApi() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    subscribe: jest.fn((channel: string, onMessage: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(onMessage);
      return {
        unsubscribe: () => {
          set!.delete(onMessage);
        },
      };
    }),
    publish(channel: string, msg: unknown) {
      const set = listeners.get(channel);
      if (!set) return;
      for (const cb of set) cb(msg);
    },
  };
}

function createMockApi(
  impl: () => Promise<{ pendingCount: number; link: string; hash: string }>,
): jest.Mocked<OwnershipMatcherApi> & {
  getMyPendingProposalsSummary: jest.Mock;
} {
  return {
    listEntities: jest.fn(),
    listAllEntities: jest.fn(),
    getEntity: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
    triggerScan: jest.fn(),
    acceptProposal: jest.fn(),
    rejectProposal: jest.fn(),
    escalationAssign: jest.fn(),
    escalationArchive: jest.fn(),
    listProposalsForTeam: jest.fn(),
    getDefinitions: jest.fn(),
    getDashboardStats: jest.fn(),
    listAllProposals: jest.fn(),
    getMyPendingProposalsSummary: jest.fn(impl),
  } as any;
}

const mockIdentityApi = {
  getBackstageIdentity: jest.fn().mockResolvedValue({
    userEntityRef: 'user:default/mock',
    ownershipEntityRefs: ['group:default/team-a'],
    type: 'user',
  }),
  getCredentials: jest.fn().mockResolvedValue({ token: 'tok' }),
  getProfileInfo: jest.fn().mockResolvedValue({}),
  signOut: jest.fn(),
};

const mockErrorApi = { post: jest.fn(), error$: jest.fn() };

async function renderBanner(opts: {
  api: ReturnType<typeof createMockApi>;
  signalApi?: ReturnType<typeof createMockSignalApi> | null;
}) {
  const apis: Array<[any, any]> = [
    [ownershipMatcherApiRef, opts.api],
    [identityApiRef, mockIdentityApi],
    [errorApiRef, mockErrorApi],
  ];
  if (opts.signalApi) apis.push([signalApiRef, opts.signalApi]);

  return renderInTestApp(
    <TestApiProvider apis={apis}>
      <PendingProposalsBanner />
    </TestApiProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  sessionStorage.clear();
});

describe('<PendingProposalsBanner />', () => {
  it('renders no visible alert when pendingCount is 0', async () => {
    const api = createMockApi(async () => ({
      pendingCount: 0,
      link: '/my-ownership-proposals',
      hash: '',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });

    await waitFor(() =>
      expect(api.getMyPendingProposalsSummary).toHaveBeenCalled(),
    );
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders toast text and link when pendingCount > 0', async () => {
    const api = createMockApi(async () => ({
      pendingCount: 3,
      link: '/my-ownership-proposals',
      hash: 'abc123',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Your team has 3 pending proposal(s) to review.',
    );
    const link = alert.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/my-ownership-proposals');
  });

  it('dismiss button hides the toast and writes to sessionStorage', async () => {
    const api = createMockApi(async () => ({
      pendingCount: 2,
      link: '/my-ownership-proposals',
      hash: 'hash-1',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });
    const alert = await screen.findByRole('alert');

    const closeBtn = alert.querySelector('[title="Close"]') as HTMLElement;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn);

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(sessionStorage.getItem('ownership-banner-dismissed:hash-1')).toBe(
      '1',
    );
  });

  it('stays hidden on re-mount when sessionStorage has the same hash', async () => {
    sessionStorage.setItem('ownership-banner-dismissed:hash-1', '1');

    const api = createMockApi(async () => ({
      pendingCount: 2,
      link: '/my-ownership-proposals',
      hash: 'hash-1',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });

    await waitFor(() =>
      expect(api.getMyPendingProposalsSummary).toHaveBeenCalled(),
    );
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('re-shows on re-mount when the hash differs from the dismissed one', async () => {
    sessionStorage.setItem('ownership-banner-dismissed:hash-old', '1');

    const api = createMockApi(async () => ({
      pendingCount: 4,
      link: '/my-ownership-proposals',
      hash: 'hash-new',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('4 pending proposal(s)');
  });

  it('does not crash when sessionStorage.setItem throws', async () => {
    const setItemSpy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceeded');
      });

    const api = createMockApi(async () => ({
      pendingCount: 1,
      link: '/my-ownership-proposals',
      hash: 'hash-z',
    }));

    await renderBanner({ api, signalApi: createMockSignalApi() });
    const alert = await screen.findByRole('alert');

    const closeBtn = alert.querySelector('[title="Close"]') as HTMLElement;
    expect(() => fireEvent.click(closeBtn)).not.toThrow();

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    setItemSpy.mockRestore();
  });

  it('re-fetches when a signal arrives on the notifications channel', async () => {
    const api = createMockApi(async () => ({
      pendingCount: 1,
      link: '/my-ownership-proposals',
      hash: 'h1',
    }));
    const signalApi = createMockSignalApi();

    await renderBanner({ api, signalApi });
    await screen.findByRole('alert');
    expect(api.getMyPendingProposalsSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      signalApi.publish('notifications', { kind: 'new' });
    });

    await waitFor(() =>
      expect(api.getMyPendingProposalsSummary).toHaveBeenCalledTimes(2),
    );
  });

  it('mounts without throwing when signalApiRef is not registered', async () => {
    const api = createMockApi(async () => ({
      pendingCount: 1,
      link: '/my-ownership-proposals',
      hash: 'h1',
    }));

    await renderBanner({ api, signalApi: null });
    await screen.findByRole('alert');
    expect(api.getMyPendingProposalsSummary).toHaveBeenCalled();
  });

  it('refetches once when the 5-minute poll interval elapses', async () => {
    jest.useFakeTimers();
    try {
      const api = createMockApi(async () => ({
        pendingCount: 1,
        link: '/my-ownership-proposals',
        hash: 'h1',
      }));

      await renderBanner({ api, signalApi: createMockSignalApi() });
      await waitFor(() =>
        expect(api.getMyPendingProposalsSummary).toHaveBeenCalledTimes(1),
      );

      await act(async () => {
        jest.advanceTimersByTime(5 * 60 * 1000);
      });

      await waitFor(() =>
        expect(api.getMyPendingProposalsSummary).toHaveBeenCalledTimes(2),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('renders nothing when the endpoint throws (401)', async () => {
    const api = createMockApi(async () => {
      throw new Error('Request failed: 401 Unauthorized');
    });

    await renderBanner({ api, signalApi: createMockSignalApi() });

    await waitFor(() =>
      expect(api.getMyPendingProposalsSummary).toHaveBeenCalled(),
    );
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders nothing when the endpoint returns a 5xx error', async () => {
    const api = createMockApi(async () => {
      throw new Error('Request failed: 503 Service Unavailable');
    });

    await renderBanner({ api, signalApi: createMockSignalApi() });

    await waitFor(() =>
      expect(api.getMyPendingProposalsSummary).toHaveBeenCalled(),
    );
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
