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

import { useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';

dayjs.extend(duration);
import { Table, TableColumn, Link } from '@backstage/core-components';
import { useRouteRef } from '@backstage/core-plugin-api';
import { entityDetailRouteRef, userProposalsRouteRef } from '../../routes';
import {
  Tabs,
  Tab,
  Chip,
  Button,
  Box,
  Typography,
  Grid,
  CircularProgress,
} from '@material-ui/core';
import { OwnershipScan, AdminProposalItem } from '../../api';
import { displayRef, displayGroupRef } from '../../utils/entityRef';
import { EntityStatusBadge } from '../EntityStatusBadge/EntityStatusBadge';
import { ScanStatusBadge } from '../ScanStatusBadge/ScanStatusBadge';
import { ProposalStatusBadge } from '../ProposalStatusBadge/ProposalStatusBadge';
import { StatCard } from '../StatCard/StatCard';
import { ConfidenceDistribution } from '../ConfidenceDistribution/ConfidenceDistribution';
import { CatalogEntityLink } from '../CatalogEntityLink/CatalogEntityLink';
import { EmptyState } from '../EmptyState/EmptyState';
import { useDashboardStats } from '../../hooks/useDashboardStats';
import { useDefinitions } from '../../hooks/useDefinitions';
import { useAllProposals } from '../../hooks/useAllProposals';
import { useEntities, EntityRow } from '../../hooks/useEntities';
import {
  useUnresolvedEntities,
  UnresolvedRow,
} from '../../hooks/useUnresolvedEntities';
import { useScans } from '../../hooks/useScans';
import { useEscalationMutations } from '../../hooks/useEscalationMutations';

// Absolute link: the admin tabs are also rendered inside the Ownership page,
// so a relative `entities/:id` link would resolve against the wrong route.
export function EntityDetailLink({ entityId }: Readonly<{ entityId: string }>) {
  const entityDetailRoute = useRouteRef(entityDetailRouteRef);
  return <Link to={entityDetailRoute({ entityId })}>View</Link>;
}

// ─── Dashboard Tab ───────────────────────────────────────────────────────────

const adminProposalColumns: TableColumn<AdminProposalItem>[] = [
  {
    title: 'Entity',
    field: 'entity.entity_name',
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
        {displayGroupRef(row.proposal.proposed_owner_ref)}
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
      possible_owner: 'Possible Owner',
    },
    render: row => <ProposalStatusBadge status={row.proposal.status} />,
    cellStyle: { whiteSpace: 'nowrap' },
    headerStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'Date Sent',
    field: 'proposal.created_at',
    render: row => new Date(row.proposal.created_at).toLocaleDateString(),
    cellStyle: { whiteSpace: 'nowrap' },
    headerStyle: { whiteSpace: 'nowrap' },
    filtering: false,
  },
  {
    title: 'Decided By',
    field: 'actor',
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
    title: 'Confidence',
    field: 'proposal.confidence_score',
    filtering: false,
    render: row => (
      <Typography variant="body2">
        {row.proposal.confidence_score !== null &&
        row.proposal.confidence_score !== undefined
          ? `${(row.proposal.confidence_score * 100).toFixed(0)}%`
          : '—'}
      </Typography>
    ),
    cellStyle: { whiteSpace: 'nowrap' },
    headerStyle: { whiteSpace: 'nowrap' },
  },
  {
    title: 'Details',
    filtering: false,
    sorting: false,
    cellStyle: { whiteSpace: 'nowrap', width: '1%' },
    headerStyle: { whiteSpace: 'nowrap', width: '1%' },
    render: row => <EntityDetailLink entityId={row.entity.id} />,
  },
];

