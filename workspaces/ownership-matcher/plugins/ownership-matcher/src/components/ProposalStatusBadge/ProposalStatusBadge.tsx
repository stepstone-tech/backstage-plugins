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
  StatusWarning,
} from '@backstage/core-components';
import { Chip, Tooltip } from '@material-ui/core';

const PROPOSAL_STATUS_DESCRIPTIONS: Record<string, string> = {
  pending: 'Sent to the team, awaiting their accept or reject decision.',
  accepted: 'The team accepted ownership of this entity.',
  rejected: 'The team declined — another candidate or escalation will follow.',
  expired: 'The team did not respond within the deadline.',
  cancelled: 'Superseded by a newer proposal or no longer applicable.',
};

/**
 * Status indicator for an {@link OwnershipProposal}'s `status`.
 *
 * Consolidated from three copies (`UserOwnershipPage`, `OwnershipMatcherPage`,
 * `EntityDetailPage`). The first two were identical, including the
 * description tooltip; `EntityDetailPage`'s copy had drifted to a bare
 * indicator with no tooltip. The tooltip-bearing version is kept.
 */
export const ProposalStatusBadge = ({ status }: { status: string }) => {
  const description = PROPOSAL_STATUS_DESCRIPTIONS[status];
  const indicator = (() => {
    switch (status) {
      case 'accepted':
        return <StatusOK>Accepted</StatusOK>;
      case 'rejected':
        return <StatusError>Rejected</StatusError>;
      case 'pending':
        return <StatusPending>Pending</StatusPending>;
      case 'expired':
        return <StatusWarning>Expired</StatusWarning>;
      default:
        return <Chip label={status} size="small" />;
    }
  })();
  if (!description) return indicator;
  return (
    <Tooltip title={description} arrow>
      <span>{indicator}</span>
    </Tooltip>
  );
};
