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

import { ProposalGenerationService } from '../../service/ProposalGenerationService';

/**
 * Tiny mock of {@link ProposalGenerationService} suitable for unit tests
 * that build {@link EscalationService} directly. The retrigger path
 * consults `generateProposalsForEntity` to decide whether
 * to enter the "team-level proposals regenerated → entity → open" branch
 * or fall through to BFS rebuild.
 *
 * Default behaviour returns `0` (no new proposals), which keeps the
 * pre-existing BFS-rebuild path active. Tests that exercise the new
 * proposal path can override `generateProposalsForEntity` directly on the
 * returned mock.
 */
export function createMockProposalGen(
  overrides: Partial<ProposalGenerationService> = {},
): jest.Mocked<ProposalGenerationService> {
  return {
    generateProposalsForEntity: jest.fn().mockResolvedValue(0),
    generateProposals: jest.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as jest.Mocked<ProposalGenerationService>;
}
