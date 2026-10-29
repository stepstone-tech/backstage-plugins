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

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorApiRef,
  identityApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import { Link } from '@backstage/core-components';
import { useSignal } from '@backstage/plugin-signals-react';
import { Snackbar } from '@material-ui/core';
import { Alert } from '@material-ui/lab';
import { MyPendingProposalsSummary, ownershipMatcherApiRef } from '../../api';

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const TOAST_DURATION_MS = 7000;

function dismissKey(hash: string): string {
  return `ownership-banner-dismissed:${hash}`;
}

function isDismissed(hash: string): boolean {
  if (!hash) return false;
  try {
    return sessionStorage.getItem(dismissKey(hash)) === '1';
  } catch {
    return false;
  }
}

function markDismissed(hash: string): void {
  if (!hash) return;
  try {
    sessionStorage.setItem(dismissKey(hash), '1');
  } catch {
    // Private browsing or storage disabled — ignored.
  }
}

/**
 * Auto-dismissing toast that surfaces pending ownership proposals for the
 * current user's groups. Shows for 7 seconds on page load, then disappears.
 * Re-shows when the pending-proposal set changes (different hash).
 */
export function PendingProposalsBanner() {
  const identityApi = useApi(identityApiRef);
  const api = useApi(ownershipMatcherApiRef);
  const errorApi = useApi(errorApiRef);

  const { lastSignal } = useSignal('notifications');

  const [summary, setSummary] = useState<MyPendingProposalsSummary | null>(
    null,
  );
  const [open, setOpen] = useState(false);

  const fetchSummary = useCallback(async () => {
    try {
      const identity = await identityApi.getBackstageIdentity();
      if (!identity?.userEntityRef) return;
      const result = await api.getMyPendingProposalsSummary();
      if (result.pendingCount > 0 && !isDismissed(result.hash)) {
        setSummary(result);
        setOpen(true);
      }
    } catch (e) {
      errorApi.post(e as Error);
    }
  }, [api, identityApi, errorApi]);

  const fetchRef = useRef(fetchSummary);
  fetchRef.current = fetchSummary;

  useEffect(() => {
    fetchRef.current();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      fetchRef.current();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (lastSignal) fetchRef.current();
  }, [lastSignal]);

  const handleClose = (_: unknown, reason?: string) => {
    if (reason === 'clickaway') return;
    if (summary) markDismissed(summary.hash);
    setOpen(false);
  };

  if (!summary) return null;

  return (
    <Snackbar
      open={open}
      autoHideDuration={TOAST_DURATION_MS}
      onClose={handleClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
    >
      <Alert severity="info" onClose={e => handleClose(e)}>
        <strong>Ownership Proposals</strong>
        <br />
        Your team has {summary.pendingCount} pending proposal(s) to review.
        <br />
        <Link to={summary.link}>Review now</Link>
      </Alert>
    </Snackbar>
  );
}
