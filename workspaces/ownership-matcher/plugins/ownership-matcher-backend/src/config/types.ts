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

import { EntityFilters } from '../types';
import {
  EscalationConfig,
  EscalationLevelConfig,
  ScheduleConfig,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

// Re-exported from the node library.
export type { ScheduleConfig, EscalationLevelConfig, EscalationConfig };

// ─── Check config ─────────────────────────────────────────────────────────────

export interface OrphanedCheckConfig {
  /** Owner values treated as "no real owner". */
  placeholderValues: string[];
}

export interface ChecksConfig {
  /** Which check names are enabled. */
  enabled: string[];
  orphaned: OrphanedCheckConfig;
}

// ─── Owners config ────────────────────────────────────────────────────────────

export interface OwnersConfig {
  /**
   * When true, entities owned by a User are never flagged by the zombie check.
   * When false, a User owner is valid only if it exists in the catalog.
   */
  excludeUserKind: boolean;
}

// ─── Strategy config ──────────────────────────────────────────────────────────

export type FallbackAction = 'escalated' | 'fixed-owner';

export interface StrategyConfig {
  name: string;
  /** Relative weight used in weighted scoring. */
  weight?: number;
  maxCandidates?: number;
  commitsLimit?: number;
  /** Only for fallback strategy */
  action?: FallbackAction;
  /** Only when action === 'fixed-owner' */
  owner?: string;
}

// ─── Confidence tiers ────────────────────────────────────────────────────────

export interface ConfidenceTiersConfig {
  /** Score above which confidence is "high". */
  high: number;
  /** Score above which confidence is "medium". */
  medium: number;
}

// ─── Proposal config ──────────────────────────────────────────────────────────

export interface ProposalsConfig {
  maxCandidatesPerEntity: number;
  /** When false (default), proposals remain open indefinitely — no proposal_expiry deadline is written. */
  autoExpiry: boolean;
  expirationDays: number;
  /** Overrides expirationDays for testing — sets expiry in minutes instead of days. */
  expirationMinutes?: number;
  /** Candidates below this score are dropped (except the top one). */
  minimumScoreThreshold: number;
  /**
   * Candidates scoring at or above this become active proposals and the team is
   * notified. Candidates below it are stored as `possible_owner` and not
   * notified — surfaced in the UI for voluntary claiming. Default 0.4.
   */
  notificationThreshold: number;
  confidenceTiers: ConfidenceTiersConfig;
  strategies: StrategyConfig[];
}

// ─── Contributor config ───────────────────────────────────────────────────────

export interface ContributorsConfig {
  excludeEmails: string[];
  excludePatterns: string[];
  excludeUsernames: string[];
}

// ─── Notifications config ─────────────────────────────────────────────────────

export interface NotificationsConfig {
  enabled: boolean;
  channels: string[];
  /** When false (default), the reminder scheduler task is not registered and no reminder notifications are sent. */
  remindersEnabled: boolean;
  reminderAfterDays: number;
  acceptancePendingReminderDays: number;
}

// ─── Catalog-info PR automation ──────────────────────────────────

export interface PrCreationConfig {
  /** Raise a `spec.owner` PR when a proposal is accepted. Defaults to true. */
  enabled: boolean;
  /** Attempts before automatic retries stop (manual retry stays available). Defaults to 5. */
  maxAttempts: number;
  /**
   * Catalog refresh lag allowed after a PR is merged before a catalog owner
   * that still differs is flagged as `failed`. Defaults to 24.
   */
  mergeGraceHours: number;
}

// ─── Ownership email config ───────────────────────────────────────────────────

/**
 * Digest settings owned by core. Transport settings (credentials, sender
 * mailbox) belong to the email sender module, e.g. `email.msgraph`.
 */
export interface OwnershipEmailConfig {
  /**
   * When true, write emails to the temp dir and log them instead of sending.
   * Works without a sender module. Defaults to false.
   */
  dryRun?: boolean;
  /** Optional help/support link rendered in the digest (e.g. an issue tracker). */
  supportUrl?: string;
  /** How often the digest scheduler runs. Idempotency is enforced per period key (YYYY-MM or YYYY-WW), not per scheduler tick. */
  schedule: ScheduleConfig;
}

// ─── Top-level plugin config ──────────────────────────────────────────────────

export interface OwnershipMatcherConfig {
  schedule: ScheduleConfig;
  filters: EntityFilters;
  checks: ChecksConfig;
  owners: OwnersConfig;
  proposals: ProposalsConfig;
  contributors: ContributorsConfig;
  /** Escalation config is read separately via `readEscalationConfig` and is not part of the top-level config. */
  notifications: NotificationsConfig;
  /**
   * Whether `?asUser=` may override the caller's identity on `/leadership/*`.
   * Local-development aid, off unless explicitly configured — see
   * `ownershipMatcher.dangerouslyAllowAsUserOverride`.
   */
  dangerouslyAllowAsUserOverride: boolean;
}
