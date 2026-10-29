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

/**
 * Node library for building ownership-matcher backend modules.
 *
 * @packageDocumentation
 */

// ── Catalog contract + impl ──────────────────────────────────────────────────
export type {
  CatalogServiceExtensions,
  CatalogGroupSummary,
  CatalogGroupMember,
  GroupFilter,
  HierarchyDirection,
} from './catalog/CatalogServiceExtensions';
export { CatalogService } from './catalog/CatalogService';
export { buildExcludeTypeSet, isTypeExcluded } from './catalog/typeFilter';

// ── Actor resolver ───────────────────────────────────────────────────────────
export {
  DefaultActorResolver,
  type ActorResolver,
  parseGroupFilter,
  matchesGroupFilter,
} from './catalog/ActorResolver';

// ── SCM provider contract ──────────────────────────────────────
export * from './scm';

// ── Extension points + check/strategy contracts ──────────────────────────────
export {
  ownershipChecksExtensionPoint,
  ownershipProposalStrategiesExtensionPoint,
  ownershipMatcherScmExtensionPoint,
  ownershipMatcherNotifierExtensionPoint,
  type OwnershipChecksExtensionPoint,
  type OwnershipProposalStrategiesExtensionPoint,
  type OwnershipMatcherScmExtensionPoint,
  type OwnershipMatcherNotifierExtensionPoint,
} from './extensions/extensionPoints';
export type { EmailMessage, OwnershipEmailSender } from './notifications/types';
export type {
  OwnershipCheck,
  OwnershipCheckContext,
  OwnershipCheckResult,
  ProposalCandidate,
  ProposalStrategy,
  ProposalStrategyContext,
  SignalDefinition,
} from './extensions/types';

// ── Escalation config ────────────────────────────────────────────────────────
export type {
  ScheduleConfig,
  EscalationLevelConfig,
  EscalationConfig,
} from './config/types';
export {
  readEscalationConfig,
  titlePatternsSchema,
  validateTitlePatterns,
} from './config/reader';
export {
  type CatalogConventions,
  DEFAULT_CATALOG_CONVENTIONS,
  readCatalogConventions,
  isManagerChainAvailable,
  warnIfManagerChainUnavailable,
} from './config/catalogConventions';

// ── Shared types ─────────────────────────────────────────────────────────────
export type {
  ComponentMetadata,
  CatalogComponent,
  CatalogUserDetail,
  EntityFilters,
} from './types';

// ── Utils ────────────────────────────────────────────────────────────────────
export {
  assertSafeUrl,
  normalizeGroupRef,
  isUserRef,
  normalizeUserRef,
  compileConfigRegex,
  testConfigRegex,
  MAX_REGEX_PATTERN_LENGTH,
  MAX_REGEX_INPUT_LENGTH,
} from './utils';
