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

import type { CatalogComponent } from '../types';
import type { ScmRepoRef } from '../scm/types';

// ─── Checks ──────────────────────────────────────────────────────────────────

/** @public */
export interface OwnershipCheckContext {
  entity: CatalogComponent;
  liveGroupRegistry: Set<string>;
  /**
   * Live `user:<ns>/<name>` refs. Only populated when User owners are
   * validated (`ownershipMatcher.owners.excludeUserKind: false`).
   */
  liveUserRegistry?: Set<string>;
  orphanedPlaceholders: Set<string>;
}

/** @public */
export interface OwnershipCheckResult {
  failed: boolean;
  checkName: string;
  /** Human-readable explanation stored in check_details. */
  details?: Record<string, unknown>;
}

/** @public */
export interface OwnershipCheck {
  /** Unique name — used as current_check value and in priority ordering. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  run(ctx: OwnershipCheckContext): OwnershipCheckResult;
}

// ─── Proposal strategies ─────────────────────────────────────────────────────

/** @public */
export interface ProposalCandidate {
  ownerRef: string;
  confidenceScore: number;
  /** List of contributing signal names (e.g. */
  confidenceReason: string[];
}

/** @public */
export interface SignalDefinition {
  /** Key as it appears in the confidenceReason array (e.g. */
  key: string;
  title: string;
  description: string;
}

/** @public */
export interface ProposalStrategyContext {
  entity: CatalogComponent;
  /**
   * The entity's repository, resolved from `backstage.io/managed-by-location`
   * by the registered SCM provider. `undefined` when the location is missing
   * or no provider serves its host.
   */
  repo: ScmRepoRef | undefined;
  currentCheck: string;
  /** The owner ref at the time of detection (populated for zombie cases). */
  currentOwner: string | undefined;
  /** Actors who already rejected a proposal on this case — exclude them. */
  rejectedActors: Set<string>;
}

/** @public */
export interface ProposalStrategy {
  /** Unique name matching the config strategy name. */
  readonly name: string;
  /** Human-readable descriptions for each signal key this strategy emits in confidenceReason. */
  readonly signalDefinitions: SignalDefinition[];
  /** Returns candidates for this entity. */
  findCandidates(ctx: ProposalStrategyContext): Promise<ProposalCandidate[]>;
}
