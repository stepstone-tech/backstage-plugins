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

import { createApiRef } from '@backstage/core-plugin-api';
import {
  EntitiesListResponse,
  EntityDetailResponse,
  OwnershipEntity,
  ScansListResponse,
  OwnershipScan,
  ProposalActionResponse,
  TeamProposalsResponse,
  DefinitionsResponse,
  DashboardStats,
  AdminProposalsResponse,
  AdminProposalItem,
  MyPendingProposalsSummary,
  LeadershipStats,
  LeadershipProposalsResponse,
  LeadershipProposalItem,
} from './types';

export interface OwnershipMatcherApi {
  listEntities(params?: {
    status?: string;
    kind?: string;
    page?: number;
    limit?: number;
  }): Promise<EntitiesListResponse>;

  listAllEntities(params?: {
    status?: string;
    kind?: string;
  }): Promise<OwnershipEntity[]>;

  getEntity(id: string): Promise<EntityDetailResponse>;

  listScans(limit?: number): Promise<ScansListResponse>;

  getScan(id: string): Promise<{ scan: OwnershipScan }>;

  triggerScan(): Promise<{ status: string }>;

  acceptProposal(proposalId: string): Promise<ProposalActionResponse>;

  /** Re-enqueue a failed catalog-info PR for an accepted entity. */
  retryPrCreation(entityId: string): Promise<{ entity: OwnershipEntity }>;

  rejectProposal(
    proposalId: string,
    reason?: string,
  ): Promise<ProposalActionResponse>;

  escalationAssign(
    entityId: string,
    ownerRef: string,
  ): Promise<{ status: string }>;

  escalationArchive(
    entityId: string,
    assigneeRef: string,
  ): Promise<{ status: string }>;

  /**
   * Fetch proposals addressed to the given team(s).
   *
   * @param teamRefs - one or more group entity refs, e.g. ["group:default/my-team"]
   * @param statuses - optional filter; defaults to ["pending"] (actionable)
   */
  listProposalsForTeam(
    teamRefs: string[],
    statuses?: string[],
  ): Promise<TeamProposalsResponse>;

  getDefinitions(): Promise<DefinitionsResponse>;

  getDashboardStats(): Promise<DashboardStats>;

  listAllProposals(params?: {
    status?: string[];
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<AdminProposalsResponse>;

  listAllProposalsPaginated(params?: {
    status?: string[];
    search?: string;
  }): Promise<AdminProposalItem[]>;

  /**
   * Aggregate count of pending proposals addressed to any group the
   * authenticated user belongs to.
   */
  getMyPendingProposalsSummary(): Promise<MyPendingProposalsSummary>;

  /** Dashboard stats scoped to the current user's managed group subtree. */
  getLeadershipStats(): Promise<LeadershipStats>;

  /** Entities scoped to the current user's managed group subtree. */
  listLeadershipEntities(params?: {
    status?: string[];
    kind?: string;
    page?: number;
    limit?: number;
  }): Promise<EntitiesListResponse>;

  /** Proposals scoped to the current user's managed group subtree. */
  listLeadershipProposals(params?: {
    status?: string[];
    page?: number;
    limit?: number;
  }): Promise<LeadershipProposalsResponse>;

  /** Fetches all pages of leadership proposals and returns a flat array. */
  listAllLeadershipProposals(params?: {
    status?: string[];
  }): Promise<LeadershipProposalItem[]>;
}

export const ownershipMatcherApiRef = createApiRef<OwnershipMatcherApi>({
  id: 'plugin.ownership-matcher.service',
});
