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
import { act, fireEvent, screen } from '@testing-library/react';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { OwnershipEntity, ownershipMatcherApiRef } from '../../api';
import { PrStatusIndicator } from './PrStatusIndicator';

function makeEntity(over: Partial<OwnershipEntity> = {}): OwnershipEntity {
  return {
    id: 'entity-1',
    entity_ref: 'component:default/my-service',
    entity_name: 'my-service',
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: '2026-01-01T00:00:00.000Z',
    last_scanned_at: '2026-01-02T00:00:00.000Z',
    current_status: 'accepted',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    resolved_at: null,
    resolved_by: 'user:default/jane',
    resolution_type: 'ownership_changed',
    assigned_to: 'group:default/team-a',
    pr_status: 'none',
    pr_url: null,
    pr_branch: null,
    pr_attempts: 0,
    pr_last_error: null,
    ...over,
  };
}

const mockToastApi = { post: jest.fn() };

async function render(
  entity: OwnershipEntity,
  api: { retryPrCreation: jest.Mock },
  onChanged = jest.fn(),
) {
  await renderInTestApp(
    <TestApiProvider
      apis={[
        [ownershipMatcherApiRef, api as any],
        [toastApiRef, mockToastApi],
      ]}
    >
      <PrStatusIndicator entity={entity} onChanged={onChanged} />
    </TestApiProvider>,
  );
  return onChanged;
}

beforeEach(() => jest.clearAllMocks());

describe('PrStatusIndicator', () => {
  it('shows a pending state while the PR is being raised', async () => {
    await render(makeEntity({ pr_status: 'pending' }), {
      retryPrCreation: jest.fn(),
    });
    expect(
      screen.getByText(/Raising catalog-info pull request/i),
    ).not.toBeNull();
  });

  it('links to the PR once raised', async () => {
    await render(
      makeEntity({ pr_status: 'raised', pr_url: 'https://repo/pr/42' }),
      {
        retryPrCreation: jest.fn(),
      },
    );
    const link = screen.getByRole('link', { name: /View pull request/i });
    expect(link.getAttribute('href')).toBe('https://repo/pr/42');
  });

  it('explains an unsupported repository host and offers a retry', async () => {
    const retryPrCreation = jest
      .fn()
      .mockResolvedValue({ entity: makeEntity({ pr_status: 'pending' }) });
    await render(
      makeEntity({
        pr_status: 'unsupported_scm',
        pr_last_error:
          'No ownership-matcher SCM provider is installed for gitlab (gitlab.com)',
      }),
      { retryPrCreation },
    );

    expect(
      screen.getByText(/not supported for this repository host/i),
    ).not.toBeNull();
    expect(
      screen.getByText(
        /No ownership-matcher SCM provider is installed for gitlab/,
      ),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });
    expect(retryPrCreation).toHaveBeenCalledWith('entity-1');
  });

  it('shows the failure reason and retries via the API', async () => {
    const retryPrCreation = jest
      .fn()
      .mockResolvedValue({ entity: makeEntity({ pr_status: 'pending' }) });
    const onChanged = await render(
      makeEntity({
        pr_status: 'failed',
        pr_last_error: 'catalog-info.yaml not found',
        pr_attempts: 1,
      }),
      { retryPrCreation },
    );

    expect(
      screen.getByText(/catalog-info.yaml not found \(attempt 1\)/),
    ).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });

    expect(retryPrCreation).toHaveBeenCalledWith('entity-1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('reports a failed retry', async () => {
    const retryPrCreation = jest
      .fn()
      .mockRejectedValue(new Error('Request failed: 409'));
    const onChanged = await render(makeEntity({ pr_status: 'failed' }), {
      retryPrCreation,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'danger' }),
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows the failure reason without an attempt count when attempts is 0', async () => {
    await render(
      makeEntity({
        pr_status: 'failed',
        pr_last_error: 'not found',
        pr_attempts: 0,
      }),
      {
        retryPrCreation: jest.fn(),
      },
    );
    expect(screen.getByText('not found')).not.toBeNull();
  });

  it('shows "raised" without a link when the URL is unknown', async () => {
    await render(makeEntity({ pr_status: 'raised', pr_url: null }), {
      retryPrCreation: jest.fn(),
    });
    expect(screen.getByText(/Pull request raised/i)).not.toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('reports a retry failure that is not an Error', async () => {
    const retryPrCreation = jest.fn().mockRejectedValue('offline');
    await render(makeEntity({ pr_status: 'failed' }), { retryPrCreation });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });

    expect(mockToastApi.post).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'danger',
        title: expect.stringContaining('offline'),
      }),
    );
  });

  it('retry works without an onChanged callback', async () => {
    const retryPrCreation = jest
      .fn()
      .mockResolvedValue({ entity: makeEntity() });
    await renderInTestApp(
      <TestApiProvider
        apis={[
          [ownershipMatcherApiRef, { retryPrCreation } as any],
          [toastApiRef, mockToastApi],
        ]}
      >
        <PrStatusIndicator entity={makeEntity({ pr_status: 'failed' })} />
      </TestApiProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });

    expect(retryPrCreation).toHaveBeenCalled();
  });

  it('shows a completed PR with its link and no retry', async () => {
    await render(
      makeEntity({ pr_status: 'completed', pr_url: 'https://repo/pr/42' }),
      {
        retryPrCreation: jest.fn(),
      },
    );
    expect(screen.getByText(/Catalog owner updated/i)).not.toBeNull();
    expect(
      screen
        .getByRole('link', { name: /View pull request/i })
        .getAttribute('href'),
    ).toBe('https://repo/pr/42');
    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
  });

  it('a declined PR offers a retry', async () => {
    const retryPrCreation = jest
      .fn()
      .mockResolvedValue({ entity: makeEntity({ pr_status: 'pending' }) });
    const onChanged = await render(
      makeEntity({
        pr_status: 'declined',
        pr_url: 'https://repo/pr/42',
        pr_last_error: 'The pull request was declined',
      }),
      { retryPrCreation },
    );

    expect(screen.getByText(/Pull request declined/)).not.toBeNull();
    expect(screen.getByText('The pull request was declined')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    });
    expect(retryPrCreation).toHaveBeenCalledWith('entity-1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('a superseded PR explains that nothing more is raised, without a retry', async () => {
    await render(makeEntity({ pr_status: 'superseded' }), {
      retryPrCreation: jest.fn(),
    });
    expect(screen.getByText(/Owner changed by someone else/i)).not.toBeNull();
    expect(
      screen.getByText(/no further pull requests are raised/i),
    ).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Retry/i })).toBeNull();
  });

  it('renders nothing when no PR is tracked', async () => {
    await render(makeEntity({ pr_status: 'none' }), {
      retryPrCreation: jest.fn(),
    });
    expect(screen.queryByText(/pull request/i)).toBeNull();
  });
});
