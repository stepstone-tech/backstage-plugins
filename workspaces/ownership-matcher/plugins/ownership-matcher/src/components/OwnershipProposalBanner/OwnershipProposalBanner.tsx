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

import { useEntity } from '@backstage/plugin-catalog-react';
import { stringifyEntityRef } from '@backstage/catalog-model';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';
import { useQuery } from '@tanstack/react-query';
import { useTeamProposals } from '../../hooks/useTeamProposals';
import { QueryProvider } from '../../query/QueryProvider';
import { Button, Box, Typography } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import AssignmentIndIcon from '@material-ui/icons/AssignmentInd';
import { queryKeys } from '../../query/keys';

// The plugin's own pages get their `QueryProvider` from the page loaders in
// alpha.tsx. This one is exported for host apps to mount on their catalog
// entity page, outside this plugin's extension tree, so it brings its own.
// Safe to nest: every provider reads the same module singleton.
export function OwnershipProposalBanner() {
  return (
    <QueryProvider>
      <OwnershipProposalBannerContent />
    </QueryProvider>
  );
}

function OwnershipProposalBannerContent() {
  const { entity } = useEntity();
  const identityApi = useApi(identityApiRef);

  const entityRef = stringifyEntityRef(entity);

  const { data: groups } = useQuery({
    queryKey: queryKeys.identityGroups(),
    queryFn: async () => {
      const identity = await identityApi.getBackstageIdentity();
      return identity.ownershipEntityRefs.filter(ref =>
        ref.startsWith('group:'),
      );
    },
  });

  // Shares its cache entry with PendingTab/PossibleOwnersSection — the same
  // team's pending list, keyed the same way. Disabled until `groups`
  // resolves non-empty, matching the original's "no groups → no request".
  const hasGroups = (groups?.length ?? 0) > 0;
  const { data } = useTeamProposals(groups ?? [], ['pending'], {
    enabled: hasGroups,
  });
  const hasPendingProposal =
    hasGroups &&
    (data?.items.some(item => item.entity.entity_ref === entityRef) ?? false);

  if (!hasPendingProposal) return null;

  return (
    <Alert
      severity="warning"
      icon={<AssignmentIndIcon fontSize="inherit" />}
      action={
        <Button
          color="inherit"
          size="small"
          variant="outlined"
          href="/my-ownership-proposals"
        >
          View proposals
        </Button>
      }
    >
      <Box>
        <Typography variant="body2" style={{ fontWeight: 600 }}>
          Your team has a pending ownership proposal for this entity
        </Typography>
        <Typography variant="caption">
          Review and accept or reject it on your ownership proposals page.
        </Typography>
      </Box>
    </Alert>
  );
}
