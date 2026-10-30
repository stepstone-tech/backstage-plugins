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

import { EscalationService } from '../EscalationService';

/**
 * Minimal stub of {@link EscalationService} sufficient for unit tests that
 * construct {@link DeadlineCheckerService} directly. made
 * the deadline checker delegate queue advancement to the escalation
 * service, so even tests that only exercise `cancelDeadlinesForEntity` /
 * `writeDeadline` still need to satisfy the constructor signature.
 *
 * Tests that exercise `processExpiredDeadlines` should pass a real
 * `EscalationService` (or a tighter mock that implements
 * `advanceQueue`) — the default here `jest.fn`s every method
 * so unexpected calls are visible in failure output.
 */
export function createMockEscalationService(
  overrides: Partial<EscalationService> = {},
): jest.Mocked<EscalationService> {
  return {
    triggerEscalation: jest.fn(),
    activateNextEntry: jest.fn(),
    advanceQueue: jest.fn().mockResolvedValue(null),
    buildBfsQueue: jest.fn().mockResolvedValue([]),
    revalidateQueue: jest.fn(),
    resolveActorForGroup: jest.fn(),
    resolveAllActorsForGroup: jest.fn(),
    escalationReject: jest.fn(),
    escalationAssign: jest.fn(),
    escalationArchive: jest.fn(),
    escalationSuggest: jest.fn(),
    escalationRetrigger: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<EscalationService>;
}
