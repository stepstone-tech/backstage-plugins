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

import { OwnershipHistory } from '../api';
import { displayRef } from './entityRef';

/** Human-readable resolution type label */
export function resolutionLabel(rt: string | null | undefined): string {
  if (!rt) return '—';
  if (rt === 'ownership_changed') return 'Ownership Changed';
  if (rt === 'archived') return 'Archived';
  return rt;
}

/** Parse check_details — handles both string (TEXT column) and pre-parsed object (JSONB) */
function parseDetails(
  raw: string | null | unknown,
): Record<string, any> | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw as Record<string, any>;
  try {
    return JSON.parse(raw as string);
  } catch {
    return null;
  }
}

/** Signal key → human-readable label */
const REASON_LABELS: Record<string, string> = {
  top_contributor: 'Top Contributor',
  org_proximity_system: 'Org Proximity',
  org_proximity_manual: 'Org Proximity (manual)',
  fallback: 'Fallback',
};

/** Parse confidence_reason (JSON array string or plain string) into labels */
export function parseReasons(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.map((r: string) => REASON_LABELS[r] ?? r);
  } catch {
    /* not JSON */
  }
  return [REASON_LABELS[raw] ?? raw];
}

/** Formats a single value from history details: cleans refs, arrays, objects */
function formatDetailValue(v: unknown): string {
  if (Array.isArray(v)) {
    return (v as unknown[])
      .map(i => (typeof i === 'string' ? REASON_LABELS[i] ?? i : String(i)))
      .join(', ');
  }
  if (typeof v === 'string' && /^(group|user):/.test(v)) return displayRef(v);
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

export function renderHistoryDetails(
  action: string,
  raw: string | null | unknown,
): string {
  const obj = parseDetails(raw);
  if (!obj) return typeof raw === 'string' && raw ? raw : '—';

  if (action === 'issue_detected' || action === 'issue_redetected') {
    const cn: string = obj.checkName || '';
    const cd = obj.checkDetails;
    if (cn === 'zombie' && cd?.owner)
      return `Zombie, former owner: ${displayRef(String(cd.owner))}`;
    if (cn === 'orphaned') return 'Orphaned, no owner set';
    return cn || '—';
  }
  if (action === 'pr_raised' || action === 'pr_reused') {
    return obj.prUrl ? String(obj.prUrl) : '—';
  }
  if (action === 'pr_creation_failed') {
    const parts = [
      `Attempt ${obj.attempt ?? '?'}: ${obj.reason ?? 'unknown error'}`,
    ];
    if (obj.nextRetryAt) {
      parts.push(
        `retry at ${new Date(String(obj.nextRetryAt)).toLocaleString()}`,
      );
    }
    return parts.join(', ');
  }
  if (action === 'pr_completed') {
    return obj.acceptedOwner
      ? `Catalog owner is now ${displayRef(String(obj.acceptedOwner))}`
      : 'Catalog owner updated';
  }
  if (action === 'pr_superseded') {
    return obj.catalogOwner
      ? `Owner changed to ${displayRef(
          String(obj.catalogOwner),
        )} outside this case`
      : 'Owner changed outside this case';
  }
  if (action === 'pr_declined') {
    return obj.reason === 'pr_not_found'
      ? 'Pull request not found (deleted, or the repository moved)'
      : 'Pull request declined';
  }
  if (action === 'pr_not_applied') {
    const owner = obj.catalogOwner
      ? displayRef(String(obj.catalogOwner))
      : 'none';
    return `Merged, but the catalog still shows owner ${owner}`;
  }
  if (action === 'pr_creation_skipped') {
    if (obj.reason === 'already_up_to_date')
      return 'catalog-info.yaml already has this owner';
    if (obj.reason === 'unsupported_scm') {
      return `Repository host not supported${
        obj.message ? `: ${obj.message}` : ''
      }`;
    }
    return String(obj.reason ?? '—');
  }
  if (action === 'issue_auto_closed') {
    return 'Ownership resolved, issue auto-closed';
  }
  if (action === 'proposal_created') {
    const parts: string[] = [];
    if (obj.ownerRef)
      parts.push(`Proposed to: ${displayRef(String(obj.ownerRef))}`);
    if (Array.isArray(obj.reasons) && obj.reasons.length > 0) {
      parts.push(
        obj.reasons.map((r: string) => REASON_LABELS[r] ?? r).join(', '),
      );
    }
    if (obj.score !== null && obj.score !== undefined) {
      parts.push(`${(Number(obj.score) * 100).toFixed(0)}% confidence`);
    }
    return parts.join(', ') || '—';
  }
  if (action === 'proposal_notified') {
    return obj.ownerRef
      ? `Notified: ${displayRef(String(obj.ownerRef))}`
      : 'Notification sent';
  }
  if (action === 'proposal_accepted') {
    const parts: string[] = [];
    if (obj.ownerRef) parts.push(`Team: ${displayRef(String(obj.ownerRef))}`);
    if (obj.note) parts.push(`Note: ${obj.note}`);
    return parts.join(', ') || '—';
  }
  if (action === 'proposal_rejected') {
    const parts: string[] = [];
    if (obj.ownerRef) parts.push(`Team: ${displayRef(String(obj.ownerRef))}`);
    if (obj.reason) parts.push(`Reason: ${obj.reason}`);
    return parts.join(', ') || '—';
  }
  if (action === 'proposal_expired') {
    return obj.ownerRef
      ? `Team: ${displayRef(String(obj.ownerRef))}`
      : 'No response';
  }
  if (action === 'entity_accepted') {
    const parts: string[] = [];
    if (obj.ownerRef)
      parts.push(`Resolved for: ${displayRef(String(obj.ownerRef))}`);
    if (obj.via) parts.push(`via ${String(obj.via).replace(/_/g, ' ')}`);
    if (obj.note) parts.push(`Note: ${obj.note}`);
    return parts.join(', ') || '—';
  }
  if (action === 'entity_reopened') {
    return 'Reopened';
  }
  if (action === 'reopened_candidates_found') {
    const previousReason = obj.previousReason;
    const reason =
      previousReason === null || previousReason === undefined
        ? 'unresolved'
        : reasonLabel(String(previousReason));
    const since = obj.previousReasonAt
      ? ` (since ${new Date(
          String(obj.previousReasonAt),
        ).toLocaleDateString()})`
      : '';
    const candidates = Array.isArray(obj.candidates)
      ? (
          obj.candidates as Array<{
            ownerRef?: string;
            score?: number;
            status?: string;
          }>
        )
          .map(c => {
            const tier =
              c.status === 'possible_owner' ? 'possible owner' : 'proposal';
            const score =
              typeof c.score === 'number' ? `${c.score.toFixed(2)}, ` : '';
            return `${displayRef(String(c.ownerRef))} (${score}${tier})`;
          })
          .join(', ')
      : '';
    return `Left unresolved: ${reason}${since}${
      candidates ? `. Candidates found: ${candidates}` : ''
    }`;
  }
  if (action === 'entity_to_archive') {
    return obj.via
      ? `Marked for archive via ${String(obj.via).replace(/_/g, ' ')}`
      : 'Marked for archive';
  }
  if (action === 'escalation_triggered') {
    if (obj.reason === 'candidates_exhausted') return 'All proposals exhausted';
    if (obj.reason === 'no_candidates_found')
      return 'No candidates found, escalated to admin';
    return 'Escalated';
  }
  if (action === 'escalation_passed') {
    const parts: string[] = [];
    if (obj.fromRole) parts.push(`from ${obj.fromRole}`);
    if (obj.toRole) parts.push(`to ${obj.toRole}`);
    return parts.join(', ') || '—';
  }
  // Generic fallback — skip noisy internal fields, clean refs and arrays
  const entries = Object.entries(obj).filter(
    ([k]) => !['checkDetails', 'normalizedRef', 'entityRef'].includes(k),
  );
  return entries.length > 0
    ? entries.map(([k, v]) => `${k}: ${formatDetailValue(v)}`).join(', ')
    : '—';
}

const UNRESOLVED_REASON_ACTIONS = new Set([
  'no_candidates_found',
  'escalation_exhausted',
  'no_candidates_after_retrigger',
]);

export function reasonLabel(action: string): string {
  switch (action) {
    case 'no_candidates_found':
      return 'No candidates';
    case 'escalation_exhausted':
      return 'Escalation exhausted';
    case 'no_candidates_after_retrigger':
      return 'No candidates after retrigger';
    default:
      return action;
  }
}

export function latestUnresolvedReason(
  history: OwnershipHistory[],
): OwnershipHistory | undefined {
  return [...history]
    .reverse()
    .find(h => UNRESOLVED_REASON_ACTIONS.has(h.action));
}
