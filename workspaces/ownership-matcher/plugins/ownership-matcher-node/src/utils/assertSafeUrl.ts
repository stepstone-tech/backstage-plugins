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

const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Parse and validate an outbound URL before it reaches `fetch`: only http(s),
 * and — when `allowedHosts` is non-empty — only those hosts (`host` incl. port).
 * Throws on violation.
 */
export function assertSafeUrl(
  raw: string,
  allowedHosts?: ReadonlyArray<string>,
): URL {
  const parsed = new URL(raw);
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error(
      `assertSafeUrl: refusing request to disallowed scheme "${parsed.protocol}"`,
    );
  }
  if (
    allowedHosts &&
    allowedHosts.length > 0 &&
    !allowedHosts.includes(parsed.host)
  ) {
    throw new Error(
      `assertSafeUrl: host "${parsed.host}" is not in the allowed-hosts list`,
    );
  }
  return parsed;
}
