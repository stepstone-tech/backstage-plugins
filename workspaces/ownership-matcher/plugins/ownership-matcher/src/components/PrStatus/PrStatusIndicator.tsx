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
import {
  StatusAborted,
  StatusError,
  StatusOK,
  StatusPending,
  StatusWarning,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import { toastApiRef } from '@backstage/frontend-plugin-api';
import { Box, Button, Link as MuiLink, Typography } from '@material-ui/core';
import { OwnershipEntity, ownershipMatcherApiRef } from '../../api';

/**
 * Shows the state of the catalog-info `spec.owner` PR raised after an
 * ownership acceptance: pending → raised (with link) / failed
 * (with reason and a retry button) / unsupported_scm (no SCM provider can
 * raise PRs for the repository host; retry once one is installed). After
 * reconciliation against the catalog: completed (catalog owner
 * updated) / declined (with a retry button) / superseded (someone else
 * changed the owner). Renders nothing for `none`/absent.
 */
export function PrStatusIndicator({
  entity,
  onChanged,
}: Readonly<{
  entity: OwnershipEntity;
  /** Called after a successful retry so the caller can re-fetch. */
  onChanged?: () => void;
}>) {
  const api = useApi(ownershipMatcherApiRef);
  const toastApi = useApi(toastApiRef);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await api.retryPrCreation(entity.id);
      toastApi.post({
        title:
          'Retrying — the catalog-info pull request is being raised again.',
        status: 'info',
        timeout: 5000,
      });
      onChanged?.();
    } catch (err) {
      toastApi.post({
        title: `Failed to retry pull request: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: 'danger',
      });
    } finally {
      setRetrying(false);
    }
  };

  const retryButton = (
    <Box mt={1}>
      <Button
        size="small"
        variant="outlined"
        color="primary"
        disabled={retrying}
        onClick={handleRetry}
      >
        Retry
      </Button>
    </Box>
  );

  const prLink = entity.pr_url && (
    <Box mt={0.5}>
      <MuiLink
        href={entity.pr_url}
        target="_blank"
        rel="noopener noreferrer"
        variant="caption"
      >
        View pull request
      </MuiLink>
    </Box>
  );

  switch (entity.pr_status) {
    case 'pending':
      return (
        <Typography variant="body2" component="div">
          <StatusPending>Raising catalog-info pull request…</StatusPending>
        </Typography>
      );
    case 'raised':
      return (
        <Typography variant="body2" component="div">
          <StatusOK>Pull request raised</StatusOK>
          {prLink}
        </Typography>
      );
    case 'completed':
      return (
        <Typography variant="body2" component="div">
          <StatusOK>Catalog owner updated</StatusOK>
          {prLink}
        </Typography>
      );
    case 'declined':
      return (
        <Box>
          <Typography variant="body2" component="div">
            <StatusWarning>Pull request declined</StatusWarning>
          </Typography>
          {entity.pr_last_error && (
            <Typography variant="caption" color="textSecondary" component="div">
              {entity.pr_last_error}
            </Typography>
          )}
          {prLink}
          {retryButton}
        </Box>
      );
    case 'superseded':
      return (
        <Box>
          <Typography variant="body2" component="div">
            <StatusAborted>Owner changed by someone else</StatusAborted>
          </Typography>
          <Typography variant="caption" color="textSecondary" component="div">
            The catalog owner was changed outside this case; no further pull
            requests are raised.
          </Typography>
          {prLink}
        </Box>
      );
    case 'failed':
      return (
        <Box>
          <Typography variant="body2" component="div">
            <StatusError>Pull request could not be raised</StatusError>
          </Typography>
          {entity.pr_last_error && (
            <Typography variant="caption" color="textSecondary" component="div">
              {entity.pr_last_error}
              {entity.pr_attempts ? ` (attempt ${entity.pr_attempts})` : ''}
            </Typography>
          )}
          {retryButton}
        </Box>
      );
    case 'unsupported_scm':
      return (
        <Box>
          <Typography variant="body2" component="div">
            <StatusWarning>
              Pull request not supported for this repository host
            </StatusWarning>
          </Typography>
          {entity.pr_last_error && (
            <Typography variant="caption" color="textSecondary" component="div">
              {entity.pr_last_error}
            </Typography>
          )}
          {retryButton}
        </Box>
      );
    default:
      return null;
  }
}
