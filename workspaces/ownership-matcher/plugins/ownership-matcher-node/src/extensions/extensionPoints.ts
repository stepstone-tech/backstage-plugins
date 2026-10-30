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

import { createExtensionPoint } from '@backstage/backend-plugin-api';
import type { OwnershipCheck, ProposalStrategy } from './types';
import type { ScmProvider } from '../scm/types';
import type { OwnershipEmailSender } from '../notifications/types';

/** @public */
export interface OwnershipChecksExtensionPoint {
  addCheck(check: OwnershipCheck): void;
}

/**
 * Adds ownership checks to the ownership-matcher plugin.
 *
 * @public
 */
export const ownershipChecksExtensionPoint =
  createExtensionPoint<OwnershipChecksExtensionPoint>({
    id: 'ownership-matcher.checks',
  });

/** @public */
export interface OwnershipProposalStrategiesExtensionPoint {
  addStrategy(strategy: ProposalStrategy): void;
}

/**
 * Adds proposal strategies to the ownership-matcher plugin.
 *
 * @public
 */
export const ownershipProposalStrategiesExtensionPoint =
  createExtensionPoint<OwnershipProposalStrategiesExtensionPoint>({
    id: 'ownership-matcher.proposal-strategies',
  });

/** @public */
export interface OwnershipMatcherScmExtensionPoint {
  /**
   * Register a provider for one `ScmIntegration.type`. Registering a second
   * provider for the same type throws.
   */
  addProvider(provider: ScmProvider): void;
}

/**
 * Adds SCM providers (Bitbucket Server, GitLab, ...) to the ownership-matcher
 * plugin. Core routes each entity to the provider whose `type` matches the
 * integration serving its `managed-by-location` host.
 *
 * @public
 */
export const ownershipMatcherScmExtensionPoint =
  createExtensionPoint<OwnershipMatcherScmExtensionPoint>({
    id: 'ownership-matcher.scm',
  });

/** @public */
export interface OwnershipMatcherNotifierExtensionPoint {
  /**
   * Register the transport used by the ownership email digest. Only one
   * sender may be registered; a second call throws.
   */
  setEmailSender(sender: OwnershipEmailSender): void;
}

/**
 * Plugs a mail transport (MS Graph, SMTP, SES, ...) into the ownership-matcher
 * email digest. Without a sender the digest task isn't scheduled.
 *
 * @public
 */
export const ownershipMatcherNotifierExtensionPoint =
  createExtensionPoint<OwnershipMatcherNotifierExtensionPoint>({
    id: 'ownership-matcher.notifier',
  });
