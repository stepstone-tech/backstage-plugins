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

import { SchedulerServiceTaskScheduleDefinitionConfig } from '@backstage/backend-plugin-api';

export interface Config {
  ownershipMatcher?: {
    /**
     * How often the catalog scan runs. Default: every 24 hours, 30 min
     * timeout, 30 s initial delay.
     */
    schedule?: SchedulerServiceTaskScheduleDefinitionConfig;
    /** Which catalog entities the scan considers. */
    filters?: {
      /**
       * Entity kinds the scan skips. Setting it replaces the default rather
       * than extending it. Default `['User', 'Group', 'Location', 'Template']`.
       */
      excludeKinds?: string[];
      /**
       * Only scan entities carrying all of these annotations. Default `[]`.
       */
      requireAnnotations?: string[];
      /** Skip entities whose `spec.owner` is one of these refs. Default `[]`. */
      excludeOwners?: string[];
      /** Skip entities in these namespaces. Default `[]`. */
      excludeNamespaces?: string[];
      /**
       * Skip entities by kind and `spec.type`, each entry in `Kind:type` form
       * (case-insensitive), e.g. `Resource:cloud-account`. Open cases for
       * matching entities are closed as out of scope on the next scan.
       * Default `[]`.
       */
      excludeTypes?: string[];
    };
    /** Ownership checks run against each scanned entity. */
    checks?: {
      /**
       * Names of the checks to run: the built-ins `orphaned` and `zombie`, or
       * checks registered through the extension point. Default
       * `['orphaned', 'zombie']`.
       */
      enabled?: string[];
      orphaned?: {
        /**
         * `spec.owner` values treated as "no real owner" (case-insensitive).
         * Default `['unknown']`.
         */
        placeholderValues?: string[];
      };
    };
    /** How entity owners are validated. */
    owners?: {
      /**
       * Whether entities owned by a User (`user:<ns>/<name>`) are excluded
       * from the `zombie` check. `true` never flags User owners; `false`
       * flags a User owner only when that User no longer exists in the
       * catalog. Proposals always target groups either way. Default false.
       */
      excludeUserKind?: boolean;
    };
    /** Owner proposal generation. */
    proposals?: {
      /** Max candidates kept per entity per scan. Default 5. */
      maxCandidatesPerEntity?: number;
      /**
       * Give proposals an expiry deadline. `false` keeps them open
       * indefinitely. Default false.
       */
      autoExpiry?: boolean;
      /** Days until a proposal expires; only used with `autoExpiry`. Default 14. */
      expirationDays?: number;
      /**
       * Expiry in minutes, overriding `expirationDays`; only used with
       * `autoExpiry`. Meant for testing. Unset by default.
       */
      expirationMinutes?: number;
      /**
       * Candidates scoring below this are dropped, except the top one.
       * Default 0.
       */
      minimumScoreThreshold?: number;
      /**
       * Candidates scoring at or above this become active proposals and the
       * team is notified. Those below are stored as possible owners, shown in
       * the UI but not notified. In [0, 1] and at least
       * `minimumScoreThreshold`. Default 0.4.
       */
      notificationThreshold?: number;
      /**
       * Score thresholds for the confidence labels. Read but currently has no
       * effect.
       */
      confidenceTiers?: {
        /** Default 0.6. */
        high?: number;
        /** Default 0.3. */
        medium?: number;
      };
      /**
       * Proposal strategies, run in the declared order with their scores
       * weighted and summed. Built-ins: `top-contributor`, `org-proximity`,
       * `fallback`. Setting it replaces the default list:
       * top-contributor (weight 0.5, maxCandidates 3), org-proximity
       * (weight 0.3), fallback (action `escalated`).
       */
      strategies?: Array<{
        /** Strategy name. */
        name: string;
        /**
         * Weight in the scoring sum. Default 0.5 for top-contributor, 0.3 for
         * org-proximity, otherwise 1.
         */
        weight?: number;
        /** top-contributor only: max candidates returned. Default 3. */
        maxCandidates?: number;
        /** top-contributor only: commits of history to inspect. Default 25. */
        commitsLimit?: number;
        /**
         * fallback only: what happens when no strategy yields a candidate.
         * Default `escalated`.
         */
        action?: 'escalated' | 'fixed-owner';
        /** fallback only: owner ref proposed when `action` is `fixed-owner`. */
        owner?: string;
      }>;
    };
    /** Commit authors ignored by the top-contributor strategy. */
    contributors?: {
      /** Author emails to ignore. Default `[]`. */
      excludeEmails?: string[];
      /** Regexes matched against the author email. Default `[]`. */
      excludePatterns?: string[];
      /** Usernames to ignore. Default `[]`. */
      excludeUsernames?: string[];
    };
    /** Backstage notifications about proposals. */
    notifications?: {
      /**
       * Set to `false` to disable ownership notifications: the event
       * subscriber is not registered and the reminder task does nothing.
       * Default true.
       */
      enabled?: boolean;
      /**
       * Read but currently has no effect; notifications always go through
       * Backstage notifications. Default `['backstage']`.
       */
      channels?: string[];
      /**
       * Run the reminder task for pending proposals. Default false.
       */
      remindersEnabled?: boolean;
      /**
       * Days after the proposed owner was last notified before a reminder
       * is sent. Default 7.
       */
      reminderAfterDays?: number;
      /**
       * Minimum days between repeated notifications to the accepting team
       * for an acceptance-pending proposal. The first one is sent right
       * away. Default 7.
       */
      acceptancePendingReminderDays?: number;
    };
    /**
     * Escalation of unresolved cases up the group hierarchy. Omitted =
     * escalation disabled. Unknown keys are rejected at startup.
     */
    escalation?: {
      /**
       * Escalation levels, walked in the declared order (level 0, the team
       * proposal phase, is implicit). Non-empty.
       */
      levels: Array<{
        /** Group to resolve at this level, as `Kind` or `Kind:type`, e.g. `Group:department`. */
        groupFilter: string;
        /** Days the level's actor has before the case moves on. Positive integer. */
        timeoutDays: number;
        /**
         * Regexes matched against a user's `metadata.userDetails.jobTitle`.
         * Required, as `relations` is not implemented yet.
         */
        titlePatterns: string[];
        /**
         * Relation types to resolve actors through. Not implemented yet:
         * setting it is rejected at startup.
         */
        relations?: string[];
        /**
         * Resolve the actor by walking team members' manager chains instead
         * of group membership. Needs `catalog.annotations.userAlias` and
         * `catalog.annotations.manager`.
         */
        managerChain?: boolean;
      }>;
      /**
       * Group or user refs notified when escalation is exhausted, and allowed
       * to retrigger it. Unset = retriggering is unavailable.
       */
      fallbackActors?: string[];
      /** Days an actor has to act after assignment. Positive integer, default 14. */
      gracePeriodDays?: number;
      /**
       * Days before the grace period ends when a warning is sent. Positive
       * integer below `gracePeriodDays`, default 4.
       */
      warningDays?: number;
      /**
       * Re-decision window in days when the grace period ends with no next
       * actor. Positive integer, default 3.
       */
      reDecisionDays?: number;
    };
    /**
     * Organisation-specific catalog conventions. Every key is optional, and the
     * defaults suit a stock Backstage catalog.
     */
    catalog?: {
      annotations?: {
        /**
         * User annotation holding an alternative login (e.g. a directory
         * account name). When a commit email's local part doesn't match a
         * user name, it is matched against this annotation. Unset = alias
         * matching is off.
         */
        userAlias?: string;
        /**
         * User annotation holding the manager's alias (the value of the
         * manager's `userAlias` annotation). Needs `userAlias` as well.
         * Unset = escalation levels with `managerChain: true` resolve no
         * actors, and a warning is logged at startup.
         */
        manager?: string;
      };
      /**
       * `spec.type` values of Group entities treated as teams, i.e. groups
       * that can be proposed as owners. Non-empty; default `['team']`.
       * The frontend plugin reads it too.
       * @visibility frontend
       */
      teamGroupTypes?: string[];
    };
    /**
     * Ownership email digest. Omitted = digest disabled. Delivery needs an
     * email sender module (e.g. the msgraph-email module, configured under
     * `email.msgraph`) unless `dryRun` is true.
     */
    email?: {
      /**
       * Write emails to the OS temp dir and log them instead of sending.
       * Works without a sender module. Default false.
       */
      dryRun?: boolean;
      /**
       * How often the digest task runs. Each team gets at most one email per
       * period (month, or ISO week when the frequency uses days/hours).
       * Default: monthly, 30 min timeout, 5 min initial delay.
       */
      schedule?: SchedulerServiceTaskScheduleDefinitionConfig;
      /**
       * Help/support link (e.g. an issue tracker) rendered in the digest as a
       * "Need help?" paragraph. Must be an http(s) URL. Unset = the
       * paragraph is omitted.
       */
      supportUrl?: string;
    };
    /**
     * Automated catalog-info PRs after an ownership acceptance
     * and the reconciliation of their outcome. Omitted = enabled
     * with the defaults below.
     */
    prCreation?: {
      /**
       * Raise PRs and read their state from the SCM. `false` is a kill switch:
       * queued jobs stop, and outcome reconciliation compares with the catalog
       * only. Default `true`.
       */
      enabled?: boolean;
      /** Attempts per PR job before it stays `failed`. Positive integer, default 5. */
      maxAttempts?: number;
      /**
       * Hours a merged PR may take to show up in the catalog before the case
       * is marked `failed`. Non-negative, default 24.
       */
      mergeGraceHours?: number;
    };
    /**
     * SCM settings. Read credentials, hosts and API URLs come
     * from `integrations.*`; the SCM provider modules registered through
     * `ownershipMatcherScmExtensionPoint` handle each integration type.
     */
    scm?: {
      /** Per-host overrides, matched against the integration host. */
      hosts?: Array<{
        /** Integration host, e.g. `repo.example.com` or `gitlab.com`. */
        host: string;
        /**
         * Write-scoped token for branch, commit and PR creation. Providers
         * use only this token for writes; without it, PR automation is
         * refused for the host.
         * @visibility secret
         */
        writeToken?: string;
      }>;
    };
  };
}
