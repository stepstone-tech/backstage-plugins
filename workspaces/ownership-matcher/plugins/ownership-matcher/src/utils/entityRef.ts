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

export function entityRefToCatalogPath(ref: string): string {
  const match = ref.match(/^([^:]+):([^/]+)\/(.+)$/);
  return match ? `/catalog/${match[2]}/${match[1]}/${match[3]}` : '/catalog';
}

export function displayRef(ref: string | null | undefined): string {
  if (!ref) return '—';
  return ref.replace(/^(?:group|user):[^/]+\//, '');
}

export function displayGroupRef(ref: string): string {
  return ref.replace(/^group:[^/]+\//, '');
}

export function displayActor(ref: string): string {
  const name = ref.replace(/^user:[^/]+\//, '');
  return name.replace(/_([^_]+\.[^_]+)$/, '@$1');
}
