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

import { EscalationTrigger } from '../escalation/EscalationTrigger';

/** Returns a jest.fn-backed {@link EscalationTrigger} stub for tests that don't need real escalation behaviour but must satisfy the new constructor arg on {@link import('../service/EntityProcessingServic */
export function createMockEscalationTrigger(): jest.Mocked<EscalationTrigger> {
  return {
    triggerEscalation: jest.fn().mockResolvedValue(undefined),
  } as jest.Mocked<EscalationTrigger>;
}
