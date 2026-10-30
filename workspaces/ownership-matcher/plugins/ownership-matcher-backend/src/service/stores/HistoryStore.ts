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
import { HistoryAction, OwnershipHistoryRow } from '../../types';
import { AppendHistoryInput } from '../DatabaseOwnershipStore';

export class HistoryStore {
  constructor(private readonly db: Knex) {}

  async appendHistory(input: AppendHistoryInput): Promise<void> {
    await this.db('ownership_history').insert({
      entity_id: input.entity_id,
      proposal_id: input.proposal_id ?? null,
      scan_id: input.scan_id ?? null,
      action: input.action,
      actor: input.actor ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
      created_at: new Date(),
    });
  }

  async listHistory(entityId: string): Promise<OwnershipHistoryRow[]> {
    return this.db('ownership_history')
      .where({ entity_id: entityId })
      .orderBy('created_at', 'asc');
  }

  async getLatestHistoryAction(
    entityId: string,
    action: HistoryAction,
  ): Promise<OwnershipHistoryRow | undefined> {
    return this.db('ownership_history')
      .where({ entity_id: entityId, action })
      .orderBy('created_at', 'desc')
      .first();
  }

  /** Latest row whose action is any of `actions` (matches on `action` only). */
  async getLatestHistoryActionIn(
    entityId: string,
    actions: readonly HistoryAction[],
  ): Promise<OwnershipHistoryRow | undefined> {
    return this.db('ownership_history')
      .where({ entity_id: entityId })
      .whereIn('action', [...actions])
      .orderBy('created_at', 'desc')
      .first();
  }

  async getRejectedActors(entityId: string): Promise<Set<string>> {
    const rows = await this.db('ownership_history')
      .join(
        'ownership_proposals',
        'ownership_history.proposal_id',
        'ownership_proposals.id',
      )
      .where('ownership_history.entity_id', entityId)
      .whereIn('ownership_history.action', [
        'proposal_rejected',
        'proposal_expired',
      ])
      .select('ownership_proposals.proposed_owner_ref');

    return new Set(rows.map((r: any) => r.proposed_owner_ref));
  }
}
