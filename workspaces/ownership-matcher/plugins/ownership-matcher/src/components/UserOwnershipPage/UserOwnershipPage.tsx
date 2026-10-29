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

import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Header,
  Page,
  Content,
  StatusOK,
  StatusError,
  StatusWarning,
  Link,
  Table,
  TableColumn,
} from '@backstage/core-components';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import { usePermission } from '@backstage/plugin-permission-react';
import { useLeadershipStats } from '../../hooks/useLeadershipStats';
import { useDefinitions } from '../../hooks/useDefinitions';
import { useTeamProposals } from '../../hooks/useTeamProposals';
import { useSelectedTeam } from '../../hooks/useSelectedTeam';
import { useLeadershipProposals } from '../../hooks/useLeadershipProposals';
import { useLeadershipEntities } from '../../hooks/useLeadershipEntities';
import { useProposalMutations } from '../../hooks/useProposalMutations';
import { queryKeys } from '../../query/keys';
import {
  Tabs,
  Tab,
  Chip,
  Button,
  Box,
  Typography,
  TextField,
  Drawer,
  Divider,
  IconButton,
  Link as MuiLink,
  Tooltip,
} from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import CloseIcon from '@material-ui/icons/Close';
import CheckCircleOutlineIcon from '@material-ui/icons/CheckCircleOutline';
import BlockIcon from '@material-ui/icons/Block';
import {
  TeamProposalItem,
  DefinitionsResponse,
  OwnershipEntity,
  LeadershipProposalItem,
  PrStatus,
} from '../../api';
import { ownershipMatcherAdminPermission } from '../../permissions';
import {
  EntityDetailLink,
  OwnershipMatcherAdminPanel,
} from '../OwnershipMatcherPage/OwnershipMatcherPage';
import { PrStatusIndicator } from '../PrStatus/PrStatusIndicator';
import { usePrStatusPolling } from '../PrStatus/usePrStatusPolling';
import { useTeamGroupTypes } from '../../useTeamGroupTypes';
import {
  displayRef,
  displayGroupRef,
  displayActor,
} from '../../utils/entityRef';
import {
  parseSignalKeys,
  findSignal,
  findCheck,
  colorForCheck,
} from '../../utils/definitions';
import { ProposalStatusBadge } from '../ProposalStatusBadge/ProposalStatusBadge';
import { StatCard } from '../StatCard/StatCard';
import { CatalogEntityLink } from '../CatalogEntityLink/CatalogEntityLink';
import { TeamSelect } from '../TeamSelect/TeamSelect';
import { EmptyState } from '../EmptyState/EmptyState';

/** Shown after a successful accept/claim — PR creation runs in the background. */
const ACCEPT_SUCCESS_MESSAGE =
  'Ownership accepted — a pull request updating spec.owner in catalog-info.yaml is being raised.';

/** Catalog-info PR states that need the team's attention, with their card label. */
const PR_ATTENTION_LABELS: Partial<Record<PrStatus, string>> = {
  failed: 'Catalog-info pull request failed',
  unsupported_scm: 'Catalog-info pull request not supported',
  declined: 'Catalog-info pull request declined',
};

// ─── Styles ──────────────────────────────────────────────────────────────────

const useStyles = makeStyles(theme => ({
  reasonText: {
    maxWidth: 260,
    wordBreak: 'break-word',
  },
  badge: {
    marginLeft: theme.spacing(1),
  },
  // Card grid layout
  cardGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    padding: theme.spacing(0.5, 0),
  },
  cardListHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(2),
    paddingBottom: theme.spacing(1),
    borderBottom: `1px solid ${theme.palette.divider}`,
  },
  // Proposal cards
  proposalCard: {
    backgroundColor: theme.palette.background.paper,
    borderRadius: theme.shape.borderRadius,
    borderLeft: `4px solid ${theme.palette.divider}`,
    padding: theme.spacing(2, 2.5),
    cursor: 'pointer',
    transition: 'transform 120ms ease, box-shadow 120ms ease',
    boxShadow: theme.shadows[1],
    '&:hover': {
      transform: 'translateY(-2px)',
      boxShadow: theme.shadows[4],
    },
  },
  proposalCardHistory: {
    borderLeftColor: theme.palette.text.disabled,
    opacity: 0.92,
  },
  proposalCardAccepted: {
    borderLeftColor: '#10b981',
  },
  proposalCardRejected: {
    borderLeftColor: '#ef4444',
  },
  cardTopRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: theme.spacing(0.75),
  },
  cardMiddleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(0.75),
  },
  cardBottomRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
  },
  entityKindLabel: {
    fontSize: '0.75rem',
    color: theme.palette.text.disabled,
    flexShrink: 0,
  },
  issueChip: {
    fontSize: '0.7rem',
    height: 20,
    backgroundColor: theme.palette.action.hover,
    color: theme.palette.text.primary,
    border: `1px solid ${theme.palette.divider}`,
  },
  cardMetaStrip: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.75),
    flexWrap: 'wrap' as const,
    marginTop: theme.spacing(0.75),
  },
  cardMetaDot: {
    color: theme.palette.text.disabled,
    fontSize: '0.65rem',
    lineHeight: 1,
    userSelect: 'none' as const,
  },
  // Drawer
  drawerRoot: {
    width: 480,
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  drawerHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    padding: theme.spacing(2.5, 2.5, 1.5),
    flexShrink: 0,
  },
  drawerScrollBody: {
    flex: 1,
    overflowY: 'auto',
    padding: theme.spacing(0, 2.5, 2),
  },
  drawerSection: {
    marginBottom: theme.spacing(2.5),
  },
  drawerSectionLabel: {
    fontSize: '0.7rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(0.75),
  },
  drawerActions: {
    borderTop: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(2, 2.5),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1.5),
    flexShrink: 0,
  },
  actionGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  },
  actionCaption: {
    fontSize: '0.72rem',
    color: theme.palette.text.secondary,
    lineHeight: 1.4,
  },
  signalItem: {
    padding: theme.spacing(1, 1.5),
    borderRadius: theme.shape.borderRadius,
    backgroundColor: theme.palette.action.hover,
    marginBottom: theme.spacing(0.75),
  },
}));

