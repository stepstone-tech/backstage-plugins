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

/**
 * Store methods (PR tracking + deadline leasing) against a real
 * database. Runs on SQLite so it is part of the default unit run; the
 * Postgres-specific concurrency semantics (SKIP LOCKED, FOR UPDATE) are
 * covered in src/pr/PrCreation.integration.test.ts.
 */
import { TestDatabases } from '@backstage/backend-test-utils';
import { DatabaseOwnershipStore } from '../DatabaseOwnershipStore';
import {
  seedDeadlineRow,
  seedEntityRow,
} from '../../escalation/__fixtures__/seedEntity';

const databases = TestDatabases.create({ ids: ['SQLITE_3'] });

async function setup() {
  const knex = await databases.init('SQLITE_3');
  const store = await DatabaseOwnershipStore.create({
    database: {
      getClient: async () => knex,
      migrations: { skip: false },
    } as any,
  });
  return { knex, store };
}

const T0 = new Date('2026-10-01T10:00:00.000Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

describe('EntityStore — PR tracking', () => {
  it('updatePrState writes only the pr_* columns and leaves version untouched', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex, {
      current_status: 'accepted',
      version: 4,
    });

    await store.withTransaction(tx =>
      tx.entityStore.updatePrState(entity.id, {
        pr_status: 'raised',
        pr_url: 'https://repo/pr/1',
        pr_branch: 'ownership/x',
        pr_attempts: 2,
        pr_last_error: null,
      }),
    );

    const row = await knex('ownership_entities')
      .where({ id: entity.id })
      .first();
    expect(row).toMatchObject({
      pr_status: 'raised',
      pr_url: 'https://repo/pr/1',
      pr_branch: 'ownership/x',
      pr_attempts: 2,
      version: 4,
      current_status: 'accepted',
    });
  });

  it('getEntityByIdForUpdate returns the row (and undefined for an unknown id)', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex);

    const [found, missing] = await store.withTransaction(async tx => [
      await tx.entityStore.getEntityByIdForUpdate(entity.id),
      await tx.entityStore.getEntityByIdForUpdate(
        '00000000-0000-0000-0000-000000000000',
      ),
    ]);

    expect(found?.id).toBe(entity.id);
    expect(missing).toBeUndefined();
  });
});

