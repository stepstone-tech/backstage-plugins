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

import { DatabaseOwnershipStore } from './DatabaseOwnershipStore';
import { TestDatabases } from '@backstage/backend-test-utils';

// TestDatabases spins up a real Postgres database for each test (SQLite
// was dropped in task 0 — partial unique indexes are Postgres-only).
const databases = TestDatabases.create({ ids: ['POSTGRES_16'] });

async function createStore() {
  const knex = await databases.init('POSTGRES_16');
  const database = {
    getClient: async () => knex,
    migrations: { skip: false },
  } as any;
  return DatabaseOwnershipStore.create({ database });
}

describe('DatabaseOwnershipStore', () => {
  // ── Scans ────────────────────────────────────────────────────────────────

  describe('scans', () => {
    it('creates a scan and retrieves it', async () => {
      const store = await createStore();
      const id = await store.createScan();
      expect(typeof id).toBe('string');

      const scan = await store.getScan(id);
      expect(scan).toBeDefined();
      expect(scan?.status).toBe('running');
    });

    it('completes a scan with stats', async () => {
      const store = await createStore();
      const id = await store.createScan();

      await store.completeScan(id, {
        completed_at: new Date(),
        total_entities_scanned: 100,
        new_issues_found: 5,
        existing_issues_updated: 10,
        issues_auto_resolved: 2,
        status: 'completed',
        duration_ms: 1234,
      });

      const scan = await store.getScan(id);
      expect(scan?.status).toBe('completed');
      expect(scan?.new_issues_found).toBe(5);
      expect(scan?.total_entities_scanned).toBe(100);
    });

    it('lists scans and returns both created scans', async () => {
      const store = await createStore();
      const id1 = await store.createScan();
      const id2 = await store.createScan();

      const scans = await store.listScans();
      expect(scans).toHaveLength(2);
      expect(scans.map(s => s.id)).toEqual(expect.arrayContaining([id1, id2]));
    });
  });

  // ── Entities ─────────────────────────────────────────────────────────────

  describe('entities', () => {
    const entityInput = {
      entity_ref: 'component:default/my-service',
      entity_name: 'my-service',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_check: 'orphaned',
    };

    it('creates an entity and retrieves it by ref', async () => {
      const store = await createStore();
      const id = await store.createEntity(entityInput);
      expect(typeof id).toBe('string');

      const entity = await store.getActiveEntityByRef(
        'component:default/my-service',
      );
      expect(entity).toBeDefined();
      expect(entity?.entity_name).toBe('my-service');
      expect(entity?.current_status).toBe('open');
    });

    it('returns undefined for unknown ref', async () => {
      const store = await createStore();
      const entity = await store.getActiveEntityByRef(
        'component:default/nonexistent',
      );
      expect(entity).toBeUndefined();
    });

    it('accepts an entity with ownership_changed resolution', async () => {
      const store = await createStore();
      const id = await store.createEntity(entityInput);

      const before = await store.getEntityById(id);
      await store.acceptEntity(
        id,
        'system',
        'ownership_changed',
        before!.version,
      );

      const entity = await store.getEntityById(id);
      expect(entity?.current_status).toBe('accepted');
      expect(entity?.resolution_type).toBe('ownership_changed');
      expect(entity?.resolved_by).toBe('system');
      expect(entity?.accepted_at).toBeDefined();
      expect(entity?.version).toBe(before!.version + 1);

      // Accepted entities are still active — tracked until scan confirms ownership was updated.
      const active = await store.getActiveEntityByRef(
        'component:default/my-service',
      );
      expect(active).toBeDefined();
      expect(active?.current_status).toBe('accepted');
    });

    it('sets escalated status', async () => {
      const store = await createStore();
      const id = await store.createEntity(entityInput);
      const before = await store.getEntityById(id);
      await store.setEntityEscalated(id, before!.version);

      const entity = await store.getEntityById(id);
      expect(entity?.current_status).toBe('escalated');
    });

    it('throws ConflictError when version mismatches', async () => {
      const store = await createStore();
      const id = await store.createEntity(entityInput);
      // Use a stale version → ConflictError.
      await expect(
        store.acceptEntity(id, 'system', 'ownership_changed', 999),
      ).rejects.toThrow();
    });

    it('lists entities with filter by status', async () => {
      const store = await createStore();
      await store.createEntity({
        ...entityInput,
        entity_ref: 'component:default/a',
      });
      const id2 = await store.createEntity({
        ...entityInput,
        entity_ref: 'component:default/b',
      });
      const before2 = await store.getEntityById(id2);
      await store.acceptEntity(
        id2,
        'system',
        'ownership_changed',
        before2!.version,
      );

      const result = await store.listEntities({ status: 'open' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].entity_ref).toBe('component:default/a');
      expect(result.total).toBe(1);
    });

    it('paginates entity list correctly', async () => {
      const store = await createStore();
      for (let i = 0; i < 5; i++) {
        await store.createEntity({
          ...entityInput,
          entity_ref: `component:default/svc-${i}`,
          entity_name: `svc-${i}`,
        });
      }

      const page1 = await store.listEntities({}, { page: 1, limit: 2 });
      const page2 = await store.listEntities({}, { page: 2, limit: 2 });

      expect(page1.items).toHaveLength(2);
      expect(page1.total).toBe(5);
      expect(page2.items).toHaveLength(2);
      expect(page1.items[0].id).not.toBe(page2.items[0].id);
    });
  });

  // ── Proposals ─────────────────────────────────────────────────────────────

  describe('proposals', () => {
    async function createEntityAndStore() {
      const store = await createStore();
      const entityId = await store.createEntity({
        entity_ref: 'component:default/my-service',
        entity_name: 'my-service',
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
      });
      return { store, entityId };
    }

    it('creates a proposal and retrieves it', async () => {
      const { store, entityId } = await createEntityAndStore();

      const proposalId = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        confidence_score: 0.8,
        proposal_order: 1,
      });

      const proposal = await store.getProposal(proposalId);
      expect(proposal?.proposed_owner_ref).toBe('group:default/team-a');
      expect(proposal?.status).toBe('pending');
    });

    it('persists a possible_owner status when requested', async () => {
      const { store, entityId } = await createEntityAndStore();

      const proposalId = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',
        confidence_reason: 'top_contributor',
        confidence_score: 0.31,
        proposal_order: 1,
        status: 'possible_owner',
      });

      const proposal = await store.getProposal(proposalId);
      expect(proposal?.status).toBe('possible_owner');
      // Possible owners are not "active" — they must not surface in the
      // pending/active queries that drive notifications.
      const active = await store.listActiveProposalsByEntity(entityId);
      expect(active).toHaveLength(0);
      const pendingIds = await store.listPendingProposalIdsForOwner(
        'group:default/team-a',
      );
      expect(pendingIds).toEqual([]);
    });

    it('includes possible_owner rows in the cancellable set', async () => {
      const { store, entityId } = await createEntityAndStore();

      await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',
        confidence_reason: 'top_contributor',
        proposal_order: 1,
        status: 'possible_owner',
      });

      const cancellable = await store.listCancellableProposalsByEntity(
        entityId,
      );
      expect(cancellable).toHaveLength(1);
      expect(cancellable[0].status).toBe('possible_owner');
    });

    it('deletePossibleOwnersByEntity removes only possible_owner rows', async () => {
      const { store, entityId } = await createEntityAndStore();

      const active = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',
        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });
      await store.updateProposalStatus(active, 'pending', {
        notifiedAt: new Date(),
      });
      await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-b',
        confidence_reason: 'top_contributor',
        proposal_order: 2,
        status: 'possible_owner',
      });

      const removed = await store.deletePossibleOwnersByEntity(entityId);
      expect(removed).toBe(1);

      const remaining = await store.listProposalsByEntity(entityId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].proposed_owner_ref).toBe('group:default/team-a');
      expect(remaining[0].status).toBe('pending');
    });

    it('lists active proposals by entity', async () => {
      const { store, entityId } = await createEntityAndStore();

      const p1 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });
      const p2 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-b',

        confidence_reason: 'top_contributor',
        proposal_order: 2,
      });
      await store.updateProposalStatus(p1, 'pending', {
        notifiedAt: new Date(),
      });
      await store.updateProposalStatus(p2, 'pending', {
        notifiedAt: new Date(),
      });

      // Reject p1 — should no longer appear in active list.
      await store.updateProposalStatus(p1, 'rejected', {
        respondedAt: new Date(),
      });

      const active = await store.listActiveProposalsByEntity(entityId);
      expect(active).toHaveLength(1);
      expect(active[0].proposed_owner_ref).toBe('group:default/team-b');
    });

    // The digest follows pending proposals, not `assigned_to`.
    describe('listPendingProposalsForEmail', () => {
      it('returns only pending team proposals on non-closed entities', async () => {
        const { store, entityId } = await createEntityAndStore();

        // First broadcast candidate rejected; `assigned_to` still points at it.
        const rejected = await store.createProposal({
          entity_id: entityId,
          proposed_owner_ref: 'group:default/team-first',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(rejected, 'rejected', {
          respondedAt: new Date(),
        });
        await store.updateAssignee(entityId, 'group:default/team-first');

        // Sibling candidate still pending.
        const sibling = await store.createProposal({
          entity_id: entityId,
          proposed_owner_ref: 'group:default/team-sibling',
          confidence_reason: 'top_contributor',
          proposal_order: 2,
        });
        await store.updateProposalStatus(sibling, 'pending', {
          notifiedAt: new Date(),
        });

        // Pending proposal addressed to a user (e.g. a director) is excluded.
        const toUser = await store.createProposal({
          entity_id: entityId,
          proposed_owner_ref: 'user:default/director',
          confidence_reason: 'escalation_suggested',
          proposal_order: 3,
        });
        await store.updateProposalStatus(toUser, 'pending', {
          notifiedAt: new Date(),
        });

        // Stale pending proposal behind a closed entity is excluded.
        const closedId = await store.createEntity({
          entity_ref: 'component:default/closed-svc',
          entity_name: 'closed-svc',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const stale = await store.createProposal({
          entity_id: closedId,
          proposed_owner_ref: 'group:default/team-stale',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(stale, 'pending', {
          notifiedAt: new Date(),
        });
        const closedRow = await store.getEntityById(closedId);
        await store.closeEntity(
          closedId,
          'system',
          'ownership_changed',
          closedRow!.version,
        );

        const rows = await store.listPendingProposalsForEmail();
        expect(rows).toEqual([
          {
            team_ref: 'group:default/team-sibling',
            current_check: 'orphaned',
            entity_kind: 'Component',
          },
        ]);
      });
    });

    describe('listPendingProposalIdsForOwner', () => {
      it('returns ids of pending proposals addressed to the owner in ascending order', async () => {
        const { store, entityId } = await createEntityAndStore();

        // 3 proposals for team-a, transitioned to pending.
        const p1 = await store.createProposal({
          entity_id: entityId,
          proposed_owner_ref: 'group:default/team-a',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(p1, 'pending', {
          notifiedAt: new Date(),
        });

        // Need additional entities so each (entity, owner) pair stays unique
        // against the partial unique index.
        const e2 = await store.createEntity({
          entity_ref: 'component:default/svc-2',
          entity_name: 'svc-2',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const p2 = await store.createProposal({
          entity_id: e2,
          proposed_owner_ref: 'group:default/team-a',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(p2, 'pending', {
          notifiedAt: new Date(),
        });

        const e3 = await store.createEntity({
          entity_ref: 'component:default/svc-3',
          entity_name: 'svc-3',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const p3 = await store.createProposal({
          entity_id: e3,
          proposed_owner_ref: 'group:default/team-a',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(p3, 'pending', {
          notifiedAt: new Date(),
        });

        // 1 accepted proposal for team-a — must NOT be included.
        const e4 = await store.createEntity({
          entity_ref: 'component:default/svc-4',
          entity_name: 'svc-4',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const pAccepted = await store.createProposal({
          entity_id: e4,
          proposed_owner_ref: 'group:default/team-a',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(pAccepted, 'accepted', {
          respondedAt: new Date(),
        });

        const ids = await store.listPendingProposalIdsForOwner(
          'group:default/team-a',
        );

        expect(ids).toHaveLength(3);
        expect(ids).toEqual(expect.arrayContaining([p1, p2, p3]));
        expect(ids).not.toContain(pAccepted);

        const sorted = [...ids].sort();
        expect(ids).toEqual(sorted);
      });

      it('returns an empty array when the owner has no proposals', async () => {
        const store = await createStore();
        const ids = await store.listPendingProposalIdsForOwner(
          'group:default/nobody',
        );
        expect(ids).toEqual([]);
      });

      it('only counts status="pending" (excludes accepted, rejected, expired)', async () => {
        const store = await createStore();

        // rejected
        const eRejected = await store.createEntity({
          entity_ref: 'component:default/r',
          entity_name: 'r',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const pRejected = await store.createProposal({
          entity_id: eRejected,
          proposed_owner_ref: 'group:default/team-x',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(pRejected, 'rejected');

        // expired
        const eExpired = await store.createEntity({
          entity_ref: 'component:default/x',
          entity_name: 'x',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const pExpired = await store.createProposal({
          entity_id: eExpired,
          proposed_owner_ref: 'group:default/team-x',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(pExpired, 'expired');

        // accepted
        const eAccepted = await store.createEntity({
          entity_ref: 'component:default/a',
          entity_name: 'a',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const pAccepted = await store.createProposal({
          entity_id: eAccepted,
          proposed_owner_ref: 'group:default/team-x',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(pAccepted, 'accepted', {
          respondedAt: new Date(),
        });

        // pending (the only one that should be returned)
        const ePending = await store.createEntity({
          entity_ref: 'component:default/p',
          entity_name: 'p',
          entity_kind: 'Component',
          entity_namespace: 'default',
          current_check: 'orphaned',
        });
        const pPending = await store.createProposal({
          entity_id: ePending,
          proposed_owner_ref: 'group:default/team-x',
          confidence_reason: 'top_contributor',
          proposal_order: 1,
        });
        await store.updateProposalStatus(pPending, 'pending', {
          notifiedAt: new Date(),
        });

        const ids = await store.listPendingProposalIdsForOwner(
          'group:default/team-x',
        );
        expect(ids).toEqual([pPending]);
      });
    });

    it('getRejectedActors returns refs from rejected and expired proposals', async () => {
      const { store, entityId } = await createEntityAndStore();

      const p1 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });
      const p2 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-b',

        confidence_reason: 'top_contributor',
        proposal_order: 2,
      });

      await store.updateProposalStatus(p1, 'rejected');
      await store.updateProposalStatus(p2, 'expired');

      await store.appendHistory({
        entity_id: entityId,
        proposal_id: p1,
        action: 'proposal_rejected',
        actor: 'user:default/alice',
      });
      await store.appendHistory({
        entity_id: entityId,
        proposal_id: p2,
        action: 'proposal_expired',
        actor: 'system',
      });

      const rejected = await store.getRejectedActors(entityId);
      expect(rejected.has('group:default/team-a')).toBe(true);
      expect(rejected.has('group:default/team-b')).toBe(true);
    });
  });

  // ── History ───────────────────────────────────────────────────────────────

  describe('history', () => {
    it('appends and lists history in chronological order', async () => {
      const store = await createStore();
      const entityId = await store.createEntity({
        entity_ref: 'component:default/my-service',
        entity_name: 'my-service',
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
      });

      await store.appendHistory({
        entity_id: entityId,
        action: 'issue_detected',
        actor: 'system',
        details: { checkName: 'orphaned' },
      });
      await store.appendHistory({
        entity_id: entityId,
        action: 'issue_redetected',
        actor: 'system',
      });

      const history = await store.listHistory(entityId);
      expect(history).toHaveLength(2);
      expect(history[0].action).toBe('issue_detected');
      expect(history[1].action).toBe('issue_redetected');
    });

    it('preserves scan_id and proposal_id FK references in history', async () => {
      const store = await createStore();
      const scanId = await store.createScan();
      const entityId = await store.createEntity({
        entity_ref: 'component:default/my-service',
        entity_name: 'my-service',
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
      });
      const proposalId = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });

      await store.appendHistory({
        entity_id: entityId,
        proposal_id: proposalId,
        scan_id: scanId,
        action: 'proposal_created',
        actor: 'system',
      });

      const history = await store.listHistory(entityId);
      expect(history).toHaveLength(1);
      expect(history[0].entity_id).toBe(entityId);
      expect(history[0].proposal_id).toBe(proposalId);
      expect(history[0].scan_id).toBe(scanId);
    });
  });

  // ── Scan failure ────────────────────────────────────────────────────────

  describe('failScan', () => {
    it('records error message and sets status to failed', async () => {
      const store = await createStore();
      const id = await store.createScan();

      await store.failScan(id, 'Something went wrong', 500);

      const scan = await store.getScan(id);
      expect(scan?.status).toBe('failed');
      expect(scan?.error_message).toBe('Something went wrong');
      expect(scan?.duration_ms).toBe(500);
      expect(scan?.completed_at).toBeDefined();
    });
  });

  // ── Active case uniqueness ──────────────────────────────────────────────

  describe('active case uniqueness', () => {
    const entityInput = {
      entity_ref: 'component:default/my-service',
      entity_name: 'my-service',
      entity_kind: 'Component',
      entity_namespace: 'default',
      current_check: 'orphaned',
    };

    it('rejects second active case for the same entity_ref', async () => {
      const store = await createStore();
      await store.createEntity(entityInput);

      // Second insert for same entity_ref while first is still active should fail.
      await expect(store.createEntity(entityInput)).rejects.toThrow();
    });

    // Accepted is still an active status — case stays tracked until scan confirms fix.
    it('rejects second case while first is accepted (still active)', async () => {
      const store = await createStore();

      const id1 = await store.createEntity(entityInput);
      const before1 = await store.getEntityById(id1);
      await store.acceptEntity(
        id1,
        'system',
        'ownership_changed',
        before1!.version,
      );

      // Second insert for same entity_ref while first is accepted should fail.
      await expect(store.createEntity(entityInput)).rejects.toThrow();
    });

    // After closing, a new case can be created.
    it('allows new case after previous case is closed', async () => {
      const store = await createStore();

      const id1 = await store.createEntity(entityInput);
      const before1 = await store.getEntityById(id1);
      await store.closeEntity(
        id1,
        'system',
        'ownership_changed',
        before1!.version,
      );

      const id2 = await store.createEntity(entityInput);
      expect(id2).toBeDefined();
      expect(id1).not.toBe(id2);
    });
  });

  // ── Proposal active uniqueness ──────────────────────────────────────────

  describe('proposal active uniqueness', () => {
    it('rejects duplicate active proposal for same entity+owner pair', async () => {
      const store = await createStore();
      const entityId = await store.createEntity({
        entity_ref: 'component:default/svc',
        entity_name: 'svc',
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
      });

      await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });

      // Second proposal for same entity+owner while first is pending should fail.
      await expect(
        store.createProposal({
          entity_id: entityId,
          proposed_owner_ref: 'group:default/team-a',

          confidence_reason: 'org_proximity',
          proposal_order: 2,
        }),
      ).rejects.toThrow();
    });

    it('allows re-proposal after rejection', async () => {
      const store = await createStore();
      const entityId = await store.createEntity({
        entity_ref: 'component:default/svc',
        entity_name: 'svc',
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
      });

      const p1 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'top_contributor',
        proposal_order: 1,
      });

      await store.updateProposalStatus(p1, 'rejected');

      // After rejection, same entity+owner can be proposed again.
      const p2 = await store.createProposal({
        entity_id: entityId,
        proposed_owner_ref: 'group:default/team-a',

        confidence_reason: 'org_proximity',
        proposal_order: 2,
      });

      expect(p2).toBeDefined();
    });
  });

  // ── Stats ─────────────────────────────────────────────────────────────────

  describe('stats', () => {
    async function createOpenEntity(
      store: DatabaseOwnershipStore,
      ref: string,
      check: string,
    ) {
      return store.createEntity({
        entity_ref: ref,
        entity_name: ref.split('/')[1],
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: check,
      });
    }

    it('returns per-check counts that include custom (non-built-in) checks', async () => {
      const store = await createStore();

      await createOpenEntity(store, 'component:default/a', 'orphaned');
      await createOpenEntity(store, 'component:default/b', 'orphaned');
      await createOpenEntity(store, 'component:default/c', 'zombie');
      await createOpenEntity(store, 'component:default/d', 'stale-team');

      const stats = await store.getDashboardStats();

      expect(stats.perCheck).toEqual({
        orphaned: 2,
        zombie: 1,
        'stale-team': 1,
      });
      expect(stats.totalOpen).toBe(4);
    });

    it('excludes closed/accepted entities from totals', async () => {
      const store = await createStore();

      const openId = await createOpenEntity(
        store,
        'component:default/open',
        'orphaned',
      );
      const closedId = await createOpenEntity(
        store,
        'component:default/closed',
        'zombie',
      );

      const closedRow = await store.getEntityById(closedId);
      await store.closeEntity(
        closedId,
        'system',
        'ownership_changed',
        closedRow!.version,
      );

      const stats = await store.getDashboardStats();

      expect(stats.totalOpen).toBe(1);
      expect(stats.perCheck).toEqual({ orphaned: 1 });
      // sanity — the open row is still there
      expect(await store.getEntityById(openId)).toBeDefined();
    });

    it('returns empty perCheck when there are no open entities', async () => {
      const store = await createStore();
      const stats = await store.getDashboardStats();
      expect(stats.totalOpen).toBe(0);
      expect(stats.perCheck).toEqual({});
    });
  });
});

// ── Leadership escalation scoping (resolved_actor_ref) ─────────────────────

describe('DatabaseOwnershipStore — escalation actor scoping', () => {
  const ACTOR = 'user:default/director';
  const TEAM = 'group:default/team-a';

  async function setup() {
    const knex = await databases.init('POSTGRES_16');
    const store = await DatabaseOwnershipStore.create({
      database: {
        getClient: async () => knex,
        migrations: { skip: false },
      } as any,
    });

    const create = async (
      name: string,
      owner: string | null,
      escalated: boolean,
    ) => {
      const id = await store.createEntity({
        entity_ref: `component:default/${name}`,
        entity_name: name,
        entity_kind: 'Component',
        entity_namespace: 'default',
        current_check: 'orphaned',
        current_owner: owner,
      } as any);
      if (escalated) {
        const row = await store.getEntityById(id);
        await store.setEntityEscalated(id, row!.version);
      }
      return id;
    };
    const queue = (
      entityId: string,
      actorRef: string,
      status: string,
      position = 0,
    ) =>
      knex('escalation_queue_entries').insert({
        entity_id: entityId,
        group_ref: TEAM,
        escalation_level: 1,
        position,
        status,
        resolved_actor_ref: actorRef,
      });

    return { store, create, queue };
  }

  it('scopes escalated entities by active actor and the rest by owner, without duplicates', async () => {
    const { store, create, queue } = await setup();

    const mineTwice = await create('assigned-twice', null, true);
    await queue(mineTwice, ACTOR, 'active', 0);
    await queue(mineTwice, ACTOR, 'active', 1);
    const othersInTeam = await create('team-owned-other-actor', TEAM, true);
    await queue(othersInTeam, 'user:default/bob', 'active');
    const finished = await create('completed-entry', null, true);
    await queue(finished, ACTOR, 'completed');
    await create('team-open', TEAM, false);
    await create('foreign-open', 'group:default/other', false);

    const result = await store.listEntities({
      owners: [TEAM],
      escalationActorRef: ACTOR,
    });

    expect(
      result.items.map(e => e.entity_name).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['assigned-twice', 'team-open']);
    expect(result.total).toBe(2);

    const escalatedOnly = await store.listEntities({
      owners: [TEAM],
      escalationActorRef: ACTOR,
      status: 'escalated',
    });
    expect(escalatedOnly.items.map(e => e.entity_name)).toEqual([
      'assigned-twice',
    ]);

    // No owners at all (director with only non-team groups): assigned cases only.
    const noOwners = await store.listEntities({
      owners: [],
      escalationActorRef: ACTOR,
    });
    expect(noOwners.items.map(e => e.entity_name)).toEqual(['assigned-twice']);

    const stats = await store.getStatsForOwners([TEAM], ACTOR);
    expect(stats).toEqual({ totalOpen: 2, perCheck: { orphaned: 2 } });

    expect(await store.countActiveEscalationsForActor(ACTOR)).toBe(2);
    expect(
      await store.countActiveEscalationsForActor('user:default/nobody'),
    ).toBe(0);
  });

  it('leaves owner-only filtering unchanged when no actor is given', async () => {
    const { store, create, queue } = await setup();
    const escalated = await create('team-escalated', TEAM, true);
    await queue(escalated, 'user:default/bob', 'active');
    await create('team-open', TEAM, false);

    const result = await store.listEntities({ owners: [TEAM] });
    expect(
      result.items.map(e => e.entity_name).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['team-escalated', 'team-open']);
    expect(await store.getStatsForOwners([TEAM])).toEqual({
      totalOpen: 2,
      perCheck: { orphaned: 2 },
    });
  });
});
