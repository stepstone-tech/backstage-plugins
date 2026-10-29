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

import { DefinitionsResponse, CheckDefinition, SignalDefinition } from '../api';

export function parseSignalKeys(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
    return [String(parsed)];
  } catch {
    return raw ? [raw] : [];
  }
}

// ─── Signal / check description lookups ──────────────────────────────────────

export function findSignal(
  definitions: DefinitionsResponse,
  key: string,
): SignalDefinition {
  return (
    definitions.signals.find(s => s.key === key) ?? {
      key,
      title: key,
      description: '',
    }
  );
}

export function findCheck(
  definitions: DefinitionsResponse,
  key: string,
): CheckDefinition {
  return (
    definitions.checks.find(c => c.key === key) ?? {
      key,
      title: key,
      description: '',
    }
  );
}

// Stable per-check color derived from the check key. Same key always maps to
// the same palette slot, so each check gets a consistent visual identity
// without hardcoding orphan/zombie/etc. in the UI. We use a curated palette
// of 8 well-separated hues so adjacent picks stay visually distinct (a raw
// hash % 360 collapses similar short strings into neighbouring hues).
const CHECK_HUE_PALETTE = [25, 350, 200, 130, 280, 50, 175, 310];

export function colorForCheck(key: string): {
  border: string;
  chipBg: string;
  chipBorder: string;
  chipText: string;
} {
  // djb2 — good distribution on short strings, unlike (h*31+c).
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash * 33) ^ key.charCodeAt(i)) | 0;
  }
  const hue = CHECK_HUE_PALETTE[Math.abs(hash) % CHECK_HUE_PALETTE.length];
  return {
    border: `hsl(${hue}, 70%, 50%)`,
    chipBg: `hsla(${hue}, 70%, 50%, 0.15)`,
    chipBorder: `hsla(${hue}, 70%, 50%, 0.4)`,
    chipText: `hsl(${hue}, 70%, 45%)`,
  };
}

export function formatConfidenceReason(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((r: string) => r.replace(/_/g, ' ')).join(', ');
    }
  } catch {
    // not JSON, use as-is
  }
  return raw;
}
