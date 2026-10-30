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

/** Public surface of the escalation feature module. */

export { type Clock, SystemClock } from './Clock';

export type {
  EscalationQueueEntryRow,
  EscalationQueueEntryStatus,
  PendingDeadlineRow,
  DeadlineType,
  EscalationLevelRef,
  AssignResult,
  ArchiveResult,
  RejectResult,
  SuggestResult,
  RetriggerResult,
} from './types';

export {
  escalationRejectSchema,
  escalationAssignSchema,
  escalationArchiveSchema,
  escalationSuggestSchema,
  escalationRetriggerSchema,
  proposalRejectSchema,
} from './schemas';

export {
  DefaultEscalationService,
  type EscalationService,
} from './EscalationService';

export {
  DefaultDeadlineCheckerService,
  type DeadlineCheckerService,
  type WriteDeadlineOptions,
} from './DeadlineCheckerService';

export type {
  CatalogServiceExtensions,
  CatalogGroupSummary,
  CatalogGroupMember,
  GroupFilter,
  HierarchyDirection,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

export { createEscalationRouter, type EscalationRouterDeps } from './router';

export {
  type EscalationTrigger,
  LazyEscalationTrigger,
  FallbackEscalationTrigger,
} from './EscalationTrigger';
