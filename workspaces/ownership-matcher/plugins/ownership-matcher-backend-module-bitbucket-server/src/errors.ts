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
  ScmError,
  type ScmErrorKind,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

interface BitbucketErrorBody {
  errors?: Array<{
    message?: string;
    exceptionName?: string;
    /** Set on `InvalidPullRequestReviewersException`: `context` is the rejected username. */
    reviewerErrors?: Array<{ context?: string | null; message?: string }>;
  }>;
}

interface BitbucketErrorDetails {
  message: string;
  exceptionName?: string;
  rejectedReviewers?: string[];
}

/**
 * Bitbucket's `errors[0]` message + exception name, falling back to a
 * truncated body. Per-reviewer errors are appended to the message and their
 * usernames returned as `rejectedReviewers`.
 */
function bitbucketErrorDetails(text: string): BitbucketErrorDetails {
  try {
    const first = (JSON.parse(text) as BitbucketErrorBody).errors?.[0];
    if (first?.message) {
      const reviewerErrors = first.reviewerErrors ?? [];
      const rejectedReviewers = reviewerErrors
        .map(r => r.context)
        .filter((c): c is string => Boolean(c));
      const reasons = reviewerErrors
        .map(r => [r.context, r.message].filter(Boolean).join(': '))
        .filter(Boolean);
      return {
        message: reasons.length
          ? `${first.message} (${reasons.join('; ')})`
          : first.message,
        exceptionName: first.exceptionName,
        ...(rejectedReviewers.length ? { rejectedReviewers } : {}),
      };
    }
  } catch {
    // Not JSON — use the raw body.
  }
  return { message: text.slice(0, 200) };
}

/**
 * Bitbucket rejects a PR whose reviewers it can't add (the author, users
 * without repo access, inactive users) with a 409 — not a merge/duplicate
 * conflict, so classify it as `invalid`.
 */
function isReviewerError(details: BitbucketErrorDetails): boolean {
  return (
    Boolean(details.rejectedReviewers?.length) ||
    /InvalidPullRequestReviewersException$/.test(details.exceptionName ?? '')
  );
}

/**
 * Archived repositories and Bitbucket's read-only (maintenance/migration)
 * mode reject writes with 4xx/5xx statuses that otherwise mean auth or
 * availability problems. Detect them by the error text so callers back off
 * instead of treating them as permanent auth failures or retrying quickly.
 */
function isReadOnly(details: {
  message: string;
  exceptionName?: string;
}): boolean {
  return /archiv|read[- ]?only/i.test(
    `${details.exceptionName ?? ''} ${details.message}`,
  );
}

/** Map a failed Bitbucket Server response onto an {@link ScmError}. */
export function toScmError(status: number, text: string): ScmError {
  const details = bitbucketErrorDetails(text);
  let kind: ScmErrorKind;
  // Reviewer errors first: their message includes usernames, which could
  // match the read-only pattern (e.g. `archive-bot`).
  if (isReviewerError(details)) {
    kind = 'invalid';
  } else if (isReadOnly(details) && status !== 404) {
    kind = 'read-only';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 409) {
    kind = 'conflict';
  } else if (status === 429) {
    kind = 'rate-limited';
  } else if (status === 400) {
    kind = 'invalid';
  } else if (status >= 500) {
    kind = 'unavailable';
  } else {
    kind = 'unknown';
  }
  return new ScmError(kind, details.message || `HTTP ${status}`, {
    httpStatus: status,
    rejectedReviewers: details.rejectedReviewers,
  });
}
