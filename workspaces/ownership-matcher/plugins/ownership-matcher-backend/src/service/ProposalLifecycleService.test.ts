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

import { ProposalLifecycleService } from './ProposalLifecycleService';
import { OwnershipStore } from './DatabaseOwnershipStore';
import { mockServices } from '@backstage/backend-test-utils';
import { NotFoundError, ConflictError } from '@backstage/errors';
import { EscalationTrigger } from '../escalation/EscalationTrigger';

const noopTrigger: EscalationTrigger = { triggerEscalation: async () => {} };

type MakeStoreReturn = OwnershipStore & {
  writeDeadline: jest.Mock;
  cancelDeadlinesForEntity: jest.Mock;
};

function makeStore(overrides: Partial<OwnershipStore> = {}): MakeStoreReturn {
  const store: any = {
    createScan: jest.fn(),
    completeScan: jest.fn(),
    failScan: jest.fn(),
    failStaleScans: jest.fn().mockResolvedValue(0),
    getScan: jest.fn(),
    listScans: jest.fn(),
    createEntity: jest.fn(),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    setEntityUnresolved: jest.fn(),
    closeEntity: jest.fn(),
    getActiveEntityByRef: jest.fn(),
    getEntityById: jest.fn(),
    listEntities: jest.fn(),
    createProposal: jest.fn(),
    getProposal: jest.fn(),
    // Default: no siblings. Tests that exercise broadcast cancellation override these.
    listProposalsByEntity: jest.fn().mockResolvedValue([]),
    listCancellableProposalsByEntity: jest.fn().mockResolvedValue([]),
    listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
    updateProposalStatus: jest.fn(),
    listProposalsForOwners: jest.fn(),
    appendHistory: jest.fn(),
    listHistory: jest.fn(),
    getRejectedActors: jest.fn(),
    findActiveQueueEntry: jest.fn(),
    ...overrides,
  };
  // Stable deadline-store spies so tests can assert on them across the tx.
  store.writeDeadline = jest.fn();
  store.cancelDeadlinesForEntity = jest.fn();
  store.lockUnprocessedForEntity = jest.fn();
  store.withTransaction = jest.fn(async (cb: (tx: any) => Promise<unknown>) =>
    cb({
      proposalStore: store,
      entityStore: store,
      historyStore: store,
      escalationQueueStore: store,
      pendingDeadlineStore: {
        writeDeadline: store.writeDeadline,
        cancelDeadlinesForEntity: store.cancelDeadlinesForEntity,
        lockUnprocessedForEntity: store.lockUnprocessedForEntity,
      },
    }),
  );
  return store as MakeStoreReturn;
}

const pendingProposal = {
  id: 'proposal-1',
  entity_id: 'entity-1',
  proposed_owner_ref: 'group:default/team-a',
  status: 'pending',
  proposal_order: 1,
  escalation_level: 0,
};

const openEntity = {
  id: 'entity-1',
  entity_ref: 'component:default/svc',
  current_status: 'open',
  version: 1,
};

const acceptedEntity = { ...openEntity, current_status: 'accepted' };
const rejectedProposal = { ...pendingProposal, status: 'rejected' };
const acceptedProposal = { ...pendingProposal, status: 'accepted' };

/** Store primed for a successful accept, with the PR-tracking writes stubbed. */
function acceptStore() {
  const store = makeStore({
    getProposal: jest
      .fn()
      .mockResolvedValueOnce(pendingProposal)
      .mockResolvedValueOnce(acceptedProposal),
    getEntityById: jest.fn().mockResolvedValue(acceptedEntity),
  });
  (store as any).updatePrState = jest.fn();
  store.writeDeadline.mockImplementation(async (d: { deadline_type: string }) =>
    d.deadline_type === 'pr_creation' ? 'pr-deadline-1' : 'other-deadline',
  );
  return store;
}

