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

/** Detects entities whose spec.owner is missing or set to a configured placeholder value (e.g. */
export class OrphanedCheck implements OwnershipCheck {
  readonly name = 'orphaned';
  readonly title = 'No owner (orphaned)';
  readonly description =
    'This entity has no owner defined in the catalog YAML.';

  run({
    entity,
    orphanedPlaceholders,
  }: OwnershipCheckContext): OwnershipCheckResult {
    const owner = entity.spec?.owner;

    if (!owner || orphanedPlaceholders.has(owner.toLowerCase())) {
      return {
        failed: true,
        checkName: this.name,
        details: { owner: owner ?? null },
      };
    }

    return { failed: false, checkName: this.name };
  }
}