// ─── Proposal Card (Pending) ──────────────────────────────────────────────────

function ProposalCard({
  item,
  definitions,
  onClick,
}: {
  item: TeamProposalItem;
  definitions: DefinitionsResponse;
  onClick: () => void;
}) {
  const classes = useStyles();
  const checkInfo = findCheck(definitions, item.entity.current_check);
  const checkColor = colorForCheck(item.entity.current_check);
  const ownerLabel = item.entity.current_owner
    ? displayGroupRef(item.entity.current_owner)
    : 'no owner';

  return (
    <div
      className={classes.proposalCard}
      style={{ borderLeftColor: checkColor.border }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      {/* Row 1: name + kind chip (left), issue chip (right) */}
      <div className={classes.cardTopRow}>
        <Box display="flex" alignItems="center" style={{ gap: 6, minWidth: 0 }}>
          <Typography
            variant="body1"
            style={{ fontWeight: 600, lineHeight: 1.3 }}
          >
            {item.entity.entity_name || item.entity.entity_ref}
          </Typography>
          <Typography
            variant="body1"
            component="span"
            className={classes.entityKindLabel}
          >
            {item.entity.entity_kind}
          </Typography>
        </Box>
        <Chip
          label={checkInfo.title}
          size="small"
          className={classes.issueChip}
          style={{
            flexShrink: 0,
            marginLeft: 8,
            backgroundColor: checkColor.chipBg,
            color: checkColor.chipText,
            border: `1px solid ${checkColor.chipBorder}`,
          }}
        />
      </div>
      {/* Row 2: dense meta strip */}
      <div className={classes.cardMetaStrip}>
        <Typography variant="caption" color="textSecondary">
          Owner: <strong style={{ fontWeight: 600 }}>{ownerLabel}</strong>
        </Typography>
        <span className={classes.cardMetaDot}>·</span>
        <Typography variant="caption" color="textSecondary">
          since {new Date(item.entity.first_detected_at).toLocaleDateString()}
        </Typography>
      </div>
    </div>
  );
}

// ─── History Card ─────────────────────────────────────────────────────────────

function HistoryCard({
  item,
  onClick,
}: {
  item: TeamProposalItem;
  onClick: () => void;
}) {
  const classes = useStyles();
  const isAccepted = item.proposal.status === 'accepted';
  const borderClass = isAccepted
    ? classes.proposalCardAccepted
    : classes.proposalCardRejected;
  const actorLabel = item.actor ? displayActor(item.actor) : null;

  return (
    <div
      className={`${classes.proposalCard} ${classes.proposalCardHistory} ${borderClass}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onClick()}
    >
      {/* Row 1: name + kind chip (left), decision badge (right) */}
      <div className={classes.cardTopRow}>
        <Box display="flex" alignItems="center" style={{ gap: 6, minWidth: 0 }}>
          <Typography
            variant="body1"
            style={{ fontWeight: 600, lineHeight: 1.3 }}
          >
            {item.entity.entity_name || item.entity.entity_ref}
          </Typography>
          <Typography
            variant="body1"
            component="span"
            className={classes.entityKindLabel}
          >
            {item.entity.entity_kind}
          </Typography>
        </Box>
        <Box style={{ flexShrink: 0, marginLeft: 8 }}>
          {isAccepted ? (
            <StatusOK>Accepted</StatusOK>
          ) : (
            <StatusError>Rejected</StatusError>
          )}
        </Box>
      </div>
      {/* Row 2: dense meta strip */}
      <div className={classes.cardMetaStrip}>
        {actorLabel && (
          <>
            <Typography variant="caption" color="textSecondary">
              by <strong style={{ fontWeight: 600 }}>{actorLabel}</strong>
            </Typography>
            <span className={classes.cardMetaDot}>·</span>
          </>
        )}
        {item.proposal.responded_at && (
          <Typography variant="caption" color="textSecondary">
            {new Date(item.proposal.responded_at).toLocaleDateString()}
          </Typography>
        )}
        {item.proposal.response_note && (
          <>
            <span className={classes.cardMetaDot}>·</span>
            <Typography
              variant="caption"
              color="textSecondary"
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                maxWidth: 260,
              }}
            >
              "{item.proposal.response_note}"
            </Typography>
          </>
        )}
      </div>
      {/* Row 3: the catalog-info PR needs attention */}
      {isAccepted &&
        item.entity.pr_status &&
        PR_ATTENTION_LABELS[item.entity.pr_status] && (
          <Box mt={0.5} title={item.entity.pr_last_error ?? undefined}>
            <Typography variant="caption" component="div">
              <StatusWarning>
                {PR_ATTENTION_LABELS[item.entity.pr_status]}
              </StatusWarning>
            </Typography>
          </Box>
        )}
    </div>
  );
}

// ─── Proposal Drawer (Pending) ────────────────────────────────────────────────

function ProposalDrawer({
  item,
  definitions,
  acting,
  onClose,
  onAccept,
  onReject,
}: {
  item: TeamProposalItem | null;
  definitions: DefinitionsResponse;
  acting: boolean;
  onClose: () => void;
  onAccept: (proposalId: string) => void;
  onReject: (proposalId: string, reason: string) => void;
}) {
  const classes = useStyles();
  const [rejectMode, setRejectMode] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  useEffect(() => {
    setRejectMode(false);
    setRejectReason('');
  }, [item?.proposal.id]);

  const signalKeys = item
    ? parseSignalKeys(item.proposal.confidence_reason)
    : [];
  const checkInfo = item
    ? findCheck(definitions, item.entity.current_check)
    : null;

  return (
    <Drawer anchor="right" open={item !== null} onClose={onClose}>
      <div className={classes.drawerRoot}>
        {rejectMode ? (
          <>
            {/* Reject view — full content swap */}
            <div className={classes.drawerHeader}>
              <Box flex={1} pr={1}>
                <Typography
                  variant="h6"
                  style={{ fontWeight: 700, lineHeight: 1.3 }}
                >
                  Reject proposal
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  {item?.entity.entity_name || item?.entity.entity_ref}
                </Typography>
              </Box>
              <IconButton
                size="small"
                onClick={() => setRejectMode(false)}
                aria-label="back"
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </div>
            <Divider />
            <div className={classes.drawerScrollBody}>
              <Box mt={3}>
                <Typography
                  variant="body2"
                  color="textSecondary"
                  style={{ marginBottom: 20 }}
                >
                  Explain why this entity doesn't belong to your team. This
                  helps teammates understand the decision and routes the
                  proposal to the next candidate.
                </Typography>
                <TextField
                  // Focus the only field of a dialog the user just opened.
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  label="Reason"
                  fullWidth
                  required
                  multiline
                  minRows={5}
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  variant="outlined"
                />
              </Box>
            </div>
            <div className={classes.drawerActions}>
              <Box display="flex" style={{ gap: 8 }}>
                <Button
                  variant="outlined"
                  fullWidth
                  disabled={acting}
                  onClick={() => setRejectMode(false)}
                >
                  Back
                </Button>
                <Button
                  variant="contained"
                  color="secondary"
                  fullWidth
                  disabled={acting || !rejectReason.trim()}
                  onClick={() =>
                    item && onReject(item.proposal.id, rejectReason)
                  }
                >
                  Confirm rejection
                </Button>
              </Box>
            </div>
          </>
        ) : (
          <>
            {/* Details view */}
            <div className={classes.drawerHeader}>
              <Box flex={1} pr={1}>
                <Typography
                  variant="h6"
                  style={{ fontWeight: 700, lineHeight: 1.3 }}
                >
                  {item?.entity.entity_name || item?.entity.entity_ref || ''}
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  Ownership proposal
                </Typography>
              </Box>
              <IconButton size="small" onClick={onClose} aria-label="close">
                <CloseIcon fontSize="small" />
              </IconButton>
            </div>
            <Divider />

            <div className={classes.drawerScrollBody}>
              {item && (
                <>
                  <Box mt={2.5} className={classes.drawerSection}>
                    <Typography className={classes.drawerSectionLabel}>
                      Entity
                    </Typography>
                    <Typography variant="body2">
                      <strong>
                        {item.entity.entity_name || item.entity.entity_ref}
                      </strong>
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      {item.entity.entity_kind}
                    </Typography>
                    <Box mt={0.5}>
                      <CatalogEntityLink
                        entityRef={item.entity.entity_ref}
                        label="View in catalog →"
                      />
                    </Box>
                    {item.entity.repo_url && (
                      <Box mt={0.5}>
                        <MuiLink
                          href={item.entity.repo_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          variant="caption"
                        >
                          Repository
                        </MuiLink>
                      </Box>
                    )}
                  </Box>

                  <Divider />

                  <Box mt={2} className={classes.drawerSection}>
                    <Typography className={classes.drawerSectionLabel}>
                      Issue
                    </Typography>
                    {checkInfo && (
                      <>
                        <Typography variant="body2">
                          <strong>{checkInfo.title}</strong>
                        </Typography>
                        {checkInfo.description && (
                          <Typography
                            variant="body2"
                            color="textSecondary"
                            style={{ marginTop: 4 }}
                          >
                            {checkInfo.description}
                          </Typography>
                        )}
                      </>
                    )}
                  </Box>

                  <Divider />

                  <Box mt={2} className={classes.drawerSection}>
                    <Typography className={classes.drawerSectionLabel}>
                      Why your team?
                    </Typography>
                    {signalKeys.length === 0 ? (
                      <Typography variant="body2" color="textSecondary">
                        No signal details available.
                      </Typography>
                    ) : (
                      signalKeys.map((key, i) => {
                        const info = findSignal(definitions, key);
                        return (
                          <div key={i} className={classes.signalItem}>
                            <Typography
                              variant="body2"
                              style={{ fontWeight: 600 }}
                            >
                              {info.title}
                            </Typography>
                            {info.description && (
                              <Typography
                                variant="caption"
                                color="textSecondary"
                              >
                                {info.description}
                              </Typography>
                            )}
                          </div>
                        );
                      })
                    )}
                  </Box>
                </>
              )}
            </div>

            {item && (
              <div className={classes.drawerActions}>
                <div className={classes.actionGroup}>
                  <Button
                    variant="contained"
                    color="primary"
                    fullWidth
                    disabled={acting}
                    startIcon={<CheckCircleOutlineIcon />}
                    onClick={() => onAccept(item.proposal.id)}
                  >
                    Accept ownership
                  </Button>
                  <Typography className={classes.actionCaption}>
                    Confirms your team owns this entity and will resolve the
                    issue. A pull request setting your team as owner in
                    catalog-info.yaml is raised automatically for you to review.
                  </Typography>
                </div>
                <div className={classes.actionGroup}>
                  <Button
                    variant="outlined"
                    color="secondary"
                    fullWidth
                    disabled={acting}
                    startIcon={<BlockIcon />}
                    onClick={() => setRejectMode(true)}
                  >
                    Reject proposal
                  </Button>
                  <Typography className={classes.actionCaption}>
                    Indicates this entity doesn't belong to your team.
                  </Typography>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Drawer>
  );
}

// ─── History Drawer ───────────────────────────────────────────────────────────

function HistoryDrawer({
  item,
  definitions,
  onClose,
  onPrChanged,
}: {
  item: TeamProposalItem | null;
  definitions: DefinitionsResponse;
  onClose: () => void;
  onPrChanged?: () => void;
}) {
  const classes = useStyles();

  const signalKeys = item
    ? parseSignalKeys(item.proposal.confidence_reason)
    : [];
  const checkInfo = item
    ? findCheck(definitions, item.entity.current_check)
    : null;
  const isAccepted = item?.proposal.status === 'accepted';

  return (
    <Drawer anchor="right" open={item !== null} onClose={onClose}>
      <div className={classes.drawerRoot}>
        {/* Header */}
        <div className={classes.drawerHeader}>
          <Box flex={1} pr={1}>
            <Typography
              variant="h6"
              style={{ fontWeight: 700, lineHeight: 1.3 }}
            >
              {item?.entity.entity_name || item?.entity.entity_ref || ''}
            </Typography>
            <Box display="flex" alignItems="center" mt={0.5} style={{ gap: 8 }}>
              {item &&
                (isAccepted ? (
                  <StatusOK>Accepted</StatusOK>
                ) : (
                  <StatusError>Rejected</StatusError>
                ))}
            </Box>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </div>
        <Divider />

        {/* Scrollable body */}
        <div className={classes.drawerScrollBody}>
          {item && (
            <>
              {/* Decision details */}
              <Box mt={2.5} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Decision
                </Typography>
                <Typography variant="body2">
                  <strong>{isAccepted ? 'Accepted' : 'Rejected'}</strong>
                  {item.actor && <> by {displayActor(item.actor)}</>}
                </Typography>
                {item.proposal.responded_at && (
                  <Typography variant="caption" color="textSecondary">
                    {new Date(item.proposal.responded_at).toLocaleString()}
                  </Typography>
                )}
              </Box>

              {/* Reason — only shown for rejections */}
              {!isAccepted && (
                <Box className={classes.drawerSection}>
                  <Typography className={classes.drawerSectionLabel}>
                    Reason
                  </Typography>
                  {item.proposal.response_note ? (
                    <Typography variant="body2">
                      "{item.proposal.response_note}"
                    </Typography>
                  ) : (
                    <Typography variant="body2" color="textSecondary">
                      No reason provided.
                    </Typography>
                  )}
                </Box>
              )}

              <Divider />

              {/* Entity */}
              <Box mt={2} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Entity
                </Typography>
                <Typography variant="body2">
                  <strong>
                    {item.entity.entity_name || item.entity.entity_ref}
                  </strong>
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  {item.entity.entity_kind}
                </Typography>
                <Box mt={0.5}>
                  <CatalogEntityLink
                    entityRef={item.entity.entity_ref}
                    label="View in catalog →"
                  />
                </Box>
                {isAccepted && (
                  <Box mt={1}>
                    <PrStatusIndicator
                      entity={item.entity}
                      onChanged={onPrChanged}
                    />
                  </Box>
                )}
                {/* Manual fallback only when no automated PR exists. */}
                {isAccepted &&
                  item.entity.repo_url &&
                  (!item.entity.pr_status ||
                    item.entity.pr_status === 'none' ||
                    item.entity.pr_status === 'failed' ||
                    item.entity.pr_status === 'declined' ||
                    item.entity.pr_status === 'unsupported_scm') && (
                    <Box mt={0.5}>
                      <MuiLink
                        href={item.entity.repo_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="caption"
                      >
                        Update ownership in repository
                      </MuiLink>
                    </Box>
                  )}
              </Box>

              <Divider />

              {/* Issue */}
              <Box mt={2} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Issue
                </Typography>
                {checkInfo && (
                  <>
                    <Typography variant="body2">
                      <strong>{checkInfo.title}</strong>
                    </Typography>
                    {checkInfo.description && (
                      <Typography
                        variant="body2"
                        color="textSecondary"
                        style={{ marginTop: 4 }}
                      >
                        {checkInfo.description}
                      </Typography>
                    )}
                  </>
                )}
              </Box>

              <Divider />

              {/* Why your team */}
              <Box mt={2} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Why was your team proposed?
                </Typography>
                {signalKeys.length === 0 ? (
                  <Typography variant="body2" color="textSecondary">
                    No signal details available.
                  </Typography>
                ) : (
                  signalKeys.map(key => {
                    const info = findSignal(definitions, key);
                    return (
                      <div key={key} className={classes.signalItem}>
                        <Typography variant="body2" style={{ fontWeight: 600 }}>
                          {info.title}
                        </Typography>
                        {info.description && (
                          <Typography variant="caption" color="textSecondary">
                            {info.description}
                          </Typography>
                        )}
                      </div>
                    );
                  })
                )}
              </Box>
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}

// ─── Pending Tab ─────────────────────────────────────────────────────────────

function PendingTab({
  teamRefs,
  onAccepted,
  definitions,
}: {
  teamRefs: string[];
  /** Called after a successful accept/claim — opens the decision in the History tab (PR status). */
  onAccepted: (proposalId: string) => void;
  definitions: DefinitionsResponse;
}) {
  const classes = useStyles();
  const toastApi = useApi(toastApiRef);
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data,
    isLoading: loading,
    error,
  } = useTeamProposals(teamRefs, ['pending']);
  const { accept, reject } = useProposalMutations();

  const proposalParam = searchParams.get('proposal');
  const items = data?.items ?? [];
  const drawerItem = proposalParam
    ? items.find(i => i.proposal.id === proposalParam) ?? null
    : null;

  const setDrawerItem = (item: TeamProposalItem | null) => {
    const next = new URLSearchParams(searchParams);
    if (item) {
      next.set('proposal', item.proposal.id);
    } else {
      next.delete('proposal');
    }
    setSearchParams(next, { replace: true });
  };

  const acting = accept.isPending || reject.isPending;

  const handleAccept = async (proposalId: string) => {
    try {
      await accept.mutateAsync(proposalId);
      toastApi.post({
        title: ACCEPT_SUCCESS_MESSAGE,
        status: 'success',
        timeout: 5000,
      });
      // Jump to the decision in History, where the PR status / link appears.
      onAccepted(proposalId);
    } catch (err) {
      toastApi.post({
        title: `Failed to accept ownership: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: 'danger',
      });
    }
  };

  const handleReject = async (proposalId: string, reason: string) => {
    await reject.mutateAsync({ proposalId, reason });
    setDrawerItem(null);
  };

  if (error) {
    return (
      <EmptyState
        message={`Failed to load proposals: ${error.message}`}
        error
        center
        padding={4}
      />
    );
  }

  return (
    <>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          Ownership proposals waiting for your team to accept or reject. Each
          entity here lacks a clear owner — your decision helps resolve it.
        </Typography>
      </Box>
      <div className={classes.cardListHeader}>
        <Typography variant="subtitle1" style={{ fontWeight: 600 }}>
          Pending proposals
        </Typography>
        <Typography variant="caption" color="textSecondary">
          {loading
            ? 'Loading…'
            : `${items.length} proposal${items.length !== 1 ? 's' : ''}`}
        </Typography>
      </div>

      {!loading && items.length === 0 ? (
        <EmptyState
          message="No pending proposals for your team - nothing to action right now."
          center
          padding={4}
        />
      ) : (
        <div className={classes.cardGrid}>
          {items.map(item => (
            <ProposalCard
              key={item.proposal.id}
              item={item}
              definitions={definitions}
              onClick={() => setDrawerItem(item)}
            />
          ))}
        </div>
      )}

      <ProposalDrawer
        item={drawerItem}
        definitions={definitions}
        acting={acting}
        onClose={() => setDrawerItem(null)}
        onAccept={handleAccept}
        onReject={handleReject}
      />

      <PossibleOwnersSection
        teamRefs={teamRefs}
        definitions={definitions}
        onClaimed={onAccepted}
      />
    </>
  );
}

