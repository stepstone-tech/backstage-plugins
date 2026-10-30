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

import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { OwnershipMatcherApi } from './ref';
import {
  EntitiesListResponse,
  OwnershipEntity,
  EntityDetailResponse,
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

export class OwnershipMatcherClient implements OwnershipMatcherApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('ownership-matcher');
  }

  private async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${await this.baseUrl()}${path}`;
    const resp = await this.fetchApi.fetch(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `Request failed: ${resp.status} ${resp.statusText}${
          text ? ` — ${text}` : ''
        }`,
      );
    }
    return resp.json();
  }

  async listEntities(params?: {
    status?: string;
    kind?: string;
    page?: number;
    limit?: number;
  }): Promise<EntitiesListResponse> {
    const query = new URLSearchParams();
    if (params?.status) query.set('status', params.status);
    if (params?.kind) query.set('kind', params.kind);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.fetch(`/entities${qs ? `?${qs}` : ''}`);
  }

  async listAllEntities(params?: {
    status?: string;
    kind?: string;
  }): Promise<OwnershipEntity[]> {
    // matches backend MAX_PAGE_LIMIT
    const PAGE_SIZE = 200;
    const first = await this.listEntities({
      ...params,
      page: 1,
      limit: PAGE_SIZE,
    });
    if (first.total <= first.items.length) {
      return first.items;
    }
    const totalPages = Math.ceil(first.total / PAGE_SIZE);
    const remaining = await Promise.all(
      Array.from({ length: totalPages - 1 }, (_, i) =>
        this.listEntities({ ...params, page: i + 2, limit: PAGE_SIZE }),
      ),
    );
    return remaining.reduce<OwnershipEntity[]>(
      (acc, page) => acc.concat(page.items),
      first.items.slice(),
    );
  }

  async getEntity(id: string): Promise<EntityDetailResponse> {
    return this.fetch(`/entities/${encodeURIComponent(id)}`);
  }

  async listScans(limit?: number): Promise<ScansListResponse> {
    const qs = limit ? `?limit=${limit}` : '';
    return this.fetch(`/scans${qs}`);
  }

  async getScan(id: string): Promise<{ scan: OwnershipScan }> {
    return this.fetch(`/scans/${encodeURIComponent(id)}`);
  }

  async triggerScan(): Promise<{ status: string }> {
    return this.fetch('/scans/trigger', { method: 'POST' });
  }

  async acceptProposal(proposalId: string): Promise<ProposalActionResponse> {
    return this.fetch(`/proposals/${encodeURIComponent(proposalId)}/accept`, {
      method: 'POST',
    });
  }

  async retryPrCreation(
    entityId: string,
  ): Promise<{ entity: OwnershipEntity }> {
    return this.fetch(`/entities/${encodeURIComponent(entityId)}/pr/retry`, {
      method: 'POST',
    });
  }

  async rejectProposal(
    proposalId: string,
    reason: string,
  ): Promise<ProposalActionResponse> {
    return this.fetch(`/proposals/${encodeURIComponent(proposalId)}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
  }

  async escalationAssign(
    entityId: string,
    ownerRef: string,
  ): Promise<{ status: string }> {
    return this.fetch(
      `/entities/${encodeURIComponent(entityId)}/escalation/assign`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerRef }),
      },
    );
  }

  async escalationArchive(
    entityId: string,
    assigneeRef: string,
  ): Promise<{ status: string }> {
    return this.fetch(
      `/entities/${encodeURIComponent(entityId)}/escalation/archive`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigneeRef }),
      },
    );
  }

  async listProposalsForTeam(
    teamRefs: string[],
    statuses?: string[],
  ): Promise<TeamProposalsResponse> {
    const query = new URLSearchParams();
    for (const ref of teamRefs) {
      query.append('teamRef', ref);
    }
    if (statuses?.length) {
      query.set('status', statuses.join(','));
    }
    return this.fetch(`/proposals/for-team?${query.toString()}`);
  }

  async getDefinitions(): Promise<DefinitionsResponse> {
    return this.fetch('/definitions');
  }

  async getDashboardStats(): Promise<DashboardStats> {
    return this.fetch('/stats');
  }

  async listAllProposals(params?: {
    status?: string[];
    page?: number;
    limit?: number;
    search?: string;
  }): Promise<AdminProposalsResponse> {
    const query = new URLSearchParams();
    if (params?.status?.length) query.set('status', params.status.join(','));
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.search) query.set('search', params.search);
    const qs = query.toString();
    return this.fetch(`/proposals${qs ? `?${qs}` : ''}`);
  }

  async listAllProposalsPaginated(params?: {
    status?: string[];
    search?: string;
  }): Promise<AdminProposalItem[]> {
    const PAGE_SIZE = 200;
    const first = await this.listAllProposals({
      ...params,
      page: 1,
      limit: PAGE_SIZE,
    });
    const items = [...first.items];
    const totalPages = Math.ceil(first.total / PAGE_SIZE);
    for (let page = 2; page <= totalPages; page++) {
      const res = await this.listAllProposals({
        ...params,
        page,
        limit: PAGE_SIZE,
      });
      items.push(...res.items);
    }
    return items;
  }

  async getMyPendingProposalsSummary(): Promise<MyPendingProposalsSummary> {
    return this.fetch('/proposals/mine/summary');
  }

  async getLeadershipStats(): Promise<LeadershipStats> {
    return this.fetch('/leadership/stats');
  }

  async listLeadershipEntities(params?: {
    status?: string[];
    kind?: string;
    page?: number;
    limit?: number;
  }): Promise<EntitiesListResponse> {
    const query = new URLSearchParams();
    for (const s of params?.status ?? []) query.append('status', s);
    if (params?.kind) query.set('kind', params.kind);
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.fetch(`/leadership/entities${qs ? `?${qs}` : ''}`);
  }

  async listLeadershipProposals(params?: {
    status?: string[];
    page?: number;
    limit?: number;
  }): Promise<LeadershipProposalsResponse> {
    const query = new URLSearchParams();
    if (params?.status?.length) query.set('status', params.status.join(','));
    if (params?.page) query.set('page', String(params.page));
    if (params?.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return this.fetch(`/leadership/proposals${qs ? `?${qs}` : ''}`);
  }

  async listAllLeadershipProposals(params?: {
    status?: string[];
  }): Promise<LeadershipProposalItem[]> {
    const PAGE_SIZE = 200;
    const first = await this.listLeadershipProposals({
      ...params,
      page: 1,
      limit: PAGE_SIZE,
    });
    const items = [...first.items];
    const totalPages = Math.ceil(first.total / PAGE_SIZE);
    for (let page = 2; page <= totalPages; page++) {
      const res = await this.listLeadershipProposals({
        ...params,
        page,
        limit: PAGE_SIZE,
      });
      items.push(...res.items);
    }
    return items;
  }
}