function DashboardTab() {
  const { data: stats, isLoading: statsLoading } = useDashboardStats();
  const { definitions } = useDefinitions();
  const { data: proposalsData, isLoading: proposalsLoading } =
    useAllProposals();

  const checks = definitions.checks;
  const totalOpen = stats?.totalOpen ?? 0;
  const perCheck = stats?.perCheck ?? {};
  const pendingProposals = stats?.pendingProposals ?? 0;

  return (
    <>
      <Grid
        container
        spacing={2}
        alignItems="stretch"
        style={{ marginBottom: 16 }}
      >
        {stats?.confidenceDistribution &&
          stats.confidenceDistribution.length > 0 && (
            <Grid
              item
              xs={12}
              sm={6}
              md={4}
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <ConfidenceDistribution buckets={stats.confidenceDistribution} />
            </Grid>
          )}
        {checks.map(check => {
          const count = perCheck[check.key] ?? 0;
          const pct =
            totalOpen > 0
              ? `${((count / totalOpen) * 100).toFixed(0)}% of open`
              : undefined;
          return (
            <Grid
              key={check.key}
              item
              xs={12}
              sm={6}
              md
              style={{ display: 'flex', flexDirection: 'column' }}
            >
              <StatCard
                title={check.title}
                value={statsLoading ? <CircularProgress size={24} /> : count}
                subtitle={pct}
              />
            </Grid>
          );
        })}
        <Grid
          item
          xs={12}
          sm={6}
          md
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <StatCard
            title="Pending Proposals"
            value={
              statsLoading ? <CircularProgress size={24} /> : pendingProposals
            }
            subtitle="awaiting team response"
          />
        </Grid>
        <Grid
          item
          xs={12}
          sm={6}
          md
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <StatCard
            title="Open Issues"
            value={statsLoading ? <CircularProgress size={24} /> : totalOpen}
            subtitle="sum across all checks"
          />
        </Grid>
      </Grid>

      <Table
        title="All Proposals"
        columns={adminProposalColumns}
        data={proposalsData ?? []}
        isLoading={proposalsLoading}
        options={{
          paging: true,
          pageSize: 25,
          pageSizeOptions: [25, 50, 100],
          search: true,
          filtering: true,
        }}
      />
    </>
  );
}

// ─── Entities Tab ────────────────────────────────────────────────────────────

const entityColumns: TableColumn<EntityRow>[] = [
  {
    title: 'Entity',
    field: 'entity_ref',
    render: row => (
      <CatalogEntityLink entityRef={row.entity_ref} label={row.entity_ref} />
    ),
  },
  { title: 'Kind', field: 'entity_kind' },
  {
    title: 'Status',
    field: 'current_status',
    render: row => <EntityStatusBadge status={row.current_status} />,
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
    title: 'Suggested Owner',
    field: 'suggested_owner',
    render: row =>
      row.suggested_owner ? (
        <Box>
          <Typography variant="body2">
            {displayRef(row.suggested_owner)}
          </Typography>
          {row.suggested_score && (
            <Typography variant="caption" color="textSecondary">
              {row.suggested_score}
            </Typography>
          )}
        </Box>
      ) : (
        '—'
      ),
  },
  {
    title: 'Assigned Responder',
    field: 'active_responder',
    render: row =>
      row.active_responder ? (
        <Box>
          <Typography variant="body2">
            {displayRef(row.active_responder)}
          </Typography>
          {row.proposal_status && (
            <Chip
              label={
                row.proposal_status.charAt(0).toUpperCase() +
                row.proposal_status.slice(1)
              }
              size="small"
              variant="outlined"
            />
          )}
        </Box>
      ) : (
        '—'
      ),
  },
  {
    title: 'Detected',
    field: 'first_detected_at',
    render: row => new Date(row.first_detected_at).toLocaleDateString(),
  },
  {
    title: 'Details',
    render: row => <EntityDetailLink entityId={row.id} />,
  },
];

function EntitiesTab() {
  const { data, isLoading, error } = useEntities();

  return (
    <Table
      title="Tracked Entities"
      columns={entityColumns}
      data={data ?? []}
      isLoading={isLoading}
      options={{ paging: true, pageSize: 20, search: true }}
      emptyContent={
        error ? (
          <EmptyState
            message={`Failed to load entities: ${error.message}`}
            error
          />
        ) : (
          <EmptyState message="No ownership issues found." />
        )
      }
    />
  );
}

// ─── Scans Tab ───────────────────────────────────────────────────────────────

const scanColumns: TableColumn<OwnershipScan>[] = [
  {
    title: 'ID',
    field: 'id',
    render: row => row.id.slice(0, 8),
  },
  {
    title: 'Status',
    field: 'status',
    render: row => <ScanStatusBadge status={row.status} />,
  },
  { title: 'Entities Scanned', field: 'total_entities_scanned' },
  { title: 'New Issues', field: 'new_issues_found' },
  { title: 'Updated', field: 'existing_issues_updated' },
  { title: 'Auto-Resolved', field: 'issues_auto_resolved' },
  {
    title: 'Duration',
    field: 'duration_ms',
    render: row =>
      row.duration_ms !== null && row.duration_ms !== undefined
        ? dayjs.duration(row.duration_ms).format('m[m] s[s]')
        : '—',
  },
  {
    title: 'Started',
    field: 'started_at',
    render: row => new Date(row.started_at).toLocaleString(),
  },
  {
    title: 'Error',
    field: 'error_message',
    render: row => row.error_message || '—',
  },
];

