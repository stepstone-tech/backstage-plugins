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
import { EscalationQueueEntryRow } from '../../escalation/types';

/** Input for {@link EscalationQueueStore.insertEntry}. */
export interface InsertEscalationQueueEntryInput {
  entity_id: string;
  group_ref: string;
  /** 1-indexed level matching the configured `levels` array. */
  escalation_level: number;
  /** BFS position; new entries are inserted at the correct position. */
  position: number;
}

/** Persistence facade for the `escalation_queue_entries` table. */
export interface EscalationQueueStore {
  /** Insert a queued entry at the given BFS position. */
  insertEntry(input: InsertEscalationQueueEntryInput): Promise<string>;

  /** Returns all `queued` entries for the entity ordered by `position` ASC. */
  listQueuedEntries(entityId: string): Promise<EscalationQueueEntryRow[]>;

  /** Activate the next `queued` entry (lowest `position`) by transitioning it to `active` and recording `resolved_actor_ref`. */
  activateNextEntry(
    entityId: string,
    resolvedActorRef: string,
  ): Promise<EscalationQueueEntryRow | undefined>;

  /** Mark an entry as `cancelled` (queue terminal). */
  markEntryCancelled(id: string, reason: string): Promise<void>;

  /** Mark an entry as `skipped` (live group but no actor resolvable,). */
  markEntrySkipped(id: string, reason: string): Promise<void>;

  /** Mark an entry as `completed` (actor took action or timeout fired). */
  markEntryCompleted(id: string): Promise<void>;

  /** Returns the currently-active entry for an entity, if any. */
  findActiveEntry(
    entityId: string,
  ): Promise<EscalationQueueEntryRow | undefined>;

  /** Returns ALL entries (queued/active/completed/cancelled/skipped) for the entity ordered by `position` ASC. */
  listAllEntries(entityId: string): Promise<EscalationQueueEntryRow[]>;
}

/** Concrete Knex-backed implementation of {@link EscalationQueueStore}. */
export class DefaultEscalationQueueStore implements EscalationQueueStore {
  constructor(private readonly db: Knex) {}

  /** {@inheritdoc EscalationQueueStore.insertEntry} */
  async insertEntry(input: InsertEscalationQueueEntryInput): Promise<string> {
    const [row] = await this.db('escalation_queue_entries')
      .insert({
        entity_id: input.entity_id,
        group_ref: input.group_ref,
        escalation_level: input.escalation_level,
        position: input.position,
        status: 'queued',
        created_at: new Date(),
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  /** {@inheritdoc EscalationQueueStore.listQueuedEntries} */
  async listQueuedEntries(
    entityId: string,
  ): Promise<EscalationQueueEntryRow[]> {
    return this.db('escalation_queue_entries')
      .where({ entity_id: entityId, status: 'queued' })
      .orderBy('position', 'asc');
  }

  /** {@inheritdoc EscalationQueueStore.activateNextEntry} */
  async activateNextEntry(
    entityId: string,
    resolvedActorRef: string,
  ): Promise<EscalationQueueEntryRow | undefined> {
    // the UPDATE was a TOCTOU race. Two concurrent workers could both see
    // the same `queued` row, both UPDATE it, and the second `update` would
    // re-stamp `resolved_actor_ref`. Postgres-level safety: scope the
    // UPDATE to `id` AND `status='queued'`, and check the affected-rows
    // count to detect a lost race.
    const next = await this.db('escalation_queue_entries')
      .where({ entity_id: entityId, status: 'queued' })
      .orderBy('position', 'asc')
      .first();
    if (!next) return undefined;

    const rowsAffected = await this.db('escalation_queue_entries')
      .where({ id: next.id, status: 'queued' })
      .update({ status: 'active', resolved_actor_ref: resolvedActorRef });
    if (rowsAffected === 0) {
      // Another transaction won the race — no row to return; caller should
      // re-read or retry. Return `undefined` (the queue is "empty" from
      // this caller's perspective).
      return undefined;
    }

    return {
      ...next,
      status: 'active',
      resolved_actor_ref: resolvedActorRef,
    };
  }

  /** {@inheritdoc EscalationQueueStore.markEntryCancelled} */
  async markEntryCancelled(id: string, reason: string): Promise<void> {
    await this.db('escalation_queue_entries')
      .where({ id })
      .update({ status: 'cancelled', skip_reason: reason });
  }

  /** {@inheritdoc EscalationQueueStore.markEntrySkipped} */
  async markEntrySkipped(id: string, reason: string): Promise<void> {
    await this.db('escalation_queue_entries')
      .where({ id })
      .update({ status: 'skipped', skip_reason: reason });
  }

  /** {@inheritdoc EscalationQueueStore.markEntryCompleted} */
  async markEntryCompleted(id: string): Promise<void> {
    await this.db('escalation_queue_entries')
      .where({ id })
      .update({ status: 'completed' });
  }

  /** {@inheritdoc EscalationQueueStore.findActiveEntry} */
  async findActiveEntry(
    entityId: string,
  ): Promise<EscalationQueueEntryRow | undefined> {
    return this.db('escalation_queue_entries')
      .where({ entity_id: entityId, status: 'active' })
      .orderBy('position', 'desc')
      .first();
  }

  /** {@inheritdoc EscalationQueueStore.listAllEntries} */
  async listAllEntries(entityId: string): Promise<EscalationQueueEntryRow[]> {
    return this.db('escalation_queue_entries')
      .where({ entity_id: entityId })
      .orderBy('position', 'asc');
  }
}
