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
 * In-memory store fixture for notification flow tests.
 * Implements the OwnershipStoreNotificationsSlice subset that the notification
 * code touches. Use createInMemoryStore to get a seeded instance with
 * jest.fn spies for assertion.
 */

import {
  OwnershipProposalRow,
  OwnershipHistoryRow,
  HistoryAction,
} from '../../../types';

export interface OwnershipStoreNotificationsSlice {
  getProposal(id: string): Promise<OwnershipProposalRow | undefined>;
  refreshNotifiedAt(id: string, notifiedAt: Date): Promise<void>;
  appendHistory(input: {
    entity_id: string;
    proposal_id?: string;
    action: HistoryAction;
    actor?: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  getLatestHistoryAction(
    entityId: string,
    action: HistoryAction,
  ): Promise<OwnershipHistoryRow | undefined>;
  listProposalsNeedingReminder(
    reminderAfterDays: number,
  ): Promise<OwnershipProposalRow[]>;
  listPendingProposalIdsForOwner(ownerRef: string): Promise<string[]>;
  getEntityById(entityId: string): Promise<{ entity_name: string } | undefined>;
}

export interface InMemoryStore extends OwnershipStoreNotificationsSlice {
  // Spy handles exposed for assertion
  getProposal: jest.Mock;
  refreshNotifiedAt: jest.Mock;
  appendHistory: jest.Mock;
  getLatestHistoryAction: jest.Mock;
  listProposalsNeedingReminder: jest.Mock;
  listPendingProposalIdsForOwner: jest.Mock;
  getEntityById: jest.Mock;
}

/**
 * Factory for a minimal in-memory store with jest.fn spies.
 * Seed `proposals` for getProposal lookups and override individual
 * mocks per test as needed.
 */
export function createInMemoryStore(
  proposals: Record<string, OwnershipProposalRow> = {},
  entities: Record<string, { entity_name: string }> = {},
  historyRows: OwnershipHistoryRow[] = [],
  reminderProposals: OwnershipProposalRow[] = [],
): InMemoryStore {
  const proposalMap = new Map(Object.entries(proposals));
  const entityMap = new Map(Object.entries(entities));

  return {
    getProposal: jest.fn(async (id: string) => proposalMap.get(id)),
    refreshNotifiedAt: jest.fn(async () => undefined),
    appendHistory: jest.fn(async () => undefined),
    getLatestHistoryAction: jest.fn(
      async (entityId: string, action: HistoryAction) =>
        historyRows.find(r => r.entity_id === entityId && r.action === action),
    ),
    listProposalsNeedingReminder: jest.fn(async () => reminderProposals),
    listPendingProposalIdsForOwner: jest.fn(async () => []),
    getEntityById: jest.fn(async (entityId: string) => entityMap.get(entityId)),
  };
}