function ScansTab() {
  const { data, isLoading, error } = useScans(50);
  const { triggerScan } = useEscalationMutations();

  const handleTriggerScan = () => {
    triggerScan.mutate();
  };

  return (
    <>
      <Box display="flex" justifyContent="flex-end" mb={2}>
        <Button
          variant="contained"
          color="primary"
          onClick={handleTriggerScan}
          disabled={triggerScan.isPending}
        >
          {triggerScan.isPending ? 'Triggering...' : 'Trigger Scan'}
        </Button>
      </Box>
      <Table
        title="Scan History"
        columns={scanColumns}
        data={data?.scans ?? []}
        isLoading={isLoading}
        options={{ paging: true, pageSize: 10, search: false }}
        emptyContent={
          error ? (
            <EmptyState
              message={`Failed to load scans: ${error.message}`}
              error
            />
          ) : (
            <EmptyState message="No scans recorded yet." />
          )
        }
      />
    </>
  );
}

// ─── Unresolved Tab ──────────────────────────────────────────────────────────

const UNKNOWN_REASON = 'Unknown';

type UnresolvedFacet = 'kind' | 'reason';

function facetValue(row: UnresolvedRow, facet: UnresolvedFacet): string {
  return facet === 'kind'
    ? row.entity_kind
    : row.reason_label ?? UNKNOWN_REASON;
}

