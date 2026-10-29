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
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  OwnershipEntity,
  OwnershipHistory,
  OwnershipMatcherApi,
  ownershipMatcherApiRef,
} from '../../api';
import { rootRouteRef } from '../../routes';
import { QueryProvider } from '../../query/QueryProvider';
import { OwnershipMatcherAdminPanel } from './OwnershipMatcherPage';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeEntity(id: string, kind: string): OwnershipEntity {
  return {
    id,
    entity_ref: `${kind.toLowerCase()}:default/${id}`,
    entity_name: id,
    entity_kind: kind,
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: '2026-10-01T00:00:00.000Z',
    last_scanned_at: '2026-10-01T00:00:00.000Z',
    current_status: 'unresolved',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    resolved_at: null,
    resolved_by: null,
    resolution_type: null,
    assigned_to: null,
  } as OwnershipEntity;
}

function reasonHistory(entityId: string, action: string): OwnershipHistory {
  return {
    id: `h-${entityId}`,
    entity_id: entityId,
    proposal_id: null,
    scan_id: null,
    action,
    actor: 'system',
    details: null,
    created_at: '2026-10-01T10:00:00.000Z',
  } as OwnershipHistory;
}

/** [id, kind, reason action | undefined] */
type Spec = [string, string, string | undefined];

function createApi(specs: Spec[]) {
  const reasons = new Map(specs.map(([id, , reason]) => [id, reason]));
  return {
    listAllEntities: jest
      .fn()
      .mockResolvedValue(specs.map(([id, kind]) => makeEntity(id, kind))),
    getEntity: jest.fn(async (id: string) => {
      const reason = reasons.get(id);
      return {
        entity: makeEntity(id, 'Component'),
        proposals: [],
        history: reason ? [reasonHistory(id, reason)] : [],
      };
    }),
  } as unknown as jest.Mocked<OwnershipMatcherApi>;
}

async function renderUnresolved(api: jest.Mocked<OwnershipMatcherApi>) {
  await renderInTestApp(
    <QueryProvider>
      <TestApiProvider apis={[[ownershipMatcherApiRef, api]]}>
        <OwnershipMatcherAdminPanel />
      </TestApiProvider>
    </QueryProvider>,
    {
      routeEntries: ['/?view=unresolved'],
      mountedRoutes: { '/ownership': rootRouteRef },
    },
  );
  await screen.findByText('Unresolved Cases');
}

function chip(name: string) {
  return screen.getByRole('button', { name });
}

function entityLinks(): string[] {
  return screen
    .queryAllByRole('link')
    .map(a => a.textContent ?? '')
    .filter(t => t !== 'View');
}

const SPECS: Spec[] = [
  ['svc-a', 'Component', 'no_candidates_found'],
  ['svc-b', 'Component', 'escalation_exhausted'],
  ['api-a', 'API', 'no_candidates_found'],
  ['res-a', 'Resource', undefined],
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('UnresolvedTab — categorisation', () => {
  it('shows per-kind and per-reason counts', async () => {
    await renderUnresolved(createApi(SPECS));

    expect(
      await screen.findByRole('button', { name: 'Component (2)' }),
    ).not.toBeNull();
    expect(chip('API (1)')).not.toBeNull();
    expect(chip('Resource (1)')).not.toBeNull();
    expect(chip('No candidates (2)')).not.toBeNull();
    expect(chip('Escalation exhausted (1)')).not.toBeNull();
    expect(chip('Unknown (1)')).not.toBeNull();
    expect(screen.getAllByRole('button', { name: 'All (4)' })).toHaveLength(2);
  });

  it('filters rows by kind and updates the other facet counts', async () => {
    await renderUnresolved(createApi(SPECS));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Component (2)' }),
    );

    expect(entityLinks().sort()).toEqual(['svc-a', 'svc-b']);
    // Reason counts now reflect only Component rows.
    expect(chip('No candidates (1)')).not.toBeNull();
    expect(chip('Escalation exhausted (1)')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /^Unknown/ })).toBeNull();
  });

  it('combines kind and reason filters, and clicking a selected chip clears it', async () => {
    await renderUnresolved(createApi(SPECS));

    fireEvent.click(
      await screen.findByRole('button', { name: 'No candidates (2)' }),
    );
    expect(entityLinks().sort()).toEqual(['api-a', 'svc-a']);

    fireEvent.click(chip('API (1)'));
    expect(entityLinks()).toEqual(['api-a']);

    fireEvent.click(chip('API (1)'));
    expect(entityLinks().sort()).toEqual(['api-a', 'svc-a']);
  });

  it('keeps search working on the filtered rows', async () => {
    await renderUnresolved(createApi(SPECS));

    fireEvent.click(
      await screen.findByRole('button', { name: 'Component (2)' }),
    );
    fireEvent.change(screen.getByPlaceholderText('Filter'), {
      target: { value: 'svc-b' },
    });

    // material-table debounces search input.
    await waitFor(() => expect(entityLinks()).toEqual(['svc-b']));
  });

  it('keeps pagination working on the filtered rows', async () => {
    const many: Spec[] = [
      ...Array.from(
        { length: 25 },
        (_, i): Spec => [
          `cmp-${String(i).padStart(2, '0')}`,
          'Component',
          'no_candidates_found',
        ],
      ),
      ['api-a', 'API', 'no_candidates_found'],
    ];
    await renderUnresolved(createApi(many));

    // Unfiltered: 26 rows → page 1 holds 20.
    expect(await screen.findByText('cmp-00')).not.toBeNull();
    expect(entityLinks()).toHaveLength(20);

    fireEvent.click(chip('API (1)'));
    expect(entityLinks()).toEqual(['api-a']);

    fireEvent.click(chip('All (26)'));
    expect(entityLinks()).toHaveLength(20);
  });
});
