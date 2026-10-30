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

import { LoggerService } from '@backstage/backend-plugin-api';
import { OwnershipStore } from '../service/DatabaseOwnershipStore';

/** Single boundary call for "this entity exhausted its proposals — escalate it." */
export interface EscalationTrigger {
  triggerEscalation(entityId: string): Promise<void>;
}

/** Resolves the wiring cycle between {@link EntityProcessingService}, `OwnershipMatcherService`, and `EscalationService`. */
export class LazyEscalationTrigger implements EscalationTrigger {
  private inner?: EscalationTrigger;

  /** Wire (or rewire) the real implementation. */
  set(impl: EscalationTrigger): void {
    if (!impl) {
      throw new Error(
        'LazyEscalationTrigger.set called without an implementation — wiring bug',
      );
    }
    this.inner = impl;
  }

  async triggerEscalation(entityId: string): Promise<void> {
    if (!this.inner) {
      throw new Error('escalation trigger accessed before wiring complete');
    }
    return this.inner.triggerEscalation(entityId);
  }
}

/** No-op-with-bookkeeping implementation used when escalation config is absent. */
export class FallbackEscalationTrigger implements EscalationTrigger {
  constructor(
    private readonly store: OwnershipStore,
    private readonly logger: LoggerService,
  ) {}

  async triggerEscalation(entityId: string): Promise<void> {
    const flipped = await this.store.withTransaction(async stores => {
      const entity = await stores.entityStore.getEntityById(entityId);
      if (!entity) return false;
      if (entity.current_status !== 'open') return false;
      // Same rule as `DefaultEscalationService.triggerEscalation`: under
      // broadcast, sibling proposals stay live after one team rejects, so the
      // case only becomes unresolved once none is pending.
      // `possible_owner` rows were never notified and don't count.
      const proposals = await stores.proposalStore.listProposalsByEntity(
        entityId,
      );
      if (proposals.some(p => p.status === 'pending')) {
        return false;
      }
      // A case whose earlier proposals were rejected/expired is not
      // "only possible owners", even if possible owners exist now.
      const onlyPossibleOwners =
        proposals.length > 0 &&
        proposals.every(p => p.status === 'possible_owner');
      await stores.entityStore.setEntityUnresolved(entity.id, entity.version);
      await stores.entityStore.updateAssignee(entityId, null);
      await stores.historyStore.appendHistory({
        entity_id: entityId,
        action: 'no_candidates_found',
        actor: 'system',
        details: {
          reason: onlyPossibleOwners
            ? 'only_possible_owners'
            : 'escalation_disabled',
        },
      });
      return true;
    });
    if (flipped) {
      this.logger.info(
        `[escalation] fallback trigger flipped entity ${entityId} to unresolved (escalation disabled)`,
      );
    }
  }
}