// ─── Possible Owners (sub-threshold candidates) ──────────────────────────────

function PossibleOwnerCard({
  item,
  definitions,
  onClick,
}: {
  item: TeamProposalItem;
  definitions: DefinitionsResponse;
  onClick: () => void;
}) {
  const classes = useStyles();
  const reason = parseSignalKeys(item.proposal.confidence_reason)
    .map(key => findSignal(definitions, key).title)
    .join(', ');

  return (
    <div
      className={`${classes.proposalCard} ${classes.proposalCardHistory}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && onClick()}
    >
      {/* Row 1: entity name + kind */}
      <div className={classes.cardTopRow}>
        <Box display="flex" alignItems="center" style={{ gap: 6, minWidth: 0 }}>
          <Typography
            variant="body1"
            style={{ fontWeight: 600, lineHeight: 1.3 }}
          >
            {item.entity.entity_name || item.entity.entity_ref}
          </Typography>
          <Typography
            variant="body1"
            component="span"
            className={classes.entityKindLabel}
          >
            {item.entity.entity_kind}
          </Typography>
        </Box>
      </div>
      {/* Row 2: dense meta strip — the strategy reason for the suggestion */}
      <div className={classes.cardMetaStrip}>
        <Typography variant="caption" color="textSecondary">
          {reason || 'Suggested candidate'}
        </Typography>
      </div>
    </div>
  );
}

function PossibleOwnerDrawer({
  item,
  definitions,
  acting,
  claimError,
  onClose,
  onClaim,
}: {
  item: TeamProposalItem | null;
  definitions: DefinitionsResponse;
  acting: boolean;
  claimError: Error | null;
  onClose: () => void;
  onClaim: (proposalId: string) => void;
}) {
  const classes = useStyles();
  const signalKeys = item
    ? parseSignalKeys(item.proposal.confidence_reason)
    : [];

  return (
    <Drawer anchor="right" open={item !== null} onClose={onClose}>
      <div className={classes.drawerRoot}>
        <div className={classes.drawerHeader}>
          <Box flex={1} pr={1}>
            <Typography
              variant="h6"
              style={{ fontWeight: 700, lineHeight: 1.3 }}
            >
              {item?.entity.entity_name || item?.entity.entity_ref || ''}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              Possible owner
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label="close">
            <CloseIcon fontSize="small" />
          </IconButton>
        </div>
        <Divider />

        <div className={classes.drawerScrollBody}>
          {item && (
            <>
              <Box mt={2.5} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Entity
                </Typography>
                <Typography variant="body2">
                  <strong>
                    {item.entity.entity_name || item.entity.entity_ref}
                  </strong>
                </Typography>
                <Typography variant="caption" color="textSecondary">
                  {item.entity.entity_kind}
                </Typography>
                <Box mt={0.5}>
                  <CatalogEntityLink
                    entityRef={item.entity.entity_ref}
                    label="View in catalog →"
                  />
                </Box>
                {item.entity.repo_url && (
                  <Box mt={0.5}>
                    <MuiLink
                      href={item.entity.repo_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      variant="caption"
                    >
                      Repository
                    </MuiLink>
                  </Box>
                )}
              </Box>

              <Divider />

              <Box mt={2} className={classes.drawerSection}>
                <Typography className={classes.drawerSectionLabel}>
                  Why your team?
                </Typography>
                {signalKeys.length === 0 ? (
                  <Typography variant="body2" color="textSecondary">
                    No signal details available.
                  </Typography>
                ) : (
                  signalKeys.map(key => {
                    const info = findSignal(definitions, key);
                    return (
                      <div key={key} className={classes.signalItem}>
                        <Typography variant="body2" style={{ fontWeight: 600 }}>
                          {info.title}
                        </Typography>
                        {info.description && (
                          <Typography variant="caption" color="textSecondary">
                            {info.description}
                          </Typography>
                        )}
                      </div>
                    );
                  })
                )}
              </Box>
            </>
          )}
        </div>

        {item && (
          <div className={classes.drawerActions}>
            <div className={classes.actionGroup}>
              <Button
                variant="contained"
                color="primary"
                fullWidth
                disabled={acting}
                startIcon={<CheckCircleOutlineIcon />}
                onClick={() => onClaim(item.proposal.id)}
              >
                Claim ownership
              </Button>
              <Typography className={classes.actionCaption}>
                Claims ownership for your team and resolves the case; other
                candidate proposals for this entity are withdrawn. A pull
                request setting your team as owner in catalog-info.yaml is
                raised automatically for you to review.
              </Typography>
              {claimError && (
                <Typography variant="caption" color="error">
                  Failed to claim ownership: {claimError.message}
                </Typography>
              )}
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}

function PossibleOwnersSection({
  teamRefs,
  definitions,
  onClaimed,
}: {
  teamRefs: string[];
  definitions: DefinitionsResponse;
  /** Called with the claimed proposal id after a successful claim. */
  onClaimed: (proposalId: string) => void;
}) {
  const classes = useStyles();
  const toastApi = useApi(toastApiRef);
  const [searchParams, setSearchParams] = useSearchParams();
  const [claimError, setClaimError] = useState<Error | null>(null);

  const {
    data,
    isLoading: loading,
    error,
  } = useTeamProposals(teamRefs, ['possible_owner']);
  const { accept } = useProposalMutations();

  const items = data?.items ?? [];

  // Distinct URL param so opening a possible-owner drawer never collides with
  // the `proposal` param used by the pending/history drawers.
  const drawerParam = searchParams.get('possibleOwner');
  const drawerItem = drawerParam
    ? items.find(i => i.proposal.id === drawerParam) ?? null
    : null;

  const setDrawerItem = (item: TeamProposalItem | null) => {
    setClaimError(null);
    const next = new URLSearchParams(searchParams);
    if (item) {
      next.set('possibleOwner', item.proposal.id);
    } else {
      next.delete('possibleOwner');
    }
    setSearchParams(next, { replace: true });
  };

  const handleClaim = async (proposalId: string) => {
    setClaimError(null);
    try {
      await accept.mutateAsync(proposalId);
      toastApi.post({
        title: ACCEPT_SUCCESS_MESSAGE,
        status: 'success',
        timeout: 5000,
      });
      onClaimed(proposalId);
    } catch (err) {
      // Surface the failure in the drawer rather than silently stopping the
      // spinner — claims can fail on a stale/cancelled proposal (409) or a
      // membership check (403).
      setClaimError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Hide the section entirely when there are no possible owners (and we're not
  // mid-load with a stale empty value). No header, no empty box.
  if (error) {
    return (
      <EmptyState
        message={`Failed to load possible owners: ${error.message}`}
        error
        center
        padding={4}
      />
    );
  }
  if (loading && items.length === 0) return null;
  if (items.length === 0) return null;

  return (
    <Box mt={4}>
      <div className={classes.cardListHeader}>
        <Typography
          variant="subtitle2"
          color="textSecondary"
          style={{ fontWeight: 600 }}
        >
          Possible owners
        </Typography>
        <Typography variant="caption" color="textSecondary">
          {`${items.length} suggestion${items.length !== 1 ? 's' : ''}`}
        </Typography>
      </div>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          Other teams the system suggests could own these entities. These
          weren't notified because confidence was lower — claim one if it
          belongs to your team.
        </Typography>
      </Box>
      <div className={classes.cardGrid}>
        {items.map(item => (
          <PossibleOwnerCard
            key={item.proposal.id}
            item={item}
            definitions={definitions}
            onClick={() => setDrawerItem(item)}
          />
        ))}
      </div>

      <PossibleOwnerDrawer
        item={drawerItem}
        definitions={definitions}
        acting={accept.isPending}
        claimError={claimError}
        onClose={() => setDrawerItem(null)}
        onClaim={handleClaim}
      />
    </Box>
  );
}

// ─── History Tab ─────────────────────────────────────────────────────────────

function HistoryTab({
  teamRefs,
  definitions,
}: {
  teamRefs: string[];
  definitions: DefinitionsResponse;
}) {
  const classes = useStyles();
  const [searchParams, setSearchParams] = useSearchParams();

  const {
    data,
    isLoading: loading,
    isFetching,
    error,
    refetch,
  } = useTeamProposals(teamRefs, ['accepted', 'rejected']);

  const proposalParam = searchParams.get('proposal');
  const items = data?.items ?? [];
  const drawerItem = proposalParam
    ? items.find(i => i.proposal.id === proposalParam) ?? null
    : null;

  // The PR is raised in the background right after accept, so the drawer
  // usually opens on "Raising…". Poll while it's pending so "View pull
  // request" (or a failure + Retry) appears without a page reload.
  const { restart: handlePrChanged } = usePrStatusPolling({
    pending: drawerItem?.entity.pr_status === 'pending',
    // isFetching, not isLoading — see the note in EntityDetailPage.
    loading: isFetching,
    refresh: refetch,
    data,
    resetKey: proposalParam,
  });

  const setDrawerItem = (item: TeamProposalItem | null) => {
    const next = new URLSearchParams(searchParams);
    if (item) {
      next.set('proposal', item.proposal.id);
    } else {
      next.delete('proposal');
    }
    setSearchParams(next, { replace: true });
  };

  if (error) {
    return (
      <EmptyState
        message={`Failed to load history: ${error.message}`}
        error
        center
        padding={4}
      />
    );
  }

  return (
    <>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          Past ownership decisions made by your team — accepted and rejected
          proposals with the reasons recorded at the time.
        </Typography>
      </Box>
      <div className={classes.cardListHeader}>
        <Typography variant="subtitle1" style={{ fontWeight: 600 }}>
          Decision history
        </Typography>
        <Typography variant="caption" color="textSecondary">
          {loading
            ? 'Loading…'
            : `${items.length} decision${items.length !== 1 ? 's' : ''}`}
        </Typography>
      </div>

      {!loading && items.length === 0 ? (
        <EmptyState
          message="No history yet - decisions will appear here."
          center
          padding={4}
        />
      ) : (
        <div className={classes.cardGrid}>
          {items.map(item => (
            <HistoryCard
              key={item.proposal.id}
              item={item}
              onClick={() => setDrawerItem(item)}
            />
          ))}
        </div>
      )}

      <HistoryDrawer
        item={drawerItem}
        definitions={definitions}
        onClose={() => setDrawerItem(null)}
        onPrChanged={handlePrChanged}
      />
    </>
  );
}

// ─── Leadership tab helpers ───────────────────────────────────────────────────

const myAreaProposalColumns: TableColumn<LeadershipProposalItem>[] = [
  {
    title: 'Entity',
    field: 'entity.entity_ref',
    render: row => (
      <CatalogEntityLink
        entityRef={row.entity.entity_ref}
        label={row.entity.entity_name || row.entity.entity_ref}
        caption={row.entity.entity_kind}
      />
    ),
  },
  {
    title: 'Proposed Team',
    field: 'proposal.proposed_owner_ref',
    render: row => (
      <Typography variant="body2">
        {displayRef(row.proposal.proposed_owner_ref)}
      </Typography>
    ),
  },
  {
    title: 'Status',
    field: 'proposal.status',
    lookup: {
      pending: 'Pending',
      accepted: 'Accepted',
      rejected: 'Rejected',
      expired: 'Expired',
    },
    render: row => <ProposalStatusBadge status={row.proposal.status} />,
    cellStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'Date Sent',
    field: 'proposal.created_at',
    filtering: false,
    render: row => new Date(row.proposal.created_at).toLocaleDateString(),
    cellStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'Decided By',
    field: 'actor',
    filtering: false,
    render: row =>
      row.actor ? (
        <Typography variant="body2" style={{ whiteSpace: 'nowrap' }}>
          {row.actor
            .replace(/^user:[^/]+\//, '')
            .replace(/_([^_]+\.[^_]+)$/, '@$1')}
        </Typography>
      ) : (
        <Typography variant="body2" color="textSecondary">
          —
        </Typography>
      ),
  },
  {
    title: 'Details',
    filtering: false,
    sorting: false,
    cellStyle: { whiteSpace: 'nowrap', width: '1%' },
    render: row =>
      row.proposal.status === 'pending' ? (
        <Link to={`?tab=pending&proposal=${row.proposal.id}`}>View</Link>
      ) : (
        <Link to={`?tab=history&proposal=${row.proposal.id}`}>View</Link>
      ),
  },
];

function MyTeamsTab({ pendingCount }: { pendingCount: number }) {
  const {
    data: proposalsData,
    isLoading: proposalsLoading,
    error: proposalsError,
  } = useLeadershipProposals({
    status: ['pending', 'accepted', 'rejected', 'expired'],
  });

  return (
    <>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          All ownership proposals across the teams you manage. Use this view to
          track progress and spot where your teams need to take action.
        </Typography>
      </Box>
      <Box mb={2}>
        <StatCard
          title="Pending Proposals"
          value={pendingCount}
          subtitle="awaiting response from your teams"
        />
      </Box>
      <Table
        title="Ownership Proposals"
        columns={myAreaProposalColumns}
        data={proposalsData ?? []}
        isLoading={proposalsLoading}
        options={{ paging: true, pageSize: 25, search: true, filtering: true }}
        emptyContent={
          proposalsError ? (
            <EmptyState
              message={`Failed to load proposals: ${proposalsError.message}`}
              error
            />
          ) : (
            <EmptyState message="No proposals for your teams." />
          )
        }
      />
    </>
  );
}

const escalationColumns: TableColumn<OwnershipEntity>[] = [
  {
    title: 'Entity',
    field: 'entity_ref',
    render: row => (
      <CatalogEntityLink
        entityRef={row.entity_ref}
        label={row.entity_name || row.entity_ref}
        caption={row.entity_kind}
      />
    ),
  },
  {
    title: 'Check',
    field: 'current_check',
    render: row => <Chip label={row.current_check} size="small" />,
  },
  {
    title: 'Current Owner',
    field: 'current_owner',
    render: row => (
      <Typography variant="body2">{displayRef(row.current_owner)}</Typography>
    ),
  },
  {
    title: 'Escalated To',
    field: 'assigned_to',
    render: row =>
      row.assigned_to ? (
        <Tooltip
          title="The person currently responsible for resolving this escalation"
          arrow
        >
          <Typography variant="body2">{displayRef(row.assigned_to)}</Typography>
        </Tooltip>
      ) : (
        <Typography variant="body2" color="textSecondary">
          —
        </Typography>
      ),
  },
  {
    title: 'Detected',
    field: 'first_detected_at',
    render: row => new Date(row.first_detected_at).toLocaleDateString(),
    cellStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'Details',
    cellStyle: { whiteSpace: 'nowrap', width: '1%' },
    // Absolute link: a relative `entities/:id` resolved under
    // /my-ownership-proposals, which has no such route.
    render: row => <EntityDetailLink entityId={row.id} />,
  },
];

function MyTeamsEscalationsTab() {
  const { data, isLoading, error } = useLeadershipEntities({
    status: ['escalated'],
  });

  return (
    <>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          Entities owned by your teams where all proposals were rejected and the
          case has been escalated for manual resolution.
        </Typography>
      </Box>
      <Table
        title="Active Escalations"
        columns={escalationColumns}
        data={data?.items ?? []}
        isLoading={isLoading}
        options={{ paging: true, pageSize: 25, search: true }}
        emptyContent={
          error ? (
            <EmptyState
              message={`Failed to load escalations: ${error.message}`}
              error
            />
          ) : (
            <EmptyState message="No active escalations in your area." />
          )
        }
      />
    </>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

type UserTabKey = 'pending' | 'history' | 'my-teams' | 'escalations' | 'admin';

const TAB_LABELS: Record<UserTabKey, string> = {
  pending: 'Pending',
  history: 'History',
  'my-teams': 'My Teams',
  escalations: 'Escalations',
  admin: 'Admin',
};

export const UserOwnershipPage = () => {
  const identityApi = useApi(identityApiRef);
  const catalogApi = useApi(catalogApiRef);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedGroup, setSelectedGroup] = useSelectedTeam();

  const { data: leadershipStats, isLoading: leadershipLoading } =
    useLeadershipStats();
  const isLeader = !leadershipLoading && (leadershipStats?.isLeader ?? false);
  const { allowed: isAdmin, loading: permissionLoading } = usePermission({
    permission: ownershipMatcherAdminPermission,
  });

  /**
   * After accept/claim: switch to History with the decision's drawer open
   * (PR status + link). Merges into the existing params rather than replacing
   * them, so the `?team=` selection survives the jump.
   */
  const openInHistory = (proposalId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'history');
    next.set('proposal', proposalId);
    setSearchParams(next, { replace: true });
  };

  const { definitions } = useDefinitions();

  const { data: identity, isLoading: identityLoading } = useQuery({
    queryKey: queryKeys.identity(),
    queryFn: () => identityApi.getBackstageIdentity(),
  });

  const groupRefs =
    identity?.ownershipEntityRefs.filter(ref => ref.startsWith('group:')) ?? [];

  // Proposals are only ever created for groups whose spec.type is one of the
  // configured team group types (see CatalogService.getTeamGroupRegistry in
  // ownership-matcher-node), so other group types would always show an
  // empty list.
  const teamGroupTypes = useTeamGroupTypes();
  const { data: groups, isLoading: groupsLoading } = useQuery({
    queryKey: queryKeys.userTeamGroups(groupRefs, teamGroupTypes),
    queryFn: async () => {
      if (groupRefs.length === 0) return [];
      const { items } = await catalogApi.getEntitiesByRefs({
        entityRefs: groupRefs,
        fields: ['kind', 'metadata.namespace', 'metadata.name', 'spec.type'],
      });
      return groupRefs.filter((_, i) => {
        const type = items[i]?.spec?.type;
        return typeof type === 'string' && teamGroupTypes.includes(type);
      });
    },
  });

  const teamGroups = groups ?? [];
  const hasTeams = teamGroups.length > 0;

  // Pending/History are scoped to the user's own team-type groups; My Teams and
  // Escalations come from the backend-computed managed sub-tree, so a leader
  // whose only groups are non-team (e.g. a chapter) still gets those tabs.
  // Admin is gated by the ownership-matcher admin permission only.
  const userTabs: UserTabKey[] = [
    ...(hasTeams ? (['pending', 'history'] as const) : []),
    ...(isLeader ? (['my-teams', 'escalations'] as const) : []),
    ...(isAdmin ? (['admin'] as const) : []),
  ];
  const defaultTab: UserTabKey = userTabs[0] ?? 'pending';

  const paramTab = searchParams.get('tab') as UserTabKey | null;
  const activeTab: UserTabKey =
    paramTab && userTabs.includes(paramTab) ? paramTab : defaultTab;
  const tabIndex = userTabs.indexOf(activeTab);

  const handleTabChange = (_: unknown, newIndex: number) => {
    // Merge, don't replace: `?team=` lives in the URL now, and replacing the
    // whole query string would reset the selection to "All teams" on every
    // tab switch. `proposal` is dropped on purpose — it belongs to the drawer
    // of the tab being left.
    const next = new URLSearchParams(searchParams);
    next.set('tab', userTabs[newIndex]);
    next.delete('proposal');
    setSearchParams(next, { replace: true });
  };

  const activeTeamRefs =
    selectedGroup === '__all__' ? teamGroups : [selectedGroup];

  if (
    identityLoading ||
    groupsLoading ||
    leadershipLoading ||
    permissionLoading
  ) {
    return (
      <Page themeId="tool">
        <Header
          title="Ownership"
          subtitle="Ownership issues proposed for your team"
        />
        <Content>
          <Typography>Loading your teams...</Typography>
        </Content>
      </Page>
    );
  }

  if (userTabs.length === 0) {
    return (
      <Page themeId="tool">
        <Header
          title="Ownership"
          subtitle="Ownership issues proposed for your team"
        />
        <Content>
          <EmptyState
            message={
              groupRefs.length === 0
                ? 'You are not a member of any groups in the catalog.'
                : "You aren't a member of any team in the catalog, so there are no ownership proposals to show here."
            }
            center
            padding={4}
          />
        </Content>
      </Page>
    );
  }

  return (
    <Page themeId="tool">
      <Header
        title="Ownership"
        subtitle="Ownership issues the system believes your team should resolve"
      />
      <Content>
        {teamGroups.length > 1 &&
          (activeTab === 'pending' || activeTab === 'history') && (
            <TeamSelect
              groups={teamGroups}
              value={selectedGroup}
              onChange={v => setSelectedGroup(v)}
            />
          )}

        <Tabs value={tabIndex} onChange={handleTabChange}>
          {userTabs.map(tab => (
            <Tab key={tab} label={TAB_LABELS[tab]} />
          ))}
        </Tabs>

        <Box mt={2}>
          {activeTab === 'pending' && hasTeams && (
            <PendingTab
              teamRefs={activeTeamRefs}
              onAccepted={openInHistory}
              definitions={definitions}
            />
          )}
          {activeTab === 'history' && hasTeams && (
            <HistoryTab teamRefs={activeTeamRefs} definitions={definitions} />
          )}
          {activeTab === 'my-teams' && isLeader && (
            <MyTeamsTab pendingCount={leadershipStats?.pendingProposals ?? 0} />
          )}
          {activeTab === 'escalations' && isLeader && <MyTeamsEscalationsTab />}
          {activeTab === 'admin' && isAdmin && <OwnershipMatcherAdminPanel />}
        </Box>
      </Content>
    </Page>
  );
};
