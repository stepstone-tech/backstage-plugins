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

import { isDeepStrictEqual } from 'node:util';
import { isMap, isScalar, parse, parseAllDocuments } from 'yaml';

/** Identifies which document in a (possibly multi-document) catalog-info file to edit. */
export interface CatalogEntityTarget {
  kind: string;
  name: string;
  namespace?: string;
}

/** Outcome of {@link setSpecOwner}. */
export type SetSpecOwnerResult =
  | {
      status: 'changed';
      content: string;
      /** The edited document as plain JSON — what gets sent to the catalog validator. */
      entity: Record<string, unknown>;
    }
  | { status: 'unchanged' }
  | { status: 'entity-not-found' }
  | { status: 'parse-error'; message: string };

/**
 * Sets `spec.owner` of the matching entity in a catalog-info YAML file while
 * preserving everything else byte-for-byte (comments, ordering, quoting,
 * blank lines, other documents).
 *
 * Uses the `yaml` Document API (not `js-yaml`, which drops comments). When the
 * entity already has a scalar `spec.owner`, only that scalar's source range is
 * replaced — keeping its quote style. When `spec.owner` is absent, the target
 * document is edited via `setIn` and the file re-serialised.
 *
 * The result is re-parsed and checked: it must be valid YAML and differ from
 * the original only in the target entity's `spec.owner`.
 */
export function setSpecOwner(
  content: string,
  target: CatalogEntityTarget,
  ownerRef: string,
): SetSpecOwnerResult {
  const docs = parseAllDocuments(content);
  if (!Array.isArray(docs)) {
    return { status: 'entity-not-found' };
  }
  const broken = docs.find(d => d.errors.length > 0);
  if (broken) {
    return { status: 'parse-error', message: broken.errors[0].message };
  }

  const originals = docs.map(d => d.toJS() as unknown);
  const index = originals.findIndex(js => matchesTarget(js, target));
  if (index < 0) {
    return { status: 'entity-not-found' };
  }
  const doc = docs[index];

  const current = doc.getIn(['spec', 'owner'], true);
  if (isScalar(current) && current.value === ownerRef) {
    return { status: 'unchanged' };
  }

  let updated: string;
  if (isScalar(current) && current.range) {
    const [start, valueEnd] = current.range;
    updated =
      content.slice(0, start) +
      formatScalar(ownerRef, current.type) +
      content.slice(valueEnd);
  } else {
    if (!isMap(doc.get('spec', true))) {
      // No `spec` mapping to put the owner in — not a shape we can safely edit.
      return {
        status: 'parse-error',
        message: 'entity has no `spec` mapping',
      };
    }
    doc.setIn(['spec', 'owner'], ownerRef);
    updated = docs.map(String).join('');
  }

  // Self-check: valid YAML, and nothing but the target's spec.owner changed.
  const reparsed = parseAllDocuments(updated);
  if (!Array.isArray(reparsed) || reparsed.some(d => d.errors.length > 0)) {
    return { status: 'parse-error', message: 'edited file is not valid YAML' };
  }
  const after = reparsed.map(d => d.toJS() as unknown);
  const expected = originals.map((js, i) =>
    i === index ? withOwner(js, ownerRef) : js,
  );
  if (!isDeepStrictEqual(after, expected)) {
    return {
      status: 'parse-error',
      message: 'edit changed more than spec.owner',
    };
  }

  return {
    status: 'changed',
    content: updated,
    entity: after[index] as Record<string, unknown>,
  };
}

/**
 * Owner value as written to catalog-info files: a `group:default/<name>` ref becomes the bare
 * `<name>` (e.g. `team-a`); any other ref is kept verbatim.
 */
export function toCatalogOwnerValue(ownerRef: string): string {
  const prefix = 'group:default/';
  return ownerRef.startsWith(prefix) ? ownerRef.slice(prefix.length) : ownerRef;
}

function matchesTarget(js: unknown, target: CatalogEntityTarget): boolean {
  if (!js || typeof js !== 'object') return false;
  const entity = js as {
    kind?: unknown;
    metadata?: { name?: unknown; namespace?: unknown };
  };
  return (
    typeof entity.kind === 'string' &&
    entity.kind.toLowerCase() === target.kind.toLowerCase() &&
    entity.metadata?.name === target.name &&
    (entity.metadata?.namespace ?? 'default') ===
      (target.namespace ?? 'default')
  );
}

function withOwner(js: unknown, ownerRef: string): unknown {
  const entity = js as { spec?: Record<string, unknown> };
  return { ...entity, spec: { ...entity.spec, owner: ownerRef } };
}

/** Render `value` in the original scalar's quote style, falling back to double quotes when a plain scalar would not round-trip. */
function formatScalar(value: string, type: string | undefined): string {
  if (type === 'QUOTE_SINGLE') {
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (type === 'QUOTE_DOUBLE') {
    return JSON.stringify(value);
  }
  return isSafePlain(value) ? value : JSON.stringify(value);
}

function isSafePlain(value: string): boolean {
  if (value === '' || /[\n\r#]/.test(value)) return false;
  try {
    return parse(value) === value;
  } catch {
    return false;
  }
}
