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
import {
  OwnershipProposalRow,
  ProposalStatus,
  PaginationOptions,
  PaginatedResult,
} from '../../types';
import { CreateProposalInput } from '../DatabaseOwnershipStore';

export class ProposalStore {
  constructor(private readonly db: Knex) {}

  async createProposal(input: CreateProposalInput): Promise<string> {
    const ownerType =
      input.proposed_owner_type ??
      (input.proposed_owner_ref.startsWith('group:') ? 'team' : 'user');

    const [row] = await this.db('ownership_proposals')
      .insert({
        entity_id: input.entity_id,
        proposed_owner_ref: input.proposed_owner_ref,
        proposed_owner_type: ownerType,
        confidence_reason: input.confidence_reason,
        confidence_score: input.confidence_score ?? null,
        proposal_order: input.proposal_order,
        status: input.status ?? 'pending',
        escalation_level: input.escalation_level ?? 0,
        created_at: new Date(),
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async getProposal(id: string): Promise<OwnershipProposalRow | undefined> {
    return this.db('ownership_proposals').where({ id }).first();
  }

  /**
   * Hard-deletes all `possible_owner` rows for an entity. Possible owners are
   * ephemeral, regenerated wholesale on every scan — clearing them before
   * regeneration keeps their scores fresh, prevents the duplicate rows that
   * would otherwise accumulate (they sit outside the active partial-unique
   * index), and lets a candidate move between possible_owner and active across
   * scans. `ownership_history.proposal_id` is `ON DELETE SET NULL`, so the
   * audit trail survives the delete. Returns the number of rows removed.
   */
  async deletePossibleOwnersByEntity(entityId: string): Promise<number> {
    return this.db('ownership_proposals')
      .where({ entity_id: entityId, status: 'possible_owner' })
      .del();
  }

  async listProposalsByEntity(
    entityId: string,
  ): Promise<OwnershipProposalRow[]> {
    return this.db('ownership_proposals')
      .where({ entity_id: entityId })
      .orderBy('proposal_order', 'asc');
  }

  async listActiveProposalsByEntity(
    entityId: string,
  ): Promise<OwnershipProposalRow[]> {
    // active+notified status now.
    return this.db('ownership_proposals')
      .where({ entity_id: entityId })
      .whereIn('status', ['pending'])
      .orderBy('proposal_order', 'asc');
  }

  /**
   * Proposals that are still "live" and should be cancelled when their parent
   * case is closed: `pending` (awaiting response),
   * `accepted` (committed but not yet acted on), and `possible_owner`
   * (low-confidence candidate awaiting voluntary claim). Excludes
   * already-terminal statuses (`rejected`/`expired`/`cancelled`). Used by
   * case-closing paths to avoid leaving a dangling proposal behind a closed
   * entity.
   */
  async listCancellableProposalsByEntity(
    entityId: string,
  ): Promise<OwnershipProposalRow[]> {
    return this.db('ownership_proposals')
      .where({ entity_id: entityId })
      .whereIn('status', ['pending', 'accepted', 'possible_owner'])
      .orderBy('proposal_order', 'asc');
  }

  async updateProposalStatus(
    id: string,
    status: ProposalStatus,
    extra?: {
      respondedAt?: Date | null;
      responseNote?: string | null;
      notifiedAt?: Date;
    },
  ): Promise<void> {
    await this.db('ownership_proposals')
      .where({ id })
      .update({
        status,
        ...(extra && 'respondedAt' in extra
          ? { responded_at: extra.respondedAt ?? null }
          : {}),
        ...(extra && 'responseNote' in extra
          ? { response_note: extra.responseNote ?? null }
          : {}),
        ...(extra?.notifiedAt ? { notified_at: extra.notifiedAt } : {}),
      });
  }

  // Used by the notifications subscriber on a successful send. Status stays
  // `pending` (the spec collapsed `pending` + `notified` into one status); only
  // the `notified_at` timestamp moves forward.
  async refreshNotifiedAt(id: string, notifiedAt: Date): Promise<void> {
    await this.db('ownership_proposals')
      .where({ id })
      .update({ notified_at: notifiedAt });
  }

  /** Returns proposals addressed to any of the given owner refs, optionally filtered by status. Only returns proposals whose parent entity is still active (not closed). */
  async listProposalsByOwners(
    ownerRefs: string[],
    statuses?: ProposalStatus[],
  ): Promise<OwnershipProposalRow[]> {
    let query = this.db('ownership_proposals')
      .join(
        'ownership_entities',
        'ownership_proposals.entity_id',
        'ownership_entities.id',
      )
      .whereNotIn('ownership_entities.current_status', ['closed'])
      .whereIn('ownership_proposals.proposed_owner_ref', ownerRefs)
      .select('ownership_proposals.*');
    if (statuses && statuses.length > 0) {
      query = query.whereIn('ownership_proposals.status', statuses);
    }
    return query.orderBy([
      {
        column: 'ownership_proposals.responded_at',
        order: 'desc',
        nulls: 'last',
      },
      { column: 'ownership_proposals.created_at', order: 'desc' },
    ]);
  }

  /** Returns ids of `pending` proposals addressed to the given owner ref, sorted ascending. */
  async listPendingProposalIdsForOwner(ownerRef: string): Promise<string[]> {
    const rows = await this.db('ownership_proposals')
      .where({ proposed_owner_ref: ownerRef, status: 'pending' })
      .orderBy('id', 'asc')
      .select('id');
    return rows.map(r => r.id);
  }

  async getStats(): Promise<{
    pendingProposals: number;
    avgConfidence: number | null;
    totalProposals: number;
    confidenceDistribution: Array<{
      label: string;
      min: number;
      max: number;
      count: number;
    }>;
  }> {
    // Only count proposals whose parent entity is still active. Without this
    // join, stale pending rows (e.g. siblings of an accepted proposal) inflate
    // the count above the number of open entities.
    const activeQuery = this.db('ownership_proposals')
      .join(
        'ownership_entities',
        'ownership_proposals.entity_id',
        'ownership_entities.id',
      )
      .whereIn('ownership_proposals.status', ['pending'])
      .whereIn('ownership_entities.current_status', [
        'open',
        'escalated',
        'to_archive',
      ]);

    const BUCKETS = [
      { label: '0–20%', min: 0, max: 0.2 },
      { label: '20–40%', min: 0.2, max: 0.4 },
      { label: '40–60%', min: 0.4, max: 0.6 },
      { label: '60–80%', min: 0.6, max: 0.8 },
      { label: '80–100%', min: 0.8, max: 1.001 },
    ];

    const [[countRow], [avgRow], [totalRow], distributionRows] =
      await Promise.all([
        activeQuery.clone().count('ownership_proposals.id as count'),
        activeQuery
          .clone()
          .whereNotNull('ownership_proposals.confidence_score')
          .avg('ownership_proposals.confidence_score as avg'),
        this.db('ownership_proposals').count('id as count'),
        // Count all proposals with a score per bucket (all statuses, all entities).
        Promise.all(
          BUCKETS.map(b =>
            this.db('ownership_proposals')
              .whereNotNull('confidence_score')
              .where('confidence_score', '>=', b.min)
              .where('confidence_score', '<', b.max)
              .count('id as count')
              .then(([row]) => ({
                ...b,
                count: Number((row as any)?.count ?? 0),
              })),
          ),
        ),
      ]);

    const avg = avgRow?.avg;
    return {
      pendingProposals: Number(countRow?.count ?? 0),
      avgConfidence: avg !== null && avg !== undefined ? Number(avg) : null,
      totalProposals: Number(totalRow?.count ?? 0),
      confidenceDistribution: distributionRows,
    };
  }

  async listAllProposals(
    pagination?: PaginationOptions,
    filter?: { status?: ProposalStatus[]; search?: string },
  ): Promise<PaginatedResult<OwnershipProposalRow>> {
    const page = pagination?.page ?? 1;
    const limit = pagination?.limit ?? 50;
    const offset = (page - 1) * limit;

    // Always join entities to exclude proposals whose case is fully closed.
    // `to_archive` and other active statuses are intentionally kept visible —
    // those entities are still on a live track. Without this join, config
    // narrowing (or any auto-resolve path) leaves stale `pending` rows in
    // the admin view after the case is closed.
    let query = this.db('ownership_proposals')
      .join(
        'ownership_entities',
        'ownership_proposals.entity_id',
        'ownership_entities.id',
      )
      .whereNotIn('ownership_entities.current_status', ['closed']);

    const search = filter?.search?.trim();
    if (search) {
      const s = search.toLowerCase();
      query = query.where(b =>
        b
          .whereRaw('LOWER(ownership_proposals.proposed_owner_ref) LIKE ?', [
            `%${s}%`,
          ])
          .orWhereRaw('LOWER(ownership_entities.entity_ref) LIKE ?', [`%${s}%`])
          .orWhereRaw('LOWER(ownership_entities.entity_name) LIKE ?', [
            `%${s}%`,
          ]),
      );
    }
    if (filter?.status?.length) {
      query = query.whereIn('ownership_proposals.status', filter.status);
    }

    const [{ count }] = await query
      .clone()
      .count('ownership_proposals.id as count');
    const items = await query
      .select('ownership_proposals.*')
      .orderBy('ownership_proposals.created_at', 'desc')
      .limit(limit)
      .offset(offset);
    return { items, total: Number(count), page, limit };
  }

  /** Returns proposals that should receive a reminder or first-time notification: pending proposals on active entities whose notified_at is older than reminderAfterDays, or whose created_at is older than 1 day (first-send retry). */
  async listProposalsNeedingReminder(
    reminderAfterDays: number,
  ): Promise<OwnershipProposalRow[]> {
    const reminderCutoff = new Date();
    reminderCutoff.setDate(reminderCutoff.getDate() - reminderAfterDays);

    const retryCutoff = new Date();
    retryCutoff.setDate(retryCutoff.getDate() - 1);

    return this.db('ownership_proposals')
      .join(
        'ownership_entities',
        'ownership_proposals.entity_id',
        'ownership_entities.id',
      )
      .whereIn('ownership_entities.current_status', [
        'open',
        'escalated',
        'unresolved',
        'to_archive',
      ])
      .where(qb => {
        qb.where(inner => {
          inner
            .where('ownership_proposals.status', 'pending')
            .andWhere('ownership_proposals.notified_at', '<', reminderCutoff);
        }).orWhere(inner => {
          inner
            .where('ownership_proposals.status', 'pending')
            .andWhere('ownership_proposals.created_at', '<', retryCutoff);
        });
      })
      .select('ownership_proposals.*')
      .orderBy('ownership_proposals.created_at', 'asc');
  }
}
