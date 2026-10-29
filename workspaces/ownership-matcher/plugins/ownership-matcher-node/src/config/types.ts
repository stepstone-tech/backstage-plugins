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

import { SchedulerServiceTaskScheduleDefinition } from '@backstage/backend-plugin-api';

// ─── Schedule ─────────────────────────────────────────────────────────────────

export type ScheduleConfig = SchedulerServiceTaskScheduleDefinition;

// ─── Escalation config ────────────────────────────────────────────────────────

/** Shape of one entry in `escalation.levels`. */
export interface EscalationLevelConfig {
  /** `Kind:type`g */
  groupFilter: string;
  /** Days the system waits for this level's actor before auto-advancing. */
  timeoutDays: number;
  /** Regex strings matched against `metadata.userDetails.jobTitle` of direct members. */
  titlePatterns?: string[];
  /** Relation types (e.g. */
  relations?: string[];
  /** When true, resolve actor by walking team members' manager chains rather than domain group membership. */
  managerChain?: boolean;
}

/** Shape of the optional `escalation` block in `app-config.yaml`. */
export interface EscalationConfig {
  /** Required, non-empty. */
  levels: EscalationLevelConfig[];
  /** Optional list of entity refs notified when escalation exhausts or the circuit breaker fires. */
  fallbackActors?: string[];
  /** Grace period length applied to ALL stages. */
  gracePeriodDays?: number;
  /** Pre-expiry warning offset. */
  warningDays?: number;
  /** Re-decision window after grace failure. */
  reDecisionDays?: number;
}