describe('PendingDeadlineStore — type filters and leasing', () => {
  it('findExpiredDeadlines filters by types / excludeTypes', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex);
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: T0,
    });
    await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'grace_expiry',
      fire_at: T0,
    });

    const prOnly = await store.findExpiredDeadlines(later(1), {
      types: ['pr_creation'],
    });
    const notPr = await store.findExpiredDeadlines(later(1), {
      excludeTypes: ['pr_creation'],
    });
    const all = await store.findExpiredDeadlines(later(1));

    expect(prOnly.map(d => d.deadline_type)).toEqual(['pr_creation']);
    expect(notPr.map(d => d.deadline_type)).toEqual(['grace_expiry']);
    expect(all).toHaveLength(2);
  });

  it('leaseDeadline pushes fire_at forward without marking processed, and only for due rows', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex);
    const due = await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: T0,
    });
    const future = await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: later(60_000),
    });
    const leaseUntil = later(15 * 60_000);

    const [leased, notDue, again] = await store.withTransaction(async tx => [
      await tx.pendingDeadlineStore.leaseDeadline(due.id, later(1), leaseUntil),
      await tx.pendingDeadlineStore.leaseDeadline(
        future.id,
        later(1),
        leaseUntil,
      ),
      // Already leased → no longer due at `later(1)`.
      await tx.pendingDeadlineStore.leaseDeadline(due.id, later(1), leaseUntil),
    ]);

    expect(leased).toMatchObject({ id: due.id });
    expect(notDue).toBeUndefined();
    expect(again).toBeUndefined();
    const row = await knex('pending_deadlines').where({ id: due.id }).first();
    expect(Boolean(row.processed)).toBe(false);
    expect(new Date(row.fire_at).getTime()).toBe(leaseUntil.getTime());
    // Not picked up by a sweep while the lease is live; picked up after it.
    expect(
      await store.findExpiredDeadlines(later(60_000), {
        types: ['pr_creation'],
      }),
    ).toHaveLength(1);
    expect(
      await store.findExpiredDeadlines(leaseUntil, { types: ['pr_creation'] }),
    ).toHaveLength(2);
  });

  it('isLeaseHeld / completeLease only succeed for the run that holds the lease', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex);
    const d = await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: T0,
    });
    const leaseUntil = later(15 * 60_000);
    await store.withTransaction(tx =>
      tx.pendingDeadlineStore.leaseDeadline(d.id, later(1), leaseUntil),
    );

    const result = await store.withTransaction(async tx => ({
      heldByOther: await tx.pendingDeadlineStore.isLeaseHeld(d.id, later(5)),
      held: await tx.pendingDeadlineStore.isLeaseHeld(d.id, leaseUntil),
      completeByOther: await tx.pendingDeadlineStore.completeLease(
        d.id,
        later(5),
        later(2),
      ),
      complete: await tx.pendingDeadlineStore.completeLease(
        d.id,
        leaseUntil,
        later(2),
      ),
      completeTwice: await tx.pendingDeadlineStore.completeLease(
        d.id,
        leaseUntil,
        later(3),
      ),
      heldAfter: await tx.pendingDeadlineStore.isLeaseHeld(d.id, leaseUntil),
    }));

    expect(result).toEqual({
      heldByOther: false,
      held: true,
      completeByOther: false,
      complete: true,
      completeTwice: false,
      heldAfter: false,
    });
    expect(
      Boolean(
        (await knex('pending_deadlines').where({ id: d.id }).first()).processed,
      ),
    ).toBe(true);
  });

  it('a cancelled lease cannot be completed', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex);
    const d = await seedDeadlineRow(knex, entity.id, {
      deadline_type: 'pr_creation',
      fire_at: T0,
    });
    const leaseUntil = later(15 * 60_000);
    await store.withTransaction(tx =>
      tx.pendingDeadlineStore.leaseDeadline(d.id, later(1), leaseUntil),
    );

    const completed = await store.withTransaction(async tx => {
      await tx.pendingDeadlineStore.lockUnprocessedForEntity(entity.id, [
        'pr_creation',
      ]);
      await tx.pendingDeadlineStore.cancelDeadlinesForEntity(entity.id, [
        'pr_creation',
      ]);
      return tx.pendingDeadlineStore.completeLease(d.id, leaseUntil, later(2));
    });

    expect(completed).toBe(false);
  });
});

describe('EntityStore — PR reconciliation', () => {
  it('updatePrStateIf only writes while pr_status is still the expected one', async () => {
    const { knex, store } = await setup();
    const entity = await seedEntityRow(knex, {
      current_status: 'accepted',
      pr_status: 'raised',
    });

    const stale = await store.withTransaction(tx =>
      tx.entityStore.updatePrStateIf(entity.id, 'pending', {
        pr_status: 'completed',
      }),
    );
    const applied = await store.withTransaction(tx =>
      tx.entityStore.updatePrStateIf(entity.id, 'raised', {
        pr_status: 'completed',
      }),
    );

    expect({ stale, applied }).toEqual({ stale: false, applied: true });
    expect(
      (await knex('ownership_entities').where({ id: entity.id }).first())
        .pr_status,
    ).toBe('completed');
  });

  it('countPrStatusesForAccepted counts accepted and ownership_changed cases only', async () => {
    const { knex, store } = await setup();
    const acceptedAt = T0;
    await seedEntityRow(knex, {
      current_status: 'accepted',
      accepted_at: acceptedAt,
      pr_status: 'completed',
    });
    await seedEntityRow(knex, {
      current_status: 'accepted',
      accepted_at: acceptedAt,
      pr_status: 'raised',
    });
    await seedEntityRow(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
      accepted_at: acceptedAt,
      pr_status: 'completed',
    });
    // Never accepted, or closed for another reason: not part of the KPI.
    await seedEntityRow(knex, {
      current_status: 'closed',
      resolution_type: 'ownership_changed',
    });
    await seedEntityRow(knex, {
      current_status: 'closed',
      resolution_type: 'archived',
      accepted_at: acceptedAt,
    });

    await expect(store.countPrStatusesForAccepted()).resolves.toEqual({
      completed: 2,
      raised: 1,
    });
  });
});
