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
  ProposalCandidate,
  ProposalStrategy,
  ProposalStrategyContext,
  SignalDefinition,
} from './types';
import { FallbackAction } from '../config/types';

/** Terminal strategy — always the last in the sequence. */
export class FallbackStrategy implements ProposalStrategy {
  readonly name = 'fallback';
  readonly signalDefinitions: SignalDefinition[] = [
    {
      key: 'fallback',
      title: 'Default assignment',
      description:
        'No specific ownership signals were found. Your team was assigned as the configured fallback owner.',
    },
  ];

  constructor(
    private readonly action: FallbackAction = 'escalated',
    private readonly fixedOwner?: string,
  ) {}

  async findCandidates(
    ctx: ProposalStrategyContext,
  ): Promise<ProposalCandidate[]> {
    if (this.action === 'fixed-owner' && this.fixedOwner) {
      if (ctx.rejectedActors.has(this.fixedOwner)) {
        return [];
      }
      return [
        {
          ownerRef: this.fixedOwner,
          confidenceScore: 0,
          confidenceReason: ['fallback'],
        },
      ];
    }

    // escalated — signal no candidates found.
    return [];
  }

  get triggersEscalation(): boolean {
    return this.action === 'escalated';
  }
}
