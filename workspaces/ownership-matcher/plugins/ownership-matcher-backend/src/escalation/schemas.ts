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

import { z } from 'zod';

// fix F: every body schema in this file is `.strict` — extraneous
// fields are rejected with 400. specifies the exact body
// shape for each endpoint; surrendering to `.passthrough` would let
// unknown fields through and silently drift the contract. Consistency
// across all five schemas closes the ambiguity flagged in
// open-question #2.

/** Body schema for `POST /entities/:id/escalation/reject`. */
export const escalationRejectSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();

/** Body schema for `POST /entities/:id/escalation/assign`. */
export const escalationAssignSchema = z
  .object({
    ownerRef: z.string().min(1),
  })
  .strict();

/** Body schema for `POST /entities/:id/escalation/archive`. */
export const escalationArchiveSchema = z
  .object({
    assigneeRef: z.string().min(1),
  })
  .strict();

/** Body schema for `POST /entities/:id/escalation/suggest`. */
export const escalationSuggestSchema = z
  .object({
    suggestedOwnerRef: z
      .string()
      .regex(
        /^group:[a-z0-9-]+\/[a-z0-9-]+$/,
        'must be group:<namespace>/<name>',
      ),
    reason: z.string().min(1),
  })
  .strict();

/** Body schema for `POST /entities/:id/escalation/retrigger`. */
export const escalationRetriggerSchema = z.object({}).strict();

/** Body schema for `POST /proposals/:id/reject` (proposal-level). */
export const proposalRejectSchema = z
  .object({
    reason: z.string().min(1),
  })
  .strict();