describe('ProposalLifecycleService', () => {
  const logger = mockServices.logger.mock();

  // ── acceptProposal ─────────────────────────────────────────────────────────

  describe('acceptProposal', () => {
    it('transitions proposal to accepted and accepts entity', async () => {
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(acceptedProposal),
        getEntityById: jest.fn().mockResolvedValue(acceptedEntity),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      const result = await svc.acceptProposal(
        'proposal-1',
        'user:default/alice',
      );

      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-1',
        'accepted',
        expect.objectContaining({ respondedAt: expect.any(Date) }),
      );
      expect(store.acceptEntity).toHaveBeenCalledWith(
        'entity-1',
        'user:default/alice',
        'ownership_changed',
        expect.any(Number),
      );
      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'proposal_accepted' }),
      );
      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'entity_accepted',
          details: expect.objectContaining({ via: 'proposal' }),
        }),
      );
      expect(result.proposal.status).toBe('accepted');
      expect(result.entity.current_status).toBe('accepted');
    });

    it('broadcast: cancels every live sibling returned by listCancellableProposalsByEntity (pending, possible_owner) + proposal_expiry deadlines', async () => {
      const siblingB = {
        ...pendingProposal,
        id: 'proposal-2',
        proposed_owner_ref: 'group:default/team-b',
        proposal_order: 2,
      };
      const possibleOwner = {
        ...pendingProposal,
        id: 'proposal-3',
        status: 'possible_owner',
        proposed_owner_ref: 'group:default/team-c',
        proposal_order: 3,
      };
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(acceptedProposal),
        getEntityById: jest.fn().mockResolvedValue(acceptedEntity),
        // listCancellableProposalsByEntity returns the live set
        // (pending/accepted/possible_owner) — including the row we accept.
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([pendingProposal, siblingB, possibleOwner]),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      await svc.acceptProposal('proposal-1', 'user:default/alice');

      // The accepted proposal flips to accepted; every other live sibling
      // (pending, possible_owner) flips to cancelled.
      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-1',
        'accepted',
        expect.any(Object),
      );
      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-2',
        'cancelled',
        expect.objectContaining({ respondedAt: expect.any(Date) }),
      );
      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-3',
        'cancelled',
        expect.objectContaining({ respondedAt: expect.any(Date) }),
      );
      // The accepted row is not also cancelled.
      expect(store.updateProposalStatus).not.toHaveBeenCalledWith(
        'proposal-1',
        'cancelled',
        expect.anything(),
      );

      // History rows record the cancellation and the sibling's prior status.
      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal_id: 'proposal-2',
          action: 'proposal_cancelled',
          details: expect.objectContaining({
            reason: 'sibling_accepted',
            acceptedProposalId: 'proposal-1',
            siblingStatus: 'pending',
          }),
        }),
      );
      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          proposal_id: 'proposal-3',
          action: 'proposal_cancelled',
          details: expect.objectContaining({
            reason: 'sibling_accepted',
            siblingStatus: 'possible_owner',
          }),
        }),
      );

      // Outstanding proposal_expiry deadlines for the entity are cancelled.
      expect(store.cancelDeadlinesForEntity).toHaveBeenCalledWith('entity-1', [
        'proposal_expiry',
      ]);
    });

    it('broadcast: warns and cancels an anomalous second accepted sibling', async () => {
      const secondAccepted = {
        ...pendingProposal,
        id: 'proposal-2',
        status: 'accepted',
        proposed_owner_ref: 'group:default/team-b',
        proposal_order: 2,
      };
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(acceptedProposal),
        getEntityById: jest.fn().mockResolvedValue(acceptedEntity),
        listCancellableProposalsByEntity: jest
          .fn()
          .mockResolvedValue([pendingProposal, secondAccepted]),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      await svc.acceptProposal('proposal-1', 'user:default/alice');

      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-2',
        'cancelled',
        expect.any(Object),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('second accepted proposal proposal-2'),
      );
    });

    describe('catalog-info PR automation', () => {
      it('enqueues a pr_creation job in the accept tx, marks pr_status pending, and records history', async () => {
        const store = acceptStore();
        const prTrigger = { trigger: jest.fn().mockResolvedValue(undefined) };
        const svc = new ProposalLifecycleService(
          store,
          logger,
          undefined,
          undefined,
          noopTrigger,
          prTrigger,
        );

        await svc.acceptProposal('proposal-1', 'user:default/alice');

        expect(store.cancelDeadlinesForEntity).toHaveBeenCalledWith(
          'entity-1',
          ['pr_creation'],
        );
        expect(store.writeDeadline).toHaveBeenCalledWith({
          entity_id: 'entity-1',
          proposal_id: 'proposal-1',
          deadline_type: 'pr_creation',
          fire_at: expect.any(Date),
          actor_ref: 'user:default/alice',
        });
        expect((store as any).updatePrState).toHaveBeenCalledWith('entity-1', {
          pr_status: 'pending',
          pr_attempts: 0,
          pr_last_error: null,
        });
        expect(store.appendHistory).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'pr_creation_enqueued',
            actor: 'user:default/alice',
            details: { ownerRef: 'group:default/team-a' },
          }),
        );
        expect(prTrigger.trigger).toHaveBeenCalledWith('pr-deadline-1');
      });

      it('does not wait for, or fail on, the PR kick', async () => {
        const store = acceptStore();
        const prTrigger = {
          trigger: jest.fn(() => Promise.reject(new Error('bitbucket down'))),
        };
        const svc = new ProposalLifecycleService(
          store,
          logger,
          undefined,
          undefined,
          noopTrigger,
          prTrigger,
        );

        await expect(
          svc.acceptProposal('proposal-1', 'user:default/alice'),
        ).resolves.toBeDefined();
        await new Promise(setImmediate);
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('bitbucket down'),
        );
      });

      it('enqueues nothing when PR automation is disabled (no trigger)', async () => {
        const store = acceptStore();
        const svc = new ProposalLifecycleService(
          store,
          logger,
          undefined,
          undefined,
          noopTrigger,
        );

        await svc.acceptProposal('proposal-1', 'user:default/alice');

        expect(store.writeDeadline).not.toHaveBeenCalledWith(
          expect.objectContaining({ deadline_type: 'pr_creation' }),
        );
        expect((store as any).updatePrState).not.toHaveBeenCalled();
      });
    });

    it('throws NotFoundError for unknown proposal', async () => {
      const store = makeStore({
        getProposal: jest.fn().mockResolvedValue(undefined),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );
      await expect(
        svc.acceptProposal('bad-id', 'user:default/alice'),
      ).rejects.toThrow(NotFoundError);
    });

    it('throws ConflictError if proposal is already accepted', async () => {
      const store = makeStore({
        getProposal: jest.fn().mockResolvedValue(acceptedProposal),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );
      await expect(
        svc.acceptProposal('proposal-1', 'user:default/alice'),
      ).rejects.toThrow(ConflictError);
    });

    it('claims a possible_owner proposal (voluntary claim from the Possible Owners list)', async () => {
      const possibleOwner = { ...pendingProposal, status: 'possible_owner' };
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(possibleOwner)
          .mockResolvedValueOnce(acceptedProposal),
        getEntityById: jest.fn().mockResolvedValue(acceptedEntity),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      const result = await svc.acceptProposal(
        'proposal-1',
        'user:default/alice',
      );

      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-1',
        'accepted',
        expect.objectContaining({ respondedAt: expect.any(Date) }),
      );
      expect(store.acceptEntity).toHaveBeenCalledWith(
        'entity-1',
        'user:default/alice',
        'ownership_changed',
        expect.any(Number),
      );
      expect(result.proposal.status).toBe('accepted');
      expect(result.entity.current_status).toBe('accepted');
    });

    it('throws ConflictError for a terminal status (e.g. cancelled)', async () => {
      const cancelledProposal = { ...pendingProposal, status: 'cancelled' };
      const store = makeStore({
        getProposal: jest.fn().mockResolvedValue(cancelledProposal),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );
      await expect(
        svc.acceptProposal('proposal-1', 'user:default/alice'),
      ).rejects.toThrow(ConflictError);
    });
  });

  // ── rejectProposal ─────────────────────────────────────────────────────────

  describe('rejectProposal', () => {
    it('transitions proposal to rejected and logs reason', async () => {
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(rejectedProposal),
        getEntityById: jest.fn().mockResolvedValue(openEntity),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      const result = await svc.rejectProposal(
        'proposal-1',
        'user:default/alice',
        'Not our team',
      );

      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-1',
        'rejected',
        expect.objectContaining({ responseNote: 'Not our team' }),
      );
      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'proposal_rejected',
          details: expect.objectContaining({ reason: 'Not our team' }),
        }),
      );
      expect(result.proposal.status).toBe('rejected');
    });

    it('does NOT trigger escalation directly when all proposals exhausted; that side effect lives at the router/EscalationTrigger boundary', async () => {
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(rejectedProposal),
        listActiveProposalsByEntity: jest.fn().mockResolvedValue([]),
        getEntityById: jest.fn().mockResolvedValue(openEntity),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      await svc.rejectProposal('proposal-1', 'user:default/alice', 'No');

      // PLS no longer flips entity status itself — the router checks for
      // remaining proposals and dispatches via EscalationTrigger.
      expect(store.setEntityEscalated).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'escalation_triggered' }),
      );
    });

    it('broadcast: does NOT cancel sibling pending proposals (siblings stay independently claimable)', async () => {
      const siblingB = {
        ...pendingProposal,
        id: 'proposal-2',
        proposed_owner_ref: 'group:default/team-b',
        proposal_order: 2,
      };
      const store = makeStore({
        getProposal: jest
          .fn()
          .mockResolvedValueOnce(pendingProposal)
          .mockResolvedValueOnce(rejectedProposal),
        getEntityById: jest.fn().mockResolvedValue(openEntity),
        listProposalsByEntity: jest
          .fn()
          .mockResolvedValue([pendingProposal, siblingB]),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );

      await svc.rejectProposal(
        'proposal-1',
        'user:default/alice',
        'Not our team',
      );

      // Only the rejected proposal changes status. The sibling stays pending —
      // it is NOT cancelled (contrast with acceptProposal).
      expect(store.updateProposalStatus).toHaveBeenCalledTimes(1);
      expect(store.updateProposalStatus).toHaveBeenCalledWith(
        'proposal-1',
        'rejected',
        expect.any(Object),
      );
      expect(store.updateProposalStatus).not.toHaveBeenCalledWith(
        'proposal-2',
        expect.anything(),
        expect.anything(),
      );
      // No bulk deadline cancellation on reject (that belongs to accept/close).
      expect(store.cancelDeadlinesForEntity).not.toHaveBeenCalled();
    });

    it('throws NotFoundError for unknown proposal', async () => {
      const store = makeStore({
        getProposal: jest.fn().mockResolvedValue(undefined),
      });
      const svc = new ProposalLifecycleService(
        store,
        logger,
        undefined,
        undefined,
        noopTrigger,
      );
      await expect(
        svc.rejectProposal('bad-id', 'user:default/alice', 'No'),
      ).rejects.toThrow(NotFoundError);
    });
  });
});
