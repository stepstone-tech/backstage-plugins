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

/**
 * Classified SCM failure.
 *
 * - `auth`         — credentials missing, invalid or lacking scope.
 * - `not-found`    — repository, branch or PR does not exist.
 * - `conflict`     — stale revision on commit (re-read and retry).
 * - `read-only`    — repository is archived or read-only (e.g. mid-migration).
 * - `rate-limited` — throttled by the SCM.
 * - `unavailable`  — network error, timeout or 5xx.
 * - `invalid`      — the SCM rejected the request as malformed, e.g. an invalid reviewer.
 * - `unknown`      — anything else.
 *
 * @public
 */
export type ScmErrorKind =
  | 'auth'
  | 'not-found'
  | 'conflict'
  | 'read-only'
  | 'rate-limited'
  | 'unavailable'
  | 'invalid'
  | 'unknown';

const RETRYABLE_BY_DEFAULT: ReadonlySet<ScmErrorKind> = new Set([
  'conflict',
  'read-only',
  'rate-limited',
  'unavailable',
  'unknown',
]);

/**
 * Error thrown by {@link ScmClient} capabilities.
 *
 * @public
 */
export class ScmError extends Error {
  readonly kind: ScmErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  /** Reviewers the SCM refused (e.g. the PR author, users without access), when it names them. */
  readonly rejectedReviewers?: string[];

  constructor(
    kind: ScmErrorKind,
    message: string,
    opts: {
      retryable?: boolean;
      httpStatus?: number;
      cause?: unknown;
      rejectedReviewers?: string[];
    } = {},
  ) {
    super(
      message,
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'ScmError';
    this.kind = kind;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(kind);
    this.httpStatus = opts.httpStatus;
    if (opts.rejectedReviewers?.length)
      this.rejectedReviewers = opts.rejectedReviewers;
  }
}

/**
 * Name-based guard, so it also works across duplicated package copies.
 *
 * @public
 */
export function isScmError(err: unknown): err is ScmError {
  return (
    err instanceof Error &&
    err.name === 'ScmError' &&
    typeof (err as Partial<ScmError>).kind === 'string'
  );
}
