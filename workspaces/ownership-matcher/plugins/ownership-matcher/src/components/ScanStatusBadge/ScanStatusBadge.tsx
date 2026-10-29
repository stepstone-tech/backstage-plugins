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
  StatusPending,
} from '@backstage/core-components';

/** Status indicator for an {@link OwnershipScan}'s `status`. */
export const ScanStatusBadge = ({ status }: { status: string }) => {
  switch (status) {
    case 'completed':
      return <StatusOK>Completed</StatusOK>;
    case 'running':
      return <StatusPending>Running</StatusPending>;
    case 'failed':
      return <StatusError>Failed</StatusError>;
    default:
      return <>{status}</>;
  }
};
