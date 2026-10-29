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

/** Unit tests for the EscalationTrigger port. */

import { mockServices } from '@backstage/backend-test-utils';
import {
  EscalationTrigger,
  FallbackEscalationTrigger,
  LazyEscalationTrigger,
} from './EscalationTrigger';
import { OwnershipStore, TxStores } from '../service/DatabaseOwnershipStore';
import { EntityStatus, ProposalStatus } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface FakeStores {
  entityStore: {
    getEntityById: jest.Mock;
    setEntityUnresolved: jest.Mock;
    updateAssignee: jest.Mock;
  };
  historyStore: {
    appendHistory: jest.Mock;
  };
  proposalStore: {
    listProposalsByEntity: jest.Mock;
  };
}

function makeFakeStore(initial: {
  current_status: EntityStatus;
  id?: string;
  version?: number;
  /** Statuses of the entity's proposals (all of them, any status). */
  proposalStatuses?: ProposalStatus[];
}): { store: jest.Mocked<OwnershipStore>; tx: FakeStores } {
  const tx: FakeStores = {
    entityStore: {
      getEntityById: jest.fn().mockResolvedValue({
        id: initial.id ?? 'entity-1',
        version: initial.version ?? 1,
        current_status: initial.current_status,
      }),
      setEntityUnresolved: jest.fn().mockResolvedValue(undefined),
      updateAssignee: jest.fn().mockResolvedValue(undefined),
    },
    historyStore: {
      appendHistory: jest.fn().mockResolvedValue(undefined),
    },
    proposalStore: {
      listProposalsByEntity: jest.fn().mockResolvedValue(
        (initial.proposalStatuses ?? []).map((status, i) => ({
          id: `p-${i}`,
          status,
        })),
      ),
    },
  };

  const store = {
    withTransaction: jest.fn(async (fn: (s: TxStores) => Promise<unknown>) =>
      fn(tx as unknown as TxStores),
    ),
  } as unknown as jest.Mocked<OwnershipStore>;

  return { store, tx };
}

// ── LazyEscalationTrigger ────────────────────────────────────────────────────

describe('LazyEscalationTrigger', () => {
  it('throws clearly when triggerEscalation is called before set()', async () => {
    const trigger = new LazyEscalationTrigger();

    await expect(trigger.triggerEscalation('entity-1')).rejects.toThrow(
      /escalation trigger accessed before wiring complete/,
    );
  });

  it('delegates to inner once set()', async () => {
    const inner: EscalationTrigger = {
      triggerEscalation: jest.fn().mockResolvedValue(undefined),
    };
    const trigger = new LazyEscalationTrigger();
    trigger.set(inner);

    await trigger.triggerEscalation('entity-1');

    expect(inner.triggerEscalation).toHaveBeenCalledTimes(1);
    expect(inner.triggerEscalation).toHaveBeenCalledWith('entity-1');
  });

  it('set() called twice — second impl wins, no error', async () => {
    const first: EscalationTrigger = {
      triggerEscalation: jest.fn().mockResolvedValue(undefined),
    };
    const second: EscalationTrigger = {
      triggerEscalation: jest.fn().mockResolvedValue(undefined),
    };
    const trigger = new LazyEscalationTrigger();

    trigger.set(first);
    trigger.set(second);

    await trigger.triggerEscalation('entity-1');

    expect(first.triggerEscalation).not.toHaveBeenCalled();
    expect(second.triggerEscalation).toHaveBeenCalledTimes(1);
  });

  it('set() rejects null and undefined so wiring bugs fail loudly', () => {
    const trigger = new LazyEscalationTrigger();
    expect(() => trigger.set(null as unknown as EscalationTrigger)).toThrow(
      /wiring bug/i,
    );
    expect(() =>
      trigger.set(undefined as unknown as EscalationTrigger),
    ).toThrow(/wiring bug/i);
  });
});

// ── FallbackEscalationTrigger ────────────────────────────────────────────────

