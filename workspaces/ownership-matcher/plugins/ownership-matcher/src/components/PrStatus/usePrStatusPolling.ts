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

import { useEffect, useRef } from 'react';

/** Fast cadence right after accept/retry, when the background kick usually finishes. */
export const PR_POLL_FAST_MS = 3000;
/** Number of fast polls (~1 minute) before slowing down. */
export const PR_POLL_FAST_COUNT = 20;
/** Slow cadence afterwards — the deadline worker may pick the job up up to 15 min later. */
export const PR_POLL_SLOW_MS = 15000;

/**
 * Re-fetches while a catalog-info PR is still being raised (`pr_status:
 * pending`), so "Raising…" turns into "View pull request" (or a failure with
 * Retry) without a page reload. Polls fast at first, then slowly, and stops as
 * soon as the status leaves `pending`.
 *
 * @param opts.pending - whether the displayed PR is currently pending
 * @param opts.loading - whether a fetch is in flight (no timer is armed meanwhile)
 * @param opts.refresh - re-fetch function (e.g. `refetch` from react-query's `useQuery`)
 * @param opts.data - the fetched value; each new value re-arms the next poll
 * @param opts.resetKey - changing it (e.g. a different entity/proposal) restarts the fast phase
 * @returns `restart` — call after a manual action (e.g. Retry) to poll fast again
 */
export function usePrStatusPolling(opts: {
  pending: boolean;
  loading: boolean;
  refresh: () => void;
  data: unknown;
  resetKey?: string | null;
}): { restart: () => void } {
  const { pending, loading, refresh, data, resetKey } = opts;
  const polls = useRef(0);

  useEffect(() => {
    polls.current = 0;
  }, [resetKey]);

  useEffect(() => {
    if (!pending) {
      polls.current = 0;
      return undefined;
    }
    if (loading) return undefined;
    const delay =
      polls.current < PR_POLL_FAST_COUNT ? PR_POLL_FAST_MS : PR_POLL_SLOW_MS;
    const timer = setTimeout(() => {
      polls.current += 1;
      refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [pending, loading, data, refresh]);

  return {
    restart: () => {
      polls.current = 0;
      refresh();
    },
  };
}
