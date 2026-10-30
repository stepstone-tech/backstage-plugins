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

import {
  OwnershipMatcherApi,
  OwnershipEntity,
  OwnershipProposal,
  TeamProposalItem,
  DefinitionsResponse,
} from '../api';

export const TEAM_REF = 'group:default/team-a';

export function makeEntity(
  over: Partial<OwnershipEntity> = {},
): OwnershipEntity {
  return {
    id: 'entity-1',
    entity_ref: 'component:default/my-service',
    entity_name: 'my-service',
    entity_kind: 'Component',
    entity_namespace: 'default',
    current_owner: null,
    first_detected_at: '2026-01-01T00:00:00.000Z',
    last_scanned_at: '2026-01-02T00:00:00.000Z',
    current_status: 'open',
    current_check: 'orphaned',
    check_details: null,
    repo_url: null,
    resolved_at: null,
    resolved_by: null,
    resolution_type: null,
    assigned_to: null,
    ...over,
  };
}

export function makeProposal(
  over: Partial<OwnershipProposal> = {},
): OwnershipProposal {
  return {
    id: 'prop-1',
    entity_id: 'entity-1',
    proposed_owner_ref: TEAM_REF,
    proposed_owner_type: 'team',
    confidence_reason: '["top_contributor"]',
    confidence_score: 0.82,
    proposal_order: 1,
    status: 'possible_owner',
    escalation_level: 0,
    notified_at: null,
    responded_at: null,
    response_note: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

export function possibleOwnerItem(
  over: Partial<OwnershipProposal> = {},
): TeamProposalItem {
  return { proposal: makeProposal(over), entity: makeEntity(), actor: null };
}

export const DEFINITIONS: DefinitionsResponse = {
  signals: [
    {
      key: 'top_contributor',
      title: 'Top contributor by commit history',
      description: 'Your team has significant recent commit activity.',
    },
  ],
  checks: [{ key: 'orphaned', title: 'Orphaned', description: 'No owner.' }],
};

export type StatusedFetch = (
  teamRefs: string[],
  statuses?: string[],
) => Promise<{ items: TeamProposalItem[] }>;

export function createMockApi(opts: {
  forTeam: StatusedFetch;
  accept?: jest.Mock;
}): jest.Mocked<OwnershipMatcherApi> {
  return {
    listEntities: jest.fn(),
    listAllEntities: jest.fn(),
    getEntity: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
    triggerScan: jest.fn(),
    acceptProposal:
      opts.accept ?? jest.fn().mockResolvedValue({ status: 'accepted' }),
    rejectProposal: jest.fn(),
    escalationAssign: jest.fn(),
    escalationArchive: jest.fn(),
    listProposalsForTeam: jest.fn(opts.forTeam),
    getDefinitions: jest.fn().mockResolvedValue(DEFINITIONS),
    getDashboardStats: jest.fn(),
    listAllProposals: jest.fn(),
    listAllProposalsPaginated: jest.fn(),
    getMyPendingProposalsSummary: jest.fn(),
    getLeadershipStats: jest.fn().mockResolvedValue({
      isLeader: false,
      totalOpen: 0,
      perCheck: {},
      pendingProposals: 0,
      totalProposals: 0,
      avgConfidence: null,
    }),
    listLeadershipEntities: jest.fn(),
    listLeadershipProposals: jest.fn(),
    listAllLeadershipProposals: jest.fn(),
  } as any;
}

export const mockIdentityApi = {
  getBackstageIdentity: jest.fn().mockResolvedValue({
    userEntityRef: 'user:default/mock',
    ownershipEntityRefs: [TEAM_REF],
    type: 'user',
  }),
  getCredentials: jest.fn().mockResolvedValue({ token: 'tok' }),
  getProfileInfo: jest.fn().mockResolvedValue({}),
  signOut: jest.fn(),
};

// The page resolves which group refs are team-type via getEntitiesByRefs; the
// returned items are positionally aligned with the requested refs.
export const mockCatalogApi = {
  getEntitiesByRefs: jest.fn().mockResolvedValue({
    items: [{ kind: 'Group', spec: { type: 'team' } }],
  }),
};
