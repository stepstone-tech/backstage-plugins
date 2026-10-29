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
  OwnershipCheck,
  OwnershipCheckContext,
  OwnershipCheckResult,
} from './types';
import { isUserRef, normalizeGroupRef, normalizeUserRef } from '../utils';

/** Options for {@link ZombieCheck}. */
export interface ZombieCheckOptions {
  /**
   * When true, entities owned by a User are never flagged. When false
   * (default), a User owner must exist in `liveUserRegistry`.
   */
  excludeUserKind?: boolean;
}

/** Detects entities whose spec.owner references a group (or user) that no longer exists in the catalog (a "zombie" owner). */
export class ZombieCheck implements OwnershipCheck {
  readonly name = 'zombie';
  readonly title = 'Dissolved team (zombie)';
  readonly description =
    'This entity is owned by a team or user that no longer exists in the catalog.';

  private readonly excludeUserKind: boolean;

  constructor(options: ZombieCheckOptions = {}) {
    this.excludeUserKind = options.excludeUserKind ?? false;
  }

  run({
    entity,
    liveGroupRegistry,
    liveUserRegistry,
    orphanedPlaceholders,
  }: OwnershipCheckContext): OwnershipCheckResult {
    const owner = entity.spec?.owner;

    if (!owner || orphanedPlaceholders.has(owner.toLowerCase())) {
      return { failed: false, checkName: this.name };
    }

    if (isUserRef(owner)) {
      if (this.excludeUserKind) {
        return { failed: false, checkName: this.name };
      }
      const normalized = normalizeUserRef(owner);
      if (!liveUserRegistry?.has(normalized)) {
        return {
          failed: true,
          checkName: this.name,
          details: { owner, normalizedRef: normalized },
        };
      }
      return { failed: false, checkName: this.name };
    }

    const normalized = normalizeGroupRef(owner);
    if (!liveGroupRegistry.has(normalized)) {
      return {
        failed: true,
        checkName: this.name,
        details: { owner, normalizedRef: normalized },
      };
    }

    return { failed: false, checkName: this.name };
  }
}
