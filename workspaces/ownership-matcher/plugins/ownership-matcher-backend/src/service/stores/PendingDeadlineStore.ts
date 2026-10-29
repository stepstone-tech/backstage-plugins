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

import { Knex } from 'knex';
import { DeadlineType, PendingDeadlineRow } from '../../escalation/types';

/** Input for {@link PendingDeadlineStore.writeDeadline}. */
export interface WriteDeadlineInput {
  entity_id: string;
  proposal_id?: string | null;
  deadline_type: DeadlineType;
  fire_at: Date;
  actor_ref?: string | null;
  escalation_level?: number | null;
}

/** Deadline-type filter for {@link PendingDeadlineStore.findExpiredDeadlines}. */
export interface DeadlineTypeFilter {
  types?: DeadlineType[];
  excludeTypes?: DeadlineType[];
}

/** Persistence facade for the `pending_deadlines` table. */
export interface PendingDeadlineStore {
  /** Insert a deadline row for an entity. */
  writeDeadline(input: WriteDeadlineInput): Promise<string>;

  /**
   * Returns all unprocessed deadlines whose `fire_at <= now`.
   *
   * @param now - clock-controllable instant.
   * @param filter - optionally restrict to (`types`) or exclude (`excludeTypes`) deadline types.
   */
  findExpiredDeadlines(
    now: Date,
    filter?: DeadlineTypeFilter,
  ): Promise<PendingDeadlineRow[]>;

  /** Mark a deadline as processed. */
  markProcessed(id: string, processedAt: Date): Promise<void>;

  /** Atomic claim: flip `processed=false` → `processed=true` and return the row that was claimed, or `undefined` when the row was already processed (lost the race to another worker, idempotency). */
  claimDeadline(
    id: string,
    processedAt: Date,
  ): Promise<PendingDeadlineRow | undefined>;

  /**
   * Lease a due deadline for work done OUTSIDE a transaction: atomically push
   * `fire_at` to `leaseUntil` (leaving `processed=false`) and return the row,
   * or `undefined` if it is not due, already processed, or leased/locked by
   * another worker. The worker marks it processed together with its final
   * state write; if the worker dies first, the row becomes due again at
   * `leaseUntil` and is re-run — unlike {@link claimDeadline}, a crash after
   * the claim cannot strand the job.
   */
  leaseDeadline(
    id: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<PendingDeadlineRow | undefined>;

  /**
   * Complete a lease taken by {@link leaseDeadline}: mark the row processed
   * only if it is still unprocessed AND still carries this run's lease
   * (`fire_at === leaseUntil`). Returns `false` when the run no longer owns the
   * job — it was cancelled (retry / re-acceptance) or re-leased after expiry —
   * in which case the caller must not write any outcome.
   */
  completeLease(
    id: string,
    leaseUntil: Date,
    processedAt: Date,
  ): Promise<boolean>;

  /** Whether the run holding lease `leaseUntil` still owns deadline `id` (see {@link completeLease}). */
  isLeaseHeld(id: string, leaseUntil: Date): Promise<boolean>;

  /**
   * Row-lock (FOR UPDATE, waiting) the unprocessed deadlines of the given
   * types for an entity. Used to serialise against {@link leaseDeadline}
   * before cancelling them; take this BEFORE locking the entity row (same lock
   * order as the lease path).
   */
  lockUnprocessedForEntity(
    entityId: string,
    types: DeadlineType[],
  ): Promise<void>;

  /** Bulk-cancel unprocessed deadlines for an entity. */
  cancelDeadlinesForEntity(
    entityId: string,
    types?: DeadlineType[],
  ): Promise<number>;
}

/** Whether the Knex dialect can compile `SKIP LOCKED` (Postgres / MySQL 8; not SQLite). */
function supportsSkipLocked(db: Knex): boolean {
  const client = String(db.client.config.client ?? '');
  return !client.includes('sqlite');
}

/** Concrete Knex-backed implementation of {@link PendingDeadlineStore}. */
export class DefaultPendingDeadlineStore implements PendingDeadlineStore {
  constructor(private readonly db: Knex) {}

