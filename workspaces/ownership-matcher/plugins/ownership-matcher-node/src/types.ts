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

// ─── Catalog entity (lightweight projection used internally) ─────────────────

export interface ComponentMetadata {
  name: string;
  namespace?: string;
  annotations?: Record<string, string>;
  userDetails?: { jobTitle?: string; [key: string]: unknown };
}

export interface CatalogComponent {
  kind: string;
  metadata: ComponentMetadata;
  spec?: {
    owner?: string;
    memberOf?: string[];
    system?: string;
    domain?: string;
    lifecycle?: string;
    type?: string;
    profile?: { title?: string; [key: string]: unknown };
  };
}

/**
 * Lightweight per-User projection used for org-wide title matching and
 * CODEOWNERS owner-token resolution. `alias` is the preferred owner token;
 * `email` is the fallback.
 */
export interface CatalogUserDetail {
  /** User entity ref (`user:<namespace>/<name>`). */
  userRef: string;
  /** `metadata.userDetails.jobTitle`, falling back to `spec.profile.title`. */
  jobTitle: string | undefined;
  /** Value of the configured user-alias annotation, if any. */
  alias: string | undefined;
  /** `spec.profile.email`, if present. */
  email: string | undefined;
}

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface EntityFilters {
  excludeKinds: string[];
  requireAnnotations: string[];
  excludeOwners: string[];
  excludeNamespaces: string[];
  /** `Kind:type` pairs to skip, e.g. `Resource:cloud-account` (case-insensitive). */
  excludeTypes: string[];
}
