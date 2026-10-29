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

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Autocomplete from '@material-ui/lab/Autocomplete/Autocomplete';
import { catalogApiRef } from '@backstage/plugin-catalog-react';
import {
  Header,
  Page,
  Content,
  Table,
  TableColumn,
  InfoCard,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { useTeamGroupTypes } from '../../useTeamGroupTypes';
import { useEntityDetail } from '../../hooks/useEntityDetail';
import { queryKeys } from '../../query/keys';
import { useProposalMutations } from '../../hooks/useProposalMutations';
import { useEscalationMutations } from '../../hooks/useEscalationMutations';
import {
  Grid,
  Chip,
  Button,
  Typography,
  Box,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@material-ui/core';
import { useParams } from 'react-router-dom';
import { usePermission } from '@backstage/plugin-permission-react';
import { ownershipMatcherAdminPermission } from '../../permissions';
import { OwnershipProposal } from '../../api';
import { PrStatusIndicator } from '../PrStatus/PrStatusIndicator';
import { usePrStatusPolling } from '../PrStatus/usePrStatusPolling';
import { displayRef } from '../../utils/entityRef';
import { resolutionLabel, parseReasons } from '../../utils/history';
import { EntityStatusBadge } from '../EntityStatusBadge/EntityStatusBadge';
import { ProposalStatusBadge } from '../ProposalStatusBadge/ProposalStatusBadge';
import { CatalogEntityLink } from '../CatalogEntityLink/CatalogEntityLink';
import { EmptyState } from '../EmptyState/EmptyState';
import { Timeline } from '../Timeline/Timeline';

// ─── Proposals Table ─────────────────────────────────────────────────────────

// No refresh callback: useProposalMutations invalidates this entity's detail
// query on success, which refetches the active query. Calling refetch() on top
// of that just cancels and restarts the request react-query already started.
function ProposalsCard({ proposals }: { proposals: OwnershipProposal[] }) {
  const toastApi = useApi(toastApiRef);
  const { accept, reject } = useProposalMutations();
  const [rejectDialogId, setRejectDialogId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const acting = accept.isPending || reject.isPending;

  const handleAccept = async (id: string) => {
    try {
      await accept.mutateAsync(id);
      toastApi.post({
        title:
          'Ownership accepted — a pull request updating spec.owner in catalog-info.yaml is being raised.',
        status: 'success',
        timeout: 5000,
      });
    } catch (err) {
      toastApi.post({
        title: `Failed to accept proposal: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: 'danger',
      });
    }
  };

  const handleReject = async () => {
    if (!rejectDialogId) return;
    // No catch, matching behaviour before this migration: a failed reject
    // leaves the dialog open with no toast (unlike accept, which always
    // reports failure).
    await reject.mutateAsync({
      proposalId: rejectDialogId,
      reason: rejectReason,
    });
    setRejectDialogId(null);
    setRejectReason('');
  };

  const columns: TableColumn<OwnershipProposal>[] = [
    { title: '#', field: 'proposal_order', width: '5%' },
    {
      title: 'Proposed Owner',
      field: 'proposed_owner_ref',
      render: row => (
        <Box>
          <Typography variant="body2">
            {displayRef(row.proposed_owner_ref)}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            {row.proposed_owner_type}
          </Typography>
        </Box>
      ),
    },
    {
      title: 'Signals',
      field: 'confidence_reason',
      render: row => {
        const reasons = parseReasons(row.confidence_reason);
        return (
          <Box display="flex" flexWrap="wrap" style={{ gap: 4 }}>
            {reasons.map(r => (
              <Chip key={r} label={r} size="small" />
            ))}
          </Box>
        );
      },
    },
    {
      title: 'Confidence',
      field: 'confidence_score',
      render: row =>
        row.confidence_score !== null && row.confidence_score !== undefined
          ? `${(row.confidence_score * 100).toFixed(0)}%`
          : '—',
    },
    {
      title: 'Status',
      field: 'status',
      render: row => <ProposalStatusBadge status={row.status} />,
    },
    {
      title: 'Actions',
      render: row => {
        if (row.status !== 'pending') return null;
        return (
          <Box>
            <Button
              size="small"
              color="primary"
              variant="outlined"
              disabled={acting}
              onClick={() => handleAccept(row.id)}
              style={{ marginRight: 8 }}
            >
              Accept
            </Button>
            <Button
              size="small"
              color="secondary"
              variant="outlined"
              disabled={acting}
              onClick={() => setRejectDialogId(row.id)}
            >
              Reject
            </Button>
          </Box>
        );
      },
    },
  ];

  return (
    <>
      <Table
        title="Proposals"
        columns={columns}
        data={proposals}
        options={{ paging: false, search: false }}
        emptyContent={<EmptyState message="No proposals for this entity." />}
      />
      <Dialog
        open={rejectDialogId !== null}
        onClose={() => setRejectDialogId(null)}
      >
        <DialogTitle>Reject Proposal</DialogTitle>
        <DialogContent>
          <TextField
            // Focus the only field of a dialog the user just opened.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            label="Reason"
            fullWidth
            required
            multiline
            rows={3}
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectDialogId(null)}>Cancel</Button>
          <Button
            onClick={handleReject}
            color="secondary"
            disabled={acting || !rejectReason.trim()}
          >
            Reject
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ─── Escalation Actions ──────────────────────────────────────────────────────

interface TeamOption {
  label: string;
  ref: string;
}

// No refresh callback — see ProposalsCard; useEscalationMutations invalidates
// entityDetail(entityId) on success.
function EscalationActions({
  entityId,
  currentStatus,
}: {
  entityId: string;
  currentStatus: string;
}) {
  const catalogApi = useApi(catalogApiRef);
  const [ownerRef, setOwnerRef] = useState<TeamOption | null>(null);
  const [assigneeRef, setAssigneeRef] = useState<TeamOption | null>(null);
  const teamGroupTypes = useTeamGroupTypes();
  const { assign, archive } = useEscalationMutations();
  const acting = assign.isPending || archive.isPending;

  const { data: teamOptions = [], isLoading: teamsLoading } = useQuery({
    queryKey: queryKeys.escalationTeamOptions(teamGroupTypes),
    queryFn: async () => {
      const { items } = await catalogApi.getEntities({
        filter: { kind: 'Group', 'spec.type': teamGroupTypes },
        fields: ['metadata.name', 'metadata.namespace', 'metadata.title'],
      });
      return items.map(g => ({
        label: (g.metadata.title as string | undefined) ?? g.metadata.name,
        ref: `group:${g.metadata.namespace ?? 'default'}/${g.metadata.name}`,
      }));
    },
    staleTime: 0,
  });

  const handleAssign = async () => {
    if (!ownerRef) return;
    await assign.mutateAsync({ entityId, ownerRef: ownerRef.ref });
  };

  const handleArchive = async () => {
    if (!assigneeRef) return;
    await archive.mutateAsync({ entityId, assigneeRef: assigneeRef.ref });
  };

  return (
    <InfoCard
      title={
        currentStatus === 'unresolved'
          ? 'Unresolved Case Actions'
          : 'Escalation Actions'
      }
    >
      <Box display="flex" alignItems="center" style={{ gap: 16 }} mb={2}>
        <Autocomplete
          options={teamOptions}
          getOptionLabel={o => o.label}
          getOptionSelected={(o, v) => o.ref === v.ref}
          value={ownerRef}
          onChange={(_e, val) => setOwnerRef(val)}
          loading={teamsLoading}
          style={{ flex: 1 }}
          renderInput={params => (
            <TextField {...params} label="Assign to team" size="small" />
          )}
        />
        <Button
          variant="contained"
          color="primary"
          onClick={handleAssign}
          disabled={acting || !ownerRef}
        >
          Assign Owner
        </Button>
      </Box>
      <Box display="flex" alignItems="center" style={{ gap: 16 }}>
        <Autocomplete
          options={teamOptions}
          getOptionLabel={o => o.label}
          getOptionSelected={(o, v) => o.ref === v.ref}
          value={assigneeRef}
          onChange={(_e, val) => setAssigneeRef(val)}
          loading={teamsLoading}
          style={{ flex: 1 }}
          renderInput={params => (
            <TextField {...params} label="Assignee team" size="small" />
          )}
        />
        <Button
          variant="outlined"
          color="secondary"
          onClick={handleArchive}
          disabled={acting || !assigneeRef}
        >
          Archive Entity
        </Button>
      </Box>
    </InfoCard>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export const EntityDetailPage = () => {
  const { entityId } = useParams();
  const {
    data: value,
    isLoading: loading,
    isFetching,
    error,
    refetch,
  } = useEntityDetail(entityId);
  // Unresolved entities have no escalation actor; only admins may resolve them.
  const { allowed: isAdmin } = usePermission({
    permission: ownershipMatcherAdminPermission,
  });

  // Refresh while the catalog-info PR is being raised so "Raising…" updates
  // to the PR link (or a failure + Retry) without a page reload.
  const { restart: handlePrChanged } = usePrStatusPolling({
    pending: value?.entity.pr_status === 'pending',
    // isFetching, not isLoading: isLoading stays false during a background
    // refetch, and react-query's structural sharing hands back the same `data`
    // reference while the PR is still pending — so with isLoading the poll
    // effect never re-runs and the second timer is never armed.
    loading: isFetching,
    refresh: refetch,
    data: value,
    resetKey: entityId,
  });

  // Only the first load replaces the page; background refreshes keep the
  // current content on screen.
  if (loading && !value) {
    return (
      <Page themeId="tool">
        <Header title="Entity Detail" />
        <Content>
          <Typography>Loading...</Typography>
        </Content>
      </Page>
    );
  }

  if (error || !value) {
    // The backend returns 403 unless the user is an admin, the escalation
    // actor, or on a team involved in this case.
    const forbidden = error?.message.startsWith('Request failed: 403');
    return (
      <Page themeId="tool">
        <Header title="Entity Detail" />
        <Content>
          <Typography color="error">
            {forbidden
              ? 'You do not have access to this ownership case. It is visible to admins, the current escalation actor, and teams involved in the case.'
              : error?.message || 'Entity not found'}
          </Typography>
        </Content>
      </Page>
    );
  }

  const { entity, proposals, history } = value;

  return (
    <Page themeId="tool">
      <Header
        title={entity.entity_name || entity.entity_ref}
        subtitle={`${entity.entity_kind} · ${entity.entity_ref}`}
      />
      <Content>
        <Grid container spacing={3}>
          {/* Entity Info */}
          <Grid item xs={12}>
            <InfoCard title="Entity Info">
              <Grid container spacing={2}>
                <Grid item xs={2}>
                  <Typography variant="subtitle2">Status</Typography>
                  <EntityStatusBadge status={entity.current_status} />
                </Grid>
                <Grid item xs={2}>
                  <Typography variant="subtitle2">Issue Type</Typography>
                  <Chip label={entity.current_check} size="small" />
                </Grid>
                <Grid item xs={3}>
                  <Typography variant="subtitle2">Current Owner</Typography>
                  <Typography variant="body2">
                    {displayRef(entity.current_owner)}
                  </Typography>
                </Grid>
                <Grid item xs={2}>
                  <Typography variant="subtitle2">First Detected</Typography>
                  <Typography variant="body2">
                    {new Date(entity.first_detected_at).toLocaleDateString()}
                  </Typography>
                </Grid>
                <Grid item xs={3}>
                  <Typography variant="subtitle2">In Catalog</Typography>
                  <CatalogEntityLink
                    entityRef={entity.entity_ref}
                    label="View entity"
                  />
                </Grid>
                {entity.pr_status && entity.pr_status !== 'none' && (
                  <Grid item xs={3}>
                    <Typography variant="subtitle2">Catalog PR</Typography>
                    <PrStatusIndicator
                      entity={entity}
                      onChanged={handlePrChanged}
                    />
                  </Grid>
                )}
                {entity.resolved_at && (
                  <>
                    <Grid item xs={3}>
                      <Typography variant="subtitle2">Resolved At</Typography>
                      <Typography variant="body2">
                        {new Date(entity.resolved_at).toLocaleDateString()}
                      </Typography>
                    </Grid>
                    <Grid item xs={3}>
                      <Typography variant="subtitle2">Resolved By</Typography>
                      <Typography variant="body2">
                        {displayRef(entity.resolved_by)}
                      </Typography>
                    </Grid>
                    <Grid item xs={3}>
                      <Typography variant="subtitle2">Resolution</Typography>
                      <Typography variant="body2">
                        {resolutionLabel(entity.resolution_type)}
                      </Typography>
                    </Grid>
                  </>
                )}
              </Grid>
            </InfoCard>
          </Grid>

          {/* Escalation actions — escalated entities, or unresolved ones for admins */}
          {(entity.current_status === 'escalated' ||
            (entity.current_status === 'unresolved' && isAdmin)) && (
            <Grid item xs={12}>
              <EscalationActions
                entityId={entity.id}
                currentStatus={entity.current_status}
              />
            </Grid>
          )}

          {/* Proposals */}
          <Grid item xs={12}>
            <ProposalsCard proposals={proposals} />
          </Grid>

          {/* History */}
          <Grid item xs={12}>
            <Timeline history={history} />
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
};
