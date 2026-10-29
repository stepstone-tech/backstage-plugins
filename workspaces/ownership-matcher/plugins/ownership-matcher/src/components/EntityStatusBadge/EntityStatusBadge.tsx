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

import {
  StatusOK,
  StatusError,
  StatusWarning,
} from '@backstage/core-components';

/**
 * Status indicator for an {@link OwnershipEntity}'s `current_status`.
 *
 * Consolidated from two slightly-diverged copies (`OwnershipMatcherPage` and
 * `EntityDetailPage`): the admin-table mapping is kept — `accepted` reads as
 * `StatusOK` and `unresolved` as `StatusError` — rather than the detail
 * page's `StatusPending`/`StatusAborted`, so the same status always renders
 * the same way everywhere.
 */
export const EntityStatusBadge = ({ status }: { status: string }) => {
  switch (status) {
    case 'open':
      return <StatusError>Open</StatusError>;
    case 'escalated':
      return <StatusWarning>Escalated</StatusWarning>;
    case 'accepted':
      return <StatusOK>Accepted</StatusOK>;
    case 'to_archive':
      return <StatusWarning>To Archive</StatusWarning>;
    case 'closed':
      return <StatusOK>Closed</StatusOK>;
    case 'unresolved':
      return <StatusError>Unresolved</StatusError>;
    default:
      return <>{status}</>;
  }
};