describe('FallbackEscalationTrigger', () => {
  const logger = mockServices.logger.mock();

  it('writes unresolved + no_candidates_found + assignee=null for an open entity', async () => {
    const { store, tx } = makeFakeStore({ current_status: 'open' });
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation('entity-1');

    expect(tx.entityStore.setEntityUnresolved).toHaveBeenCalledTimes(1);
    expect(tx.entityStore.setEntityUnresolved).toHaveBeenCalledWith(
      'entity-1',
      1,
    );
    // The fallback must clear the assignee, like the regular escalation path.
    expect(tx.entityStore.updateAssignee).toHaveBeenCalledTimes(1);
    expect(tx.entityStore.updateAssignee).toHaveBeenCalledWith(
      'entity-1',
      null,
    );
    expect(tx.historyStore.appendHistory).toHaveBeenCalledTimes(1);
    expect(tx.historyStore.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: 'entity-1',
        action: 'no_candidates_found',
        actor: 'system',
        details: expect.objectContaining({ reason: 'escalation_disabled' }),
      }),
    );
  });

  // Sweep over all non-`open` enum values via it.each so a
  // future status added to EntityStatus is caught by a typecheck failure here
  // rather than slipping past a fragile literal list.
  const NON_OPEN_STATUSES: EntityStatus[] = [
    'escalated',
    'accepted',
    'to_archive',
    'closed',
    'unresolved',
  ];

  it.each(NON_OPEN_STATUSES)(
    'does NOT demote entity in non-open status %s',
    async (status: EntityStatus) => {
      const { store, tx } = makeFakeStore({ current_status: status });
      const trigger = new FallbackEscalationTrigger(store, logger);

      await trigger.triggerEscalation('entity-1');

      expect(tx.entityStore.setEntityUnresolved).not.toHaveBeenCalled();
      expect(tx.entityStore.updateAssignee).not.toHaveBeenCalled();
      expect(tx.historyStore.appendHistory).not.toHaveBeenCalled();
    },
  );

  // Under broadcast, one team rejecting must not orphan the other teams'
  // still-live proposals by flipping the whole case to unresolved.
  it('stays open while a sibling proposal is still pending', async () => {
    const { store, tx } = makeFakeStore({
      current_status: 'open',
      proposalStatuses: ['rejected', 'pending'],
    });
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation('entity-1');

    expect(tx.entityStore.setEntityUnresolved).not.toHaveBeenCalled();
    expect(tx.entityStore.updateAssignee).not.toHaveBeenCalled();
    expect(tx.historyStore.appendHistory).not.toHaveBeenCalled();
  });

  it('goes unresolved once the last live proposal is rejected', async () => {
    const { store, tx } = makeFakeStore({
      current_status: 'open',
      proposalStatuses: ['rejected', 'rejected', 'expired'],
    });
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation('entity-1');

    expect(tx.entityStore.setEntityUnresolved).toHaveBeenCalledWith(
      'entity-1',
      1,
    );
    expect(tx.entityStore.updateAssignee).toHaveBeenCalledWith(
      'entity-1',
      null,
    );
  });

  it('ignores possible_owner rows (never notified) when deciding; mixed rejected + possible_owner is not only_possible_owners', async () => {
    const { store, tx } = makeFakeStore({
      current_status: 'open',
      proposalStatuses: ['rejected', 'possible_owner'],
    });
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation('entity-1');

    expect(tx.entityStore.setEntityUnresolved).toHaveBeenCalledTimes(1);
    expect(tx.historyStore.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { reason: 'escalation_disabled' },
      }),
    );
  });

  it('records only_possible_owners when every candidate is a possible owner', async () => {
    const { store, tx } = makeFakeStore({
      current_status: 'open',
      proposalStatuses: ['possible_owner', 'possible_owner'],
    });
    const trigger = new FallbackEscalationTrigger(store, logger);

    await trigger.triggerEscalation('entity-1');

    expect(tx.entityStore.setEntityUnresolved).toHaveBeenCalledTimes(1);
    expect(tx.historyStore.appendHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'no_candidates_found',
        details: { reason: 'only_possible_owners' },
      }),
    );
  });

  it('returns silently when entity is missing', async () => {
    const tx: FakeStores = {
      entityStore: {
        getEntityById: jest.fn().mockResolvedValue(undefined),
        setEntityUnresolved: jest.fn(),
        updateAssignee: jest.fn(),
      },
      historyStore: { appendHistory: jest.fn() },
      proposalStore: { listProposalsByEntity: jest.fn() },
    };
    const store = {
      withTransaction: jest.fn(async (fn: (s: TxStores) => Promise<unknown>) =>
        fn(tx as unknown as TxStores),
      ),
    } as unknown as jest.Mocked<OwnershipStore>;
    const trigger = new FallbackEscalationTrigger(store, logger);

    await expect(trigger.triggerEscalation('missing')).resolves.toBeUndefined();
    expect(tx.entityStore.setEntityUnresolved).not.toHaveBeenCalled();
  });
});
