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

/** Normalizes an owner reference to a fully qualified group ref. */
export function normalizeGroupRef(owner: string): string {
  if (owner.startsWith('group:default/')) return owner;
  if (owner.startsWith('group:')) {
    const rest = owner.slice('group:'.length);
    if (rest.includes('/')) return owner;
    return `group:default/${rest}`;
  }
  if (owner.includes(':')) return owner;
  return `group:default/${owner}`;
}

/** Returns true when an owner reference points at a User entity (`user:...`). */
export function isUserRef(owner: string): boolean {
  return owner.toLowerCase().startsWith('user:');
}

/** Normalizes a `user:` owner reference to a fully qualified, lowercased user ref. */
export function normalizeUserRef(owner: string): string {
  const rest = owner.slice('user:'.length);
  const ref = rest.includes('/') ? `user:${rest}` : `user:default/${rest}`;
  return ref.toLowerCase();
}
