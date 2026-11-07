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

interface GitLabErrorBody {
  /**
   * A string, a list of strings (`["Another open merge request already
   * exists..."]`), or field → messages for validation errors
   * (`{ base: ['...'] }`).
   */
  message?: string | string[] | Record<string, unknown>;
  error?: string;
  error_description?: string;
}

/**
 * GitLab's error message: `message` (flattening a field → messages object),
 * else `error`/`error_description`, falling back to a truncated body.
 */
export function gitlabErrorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as GitLabErrorBody;
    if (typeof body.message === 'string' && body.message) return body.message;
    if (Array.isArray(body.message)) {
      const parts = body.message
        .filter(m => m !== undefined && m !== null && m !== '')
        .map(String);
      if (parts.length) return parts.join('; ');
    }
    if (body.message && typeof body.message === 'object') {
      const parts = Object.entries(body.message).flatMap(([field, value]) => {
        const messages = Array.isArray(value) ? value : [value];
        return messages
          .filter(m => m !== undefined && m !== null && m !== '')
          .map(m => (field === 'base' ? String(m) : `${field} ${String(m)}`));
      });
      if (parts.length) return parts.join('; ');
    }
    const error = [body.error, body.error_description]
      .filter(Boolean)
      .join(': ');
    if (error) return error;
  } catch {
    // Not JSON — use the raw body.
  }
  return text.slice(0, 200);
}

/**
 * GitLab reports a stale `last_commit_id` ("You are attempting to update a
 * file that has changed since you started editing it.") and an existing
 * branch or file ("Branch already exists", "A file with this name already
 * exists") as 400s. Both mean "conflict" in the SCM contract.
 */
function isConflictMessage(message: string): boolean {
  return /changed since you started editing|already exists/i.test(message);
}

/**
 * Archived projects and GitLab's read-only (maintenance/migration) mode reject
 * writes with statuses that otherwise mean auth or availability problems.
 * Detect them by the error text so callers back off instead of treating them
 * as permanent auth failures or retrying quickly.
 */
function isReadOnly(message: string): boolean {
  return /archiv|read[- ]?only|maintenance mode/i.test(message);
}

/** Map a failed GitLab response onto an {@link ScmError}. */
export function toScmError(status: number, text: string): ScmError {
  const message = gitlabErrorMessage(text);
  let kind: ScmErrorKind;
  if ((status === 400 || status === 409) && isConflictMessage(message)) {
    kind = 'conflict';
  } else if (isReadOnly(message) && status !== 404) {
    kind = 'read-only';
  } else if (status === 401 || status === 403) {
    kind = 'auth';
  } else if (status === 404) {
    kind = 'not-found';
  } else if (status === 409) {
    kind = 'conflict';
  } else if (status === 429) {
    kind = 'rate-limited';
  } else if (status === 400 || status === 422) {
    kind = 'invalid';
  } else if (status >= 500) {
    kind = 'unavailable';
  } else {
    kind = 'unknown';
  }
  return new ScmError(kind, message || `HTTP ${status}`, {
    httpStatus: status,
  });
}
