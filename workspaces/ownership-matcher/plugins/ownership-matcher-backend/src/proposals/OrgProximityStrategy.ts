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
import {
  ProposalCandidate,
  ProposalStrategy,
  ProposalStrategyContext,
  SignalDefinition,
} from './types';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { normalizeGroupRef } from '../utils';

/** Finds the owner of the parent system entity as a candidate. */
export class OrgProximityStrategy implements ProposalStrategy {
  readonly name = 'org-proximity';
  readonly signalDefinitions: SignalDefinition[] = [
    {
      key: 'org_proximity_system',
      title: 'System owner',
      description:
        'Your team owns the parent system that this component belongs to.',
    },
  ];

  constructor(
    private readonly catalogService: CatalogService,
    _logger: LoggerService,
  ) {}

  async findCandidates(
    ctx: ProposalStrategyContext,
  ): Promise<ProposalCandidate[]> {
    const { entity, rejectedActors } = ctx;

    // No try/catch: a failed catalog lookup must propagate so the caller
    // doesn't read it as "no system owner" and escalate on a transient error.
    if (!entity.spec?.system) return [];

    const systemRef = entity.spec.system.includes(':')
      ? entity.spec.system
      : `system:default/${entity.spec.system}`;

    const systemEntity = await this.catalogService.getEntityByRef(systemRef);
    const systemOwner = systemEntity?.spec?.owner;
    if (!systemOwner) return [];

    const ref = normalizeGroupRef(systemOwner);
    if (rejectedActors.has(ref)) return [];

    return [
      {
        ownerRef: ref,
        confidenceScore: 0.6,
        confidenceReason: ['org_proximity_system'],
      },
    ];
  }
}