/** Per-value counts for one facet, most frequent first. */
function countUnresolvedBy(
  rows: UnresolvedRow[],
  facet: UnresolvedFacet,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = facetValue(row, facet);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function UnresolvedCategoryFilter({
  label,
  counts,
  total,
  selected,
  onSelect,
}: Readonly<{
  label: string;
  counts: readonly { value: string; count: number }[];
  total: number;
  selected: string | null;
  onSelect: (value: string | null) => void;
}>) {
  return (
    <Box display="flex" alignItems="center" flexWrap="wrap" mb={1}>
      <Box mr={1} minWidth={56}>
        <Typography variant="body2" color="textSecondary">
          {label}
        </Typography>
      </Box>
      <Box mr={1} mb={0.5}>
        <Chip
          label={`All (${total})`}
          size="small"
          color={selected === null ? 'primary' : 'default'}
          onClick={() => onSelect(null)}
        />
      </Box>
      {counts.map(({ value, count }) => (
        <Box key={value} mr={1} mb={0.5}>
          <Chip
            label={`${value} (${count})`}
            size="small"
            color={selected === value ? 'primary' : 'default'}
            onClick={() => onSelect(selected === value ? null : value)}
          />
        </Box>
      ))}
    </Box>
  );
}
function UnresolvedTab() {
  const { data: value, isLoading: loading, error } = useUnresolvedEntities();

  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [reasonFilter, setReasonFilter] = useState<string | null>(null);

  // Each facet's counts reflect the other facet's selection, so the chips
  // always show how many rows selecting them would leave.
  const { rows, kindCounts, reasonCounts, kindTotal, reasonTotal } =
    useMemo(() => {
      const all = value ?? [];
      const byKind = all.filter(
        r => kindFilter === null || facetValue(r, 'kind') === kindFilter,
      );
      const byReason = all.filter(
        r => reasonFilter === null || facetValue(r, 'reason') === reasonFilter,
      );
      return {
        rows: byKind.filter(
          r =>
            reasonFilter === null || facetValue(r, 'reason') === reasonFilter,
        ),
        kindCounts: countUnresolvedBy(byReason, 'kind'),
        kindTotal: byReason.length,
        reasonCounts: countUnresolvedBy(byKind, 'reason'),
        reasonTotal: byKind.length,
      };
    }, [value, kindFilter, reasonFilter]);

  const columns: TableColumn<UnresolvedRow>[] = [
    {
      title: 'Entity',
      field: 'entity_ref',
      render: row => (
        <CatalogEntityLink
          entityRef={row.entity_ref}
          label={row.entity_name || row.entity_ref}
        />
      ),
    },
    {
      title: 'Kind',
      field: 'entity_kind',
    },
    {
      title: 'Check',
      field: 'current_check',
      render: row => <Chip label={row.current_check} size="small" />,
    },
    {
      title: 'Reason',
      field: 'reason_action',
      render: row =>
        row.reason_label ? (
          <Chip label={row.reason_label} size="small" />
        ) : (
          <Typography variant="caption" color="textSecondary">
            —
          </Typography>
        ),
    },
    {
      title: 'Current Owner',
      field: 'current_owner',
      render: row => (
        <Typography variant="body2">{displayRef(row.current_owner)}</Typography>
      ),
    },
    {
      title: 'Detected',
      field: 'first_detected_at',
      render: row => new Date(row.first_detected_at).toLocaleDateString(),
    },
    {
      title: 'Details',
      sorting: false,
      cellStyle: { whiteSpace: 'nowrap', width: '1%' },
      headerStyle: { whiteSpace: 'nowrap', width: '1%' },
      render: row => <EntityDetailLink entityId={row.id} />,
    },
  ];

  return (
    <>
      <Box mb={2}>
        <Typography variant="body2" color="textSecondary">
          Entities in the <strong>unresolved</strong> bucket need manual review.
          Either no candidate teams were found, every escalation level passed on
          them, or escalation is disabled. Open an entity to assign an owner or
          archive it.
        </Typography>
      </Box>
      {!loading && !error && (value?.length ?? 0) > 0 && (
        <Box mb={2}>
          <UnresolvedCategoryFilter
            label="Kind"
            counts={kindCounts}
            total={kindTotal}
            selected={kindFilter}
            onSelect={setKindFilter}
          />
          <UnresolvedCategoryFilter
            label="Reason"
            counts={reasonCounts}
            total={reasonTotal}
            selected={reasonFilter}
            onSelect={setReasonFilter}
          />
        </Box>
      )}
      <Table
        title="Unresolved Cases"
        columns={columns}
        data={rows}
        isLoading={loading}
        options={{ paging: true, pageSize: 20, search: true }}
        emptyContent={
          error ? (
            <EmptyState
              message={`Failed to load unresolved cases: ${error.message}`}
              error
            />
          ) : (
            <EmptyState message="No unresolved cases - everything is either active or terminated." />
          )
        }
      />
    </>
  );
}

// ─── Admin Panel ─────────────────────────────────────────────────────────────

const ADMIN_TABS = ['dashboard', 'entities', 'unresolved', 'scans'] as const;
type TabKey = (typeof ADMIN_TABS)[number];

/**
 * Admin tabs, rendered as the "Admin" tab of the Ownership page. The `tab`
 * query param belongs to that page, so the admin sub-tab uses `view`.
 * Callers are responsible for the admin permission gate.
 */
export const OwnershipMatcherAdminPanel = () => {
  const [searchParams, setSearchParams] = useSearchParams();

  const paramView = searchParams.get('view') as TabKey | null;
  const activeTab: TabKey = ADMIN_TABS.includes(paramView as any)
    ? (paramView as TabKey)
    : 'dashboard';
  const tabIndex = ADMIN_TABS.indexOf(activeTab);

  const handleTabChange = (_: unknown, newIndex: number) => {
    setSearchParams(
      { tab: searchParams.get('tab') ?? 'admin', view: ADMIN_TABS[newIndex] },
      { replace: true },
    );
  };

  return (
    <>
      <Tabs value={tabIndex} onChange={handleTabChange}>
        <Tab label="Dashboard" />
        <Tab label="Entities" />
        <Tab label="Unresolved" />
        <Tab label="Scans" />
      </Tabs>
      <Box mt={2}>
        {activeTab === 'dashboard' && <DashboardTab />}
        {activeTab === 'entities' && <EntitiesTab />}
        {activeTab === 'unresolved' && <UnresolvedTab />}
        {activeTab === 'scans' && <ScansTab />}
      </Box>
    </>
  );
};

// ─── Main Page ───────────────────────────────────────────────────────────────

/**
 * Legacy /ownership-matcher root: the admin view now lives in the Admin tab of
 * the Ownership page, so redirect there (keeping the old `?tab=` sub-tab).
 */
export const OwnershipMatcherPage = () => {
  const userProposalsRoute = useRouteRef(userProposalsRouteRef);
  const [searchParams] = useSearchParams();
  const params = new URLSearchParams({ tab: 'admin' });
  const legacyTab = searchParams.get('tab');
  if (legacyTab) params.set('view', legacyTab);
  return <Navigate to={`${userProposalsRoute()}?${params}`} replace />;
};