  /** {@inheritdoc PendingDeadlineStore.writeDeadline} */
  async writeDeadline(input: WriteDeadlineInput): Promise<string> {
    const [row] = await this.db('pending_deadlines')
      .insert({
        entity_id: input.entity_id,
        proposal_id: input.proposal_id ?? null,
        deadline_type: input.deadline_type,
        fire_at: input.fire_at,
        actor_ref: input.actor_ref ?? null,
        escalation_level: input.escalation_level ?? null,
        processed: false,
        created_at: new Date(),
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  /** {@inheritdoc PendingDeadlineStore.findExpiredDeadlines} */
  async findExpiredDeadlines(
    now: Date,
    filter?: DeadlineTypeFilter,
  ): Promise<PendingDeadlineRow[]> {
    let query = this.db('pending_deadlines')
      .where('processed', false)
      .andWhere('fire_at', '<=', now);
    if (filter?.types && filter.types.length > 0) {
      query = query.whereIn('deadline_type', filter.types);
    }
    if (filter?.excludeTypes && filter.excludeTypes.length > 0) {
      query = query.whereNotIn('deadline_type', filter.excludeTypes);
    }
    return query.orderBy('fire_at', 'asc');
  }

  /** {@inheritdoc PendingDeadlineStore.markProcessed} */
  async markProcessed(id: string, processedAt: Date): Promise<void> {
    // Idempotent: only flip if not already processed.
    await this.db('pending_deadlines')
      .where({ id })
      .andWhere('processed', false)
      .update({ processed: true, processed_at: processedAt });
  }

  /** {@inheritdoc PendingDeadlineStore.claimDeadline} */
  async claimDeadline(
    id: string,
    processedAt: Date,
  ): Promise<PendingDeadlineRow | undefined> {
    const rows = await this.db('pending_deadlines')
      .whereIn(
        'id',
        this.db('pending_deadlines')
          .select('id')
          .where({ id })
          .andWhere('processed', false)
          .forUpdate()
          .skipLocked(),
      )
      .update({ processed: true, processed_at: processedAt })
      .returning('*');
    return rows[0] as PendingDeadlineRow | undefined;
  }

  /** {@inheritdoc PendingDeadlineStore.leaseDeadline} */
  async leaseDeadline(
    id: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<PendingDeadlineRow | undefined> {
    const due = this.db('pending_deadlines')
      .select('id')
      .where({ id })
      .andWhere('processed', false)
      .andWhere('fire_at', '<=', now)
      .forUpdate();
    const rows = await this.db('pending_deadlines')
      // SQLite (single writer, no row locks) can't compile SKIP LOCKED; there
      // is nothing to skip there, so only add it where it exists (Postgres).
      .whereIn('id', supportsSkipLocked(this.db) ? due.skipLocked() : due)
      .update({ fire_at: leaseUntil })
      .returning('*');
    return rows[0] as PendingDeadlineRow | undefined;
  }

  /** {@inheritdoc PendingDeadlineStore.completeLease} */
  async completeLease(
    id: string,
    leaseUntil: Date,
    processedAt: Date,
  ): Promise<boolean> {
    const rows = await this.db('pending_deadlines')
      .where({ id, processed: false, fire_at: leaseUntil })
      .update({ processed: true, processed_at: processedAt });
    return rows > 0;
  }

  /** {@inheritdoc PendingDeadlineStore.isLeaseHeld} */
  async isLeaseHeld(id: string, leaseUntil: Date): Promise<boolean> {
    const row = await this.db('pending_deadlines')
      .where({ id, processed: false, fire_at: leaseUntil })
      .first('id');
    return Boolean(row);
  }

  /** {@inheritdoc PendingDeadlineStore.lockUnprocessedForEntity} */
  async lockUnprocessedForEntity(
    entityId: string,
    types: DeadlineType[],
  ): Promise<void> {
    await this.db('pending_deadlines')
      .select('id')
      .where({ entity_id: entityId, processed: false })
      .whereIn('deadline_type', types)
      .forUpdate();
  }

  /** {@inheritdoc PendingDeadlineStore.cancelDeadlinesForEntity} */
  async cancelDeadlinesForEntity(
    entityId: string,
    types?: DeadlineType[],
  ): Promise<number> {
    let query = this.db('pending_deadlines')
      .where({ entity_id: entityId })
      .andWhere('processed', false);
    if (types && types.length > 0) {
      query = query.whereIn('deadline_type', types);
    }
    return query.update({ processed: true, processed_at: new Date() });
  }
}
