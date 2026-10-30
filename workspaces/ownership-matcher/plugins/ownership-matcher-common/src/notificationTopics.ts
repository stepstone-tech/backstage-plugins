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

export const OWNERSHIP_MATCHER_ORIGIN = 'plugin:ownership-matcher' as const;

export const ownershipMatcherOriginName: Record<string, string> = {
  [OWNERSHIP_MATCHER_ORIGIN]: 'Ownership Matcher',
};

export const ownershipMatcherTopicNames: Record<string, string> = {
  'ownership-matcher.proposals.batch-ready': 'New proposals digest',
  'ownership-matcher.proposal.reminder-due': 'Pending proposal reminder',
  'ownership-matcher.proposal.expired': 'Proposal expired',
  'ownership-matcher.acceptance.pending': 'Spec owner update reminder',
  'ownership-matcher.grace.warning': 'Grace period ending soon',
};
