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

import { InfoCard } from '@backstage/core-components';
import { Chip, Typography, Box } from '@material-ui/core';
import {
  Timeline as MuiTimeline,
  TimelineItem,
  TimelineConnector,
  TimelineContent,
  TimelineDot,
  TimelineOppositeContent,
  TimelineSeparator,
} from '@material-ui/lab';
import WarningIcon from '@material-ui/icons/Warning';
import GroupAddIcon from '@material-ui/icons/GroupAdd';
import NotificationsIcon from '@material-ui/icons/Notifications';
import CheckIcon from '@material-ui/icons/Check';
import CancelIcon from '@material-ui/icons/Cancel';
import HourglassEmptyIcon from '@material-ui/icons/HourglassEmpty';
import DoneAllIcon from '@material-ui/icons/DoneAll';
import TrendingUpIcon from '@material-ui/icons/TrendingUp';
import RefreshIcon from '@material-ui/icons/Refresh';
import ArchiveIcon from '@material-ui/icons/Archive';
import CheckCircleIcon from '@material-ui/icons/CheckCircle';
import FiberManualRecordIcon from '@material-ui/icons/FiberManualRecord';
import { OwnershipHistory } from '../../api';
import { displayRef } from '../../utils/entityRef';
import { renderHistoryDetails } from '../../utils/history';

/** Human-readable action label for history chip */
const ACTION_LABELS: Record<string, string> = {
  issue_detected: 'Issue Detected',
  issue_redetected: 'Re-detected',
  issue_auto_closed: 'Auto Closed',
  proposal_created: 'Proposal Created',
  proposal_notified: 'Notified',
  proposal_accepted: 'Proposal Accepted',
  proposal_rejected: 'Proposal Rejected',
  proposal_expired: 'Expired',
  escalation_triggered: 'Escalated',
  escalation_passed: 'Escalation Passed',
  entity_accepted: 'Case Resolved',
  entity_reopened: 'Reopened',
  reopened_candidates_found: 'Reopened, Candidates Found',
  entity_to_archive: 'Marked for Archive',
  entity_closed: 'Closed',
  status_changed: 'Status Changed',
  pr_creation_enqueued: 'PR Requested',
  pr_raised: 'PR Raised',
  pr_reused: 'PR Updated',
  pr_creation_failed: 'PR Failed',
  pr_creation_skipped: 'PR Skipped',
  pr_retry_requested: 'PR Retry',
  pr_completed: 'PR Completed',
  pr_superseded: 'PR Superseded',
  pr_declined: 'PR Declined',
  pr_not_applied: 'PR Not Applied',
};

type DotColor = 'primary' | 'secondary' | 'grey' | 'inherit';

function getTimelineEvent(action: string): {
  color: DotColor;
  dotStyle?: React.CSSProperties;
  icon: React.ReactElement;
} {
  const sz = { style: { fontSize: 14 } };
  switch (action) {
    case 'issue_detected':
      return {
        color: 'inherit',
        dotStyle: { background: '#d32f2f' },
        icon: <WarningIcon {...sz} />,
      };
    case 'issue_auto_closed':
      return { color: 'secondary', icon: <CheckCircleIcon {...sz} /> };
    case 'proposal_created':
      return { color: 'primary', icon: <GroupAddIcon {...sz} /> };
    case 'proposal_notified':
      return { color: 'primary', icon: <NotificationsIcon {...sz} /> };
    case 'proposal_accepted':
      return { color: 'secondary', icon: <CheckIcon {...sz} /> };
    case 'proposal_rejected':
      return { color: 'grey', icon: <CancelIcon {...sz} /> };
    case 'proposal_expired':
      return { color: 'grey', icon: <HourglassEmptyIcon {...sz} /> };
    case 'entity_accepted':
      return { color: 'secondary', icon: <DoneAllIcon {...sz} /> };
    case 'entity_reopened':
    case 'reopened_candidates_found':
      return { color: 'primary', icon: <RefreshIcon {...sz} /> };
    case 'entity_to_archive':
    case 'entity_closed':
      return { color: 'grey', icon: <ArchiveIcon {...sz} /> };
    case 'escalation_triggered':
      return {
        color: 'inherit',
        dotStyle: { background: '#e65100' },
        icon: <TrendingUpIcon {...sz} />,
      };
    case 'escalation_passed':
      return { color: 'primary', icon: <TrendingUpIcon {...sz} /> };
    default:
      return { color: 'grey', icon: <FiberManualRecordIcon {...sz} /> };
  }
}

/**
 * Audit timeline for an entity's ownership history. Lifted out of
 * `EntityDetailPage` as-is — still `@material-ui/lab`, pending BUI
 * conversion.
 */
export const Timeline = ({ history }: { history: OwnershipHistory[] }) => {
  const entries = history.filter(h => h.action !== 'issue_redetected');

  if (entries.length === 0) {
    return (
      <InfoCard title="History">
        <Box p={2}>
          <Typography>No history recorded.</Typography>
        </Box>
      </InfoCard>
    );
  }

  return (
    <InfoCard title="History">
      <MuiTimeline align="left">
        {entries.map((entry, idx) => {
          const { color, dotStyle, icon } = getTimelineEvent(entry.action);
          const details = renderHistoryDetails(
            entry.action,
            entry.details as any,
          );
          const date = new Date(entry.created_at);

          return (
            <TimelineItem key={entry.id}>
              <TimelineOppositeContent
                style={{
                  flex: '0 0 auto',
                  minWidth: 90,
                  textAlign: 'right',
                  paddingRight: 12,
                  paddingTop: 10,
                }}
              >
                <Typography
                  variant="caption"
                  color="textSecondary"
                  display="block"
                >
                  {date.toLocaleDateString()}
                </Typography>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  display="block"
                >
                  {date.toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Typography>
              </TimelineOppositeContent>
              <TimelineSeparator>
                <TimelineDot color={color} style={dotStyle}>
                  {icon}
                </TimelineDot>
                {idx < entries.length - 1 && <TimelineConnector />}
              </TimelineSeparator>
              <TimelineContent>
                <Box pb={2} pl={1}>
                  <Box
                    display="flex"
                    alignItems="center"
                    flexWrap="wrap"
                    style={{ gap: 8 }}
                  >
                    <Chip
                      label={ACTION_LABELS[entry.action] ?? entry.action}
                      size="small"
                      variant="outlined"
                    />
                    <Typography variant="caption" color="textSecondary">
                      {entry.actor ? displayRef(entry.actor) : 'system'}
                    </Typography>
                  </Box>
                  {details !== '—' && (
                    <Typography
                      variant="body2"
                      color="textSecondary"
                      style={{ marginTop: 4, wordBreak: 'break-word' }}
                    >
                      {details}
                    </Typography>
                  )}
                </Box>
              </TimelineContent>
            </TimelineItem>
          );
        })}
      </MuiTimeline>
    </InfoCard>
  );
};
