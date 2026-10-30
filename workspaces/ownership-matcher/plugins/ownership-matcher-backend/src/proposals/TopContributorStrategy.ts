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
  isScmError,
  type ScmCommit,
  type ScmHistoryCapability,
  type ScmRepoRef,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  ProposalCandidate,
  ProposalStrategy,
  ProposalStrategyContext,
  SignalDefinition,
} from './types';
import { ContributorService } from '../service/ContributorService';
import { ScmRegistry } from '../scm';

/** Ranks teams by commit frequency in the entity's repository. Needs an SCM provider with the `history` capability. */
export class TopContributorStrategy implements ProposalStrategy {
  readonly name = 'top-contributor';
  readonly signalDefinitions: SignalDefinition[] = [
    {
      key: 'top_contributor',
      title: 'Top contributor',
      description:
        'Your team has significant recent commit activity in this repository.',
    },
  ];

  constructor(
    private readonly scm: ScmRegistry,
    private readonly contributorService: ContributorService,
    private readonly logger: LoggerService,
    private readonly maxCandidates: number = 3,
    private readonly commitsLimit: number = 25,
  ) {}

  async findCandidates(
    ctx: ProposalStrategyContext,
  ): Promise<ProposalCandidate[]> {
    const { entity, rejectedActors } = ctx;

    // Transient SCM and catalog failures must propagate so the caller can
    // tell "no contributors found" apart from "couldn't look" and doesn't
    // escalate the case on a transient error. Only the legitimate "nothing to
    // look at" outcomes (and permanent 404 below) return [].
    const repo = ctx.repo ?? (await this.resolveRepo(entity));
    // No provider for the entity's host, or one without history: no candidates.
    const history = repo && (await this.scm.clientFor(repo))?.history;
    if (!repo || !history) {
      return [];
    }

    const commits = await this.fetchCommits(repo, history);
    if (!commits) {
      return [];
    }

    const teamCommitCount = await this.countTeamCommits(
      commits,
      rejectedActors,
    );
    if (teamCommitCount.size === 0) {
      return [];
    }

    const total = commits.length || 1;
    return Array.from(teamCommitCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, this.maxCandidates)
      .map(([ref, count]) => ({
        ownerRef: ref,
        confidenceScore: count / total,
        confidenceReason: ['top_contributor'],
      }));
  }

  /** Returns the repo's recent commits, or `undefined` when the repo is permanently gone. */
  private async fetchCommits(
    repo: ScmRepoRef,
    history: ScmHistoryCapability,
  ): Promise<ScmCommit[] | undefined> {
    try {
      return await history.getCommits(repo, { limit: this.commitsLimit });
    } catch (err) {
      // A deleted or moved repo will never yield commits, so treat it as
      // "nothing to look at" (letting the fallback/escalation run) instead of
      // retrying forever. Everything else (auth, 5xx, rate limit, network)
      // must propagate: an auth error means a missing or expired token that
      // affects every entity on the host, so it must not read as "no
      // contributors" and mass-escalate.
      if (isScmError(err) && err.kind === 'not-found') {
        this.logger.warn(
          `Commit history unavailable for ${repo.path} (${err.kind}): ${err.message}`,
        );
        return undefined;
      }
      throw err;
    }
  }

  /** Counts how many commits each (non-rejected) team has. */
  private async countTeamCommits(
    commits: ScmCommit[],
    rejectedActors: Set<string>,
  ): Promise<Map<string, number>> {
    const teamCommitCount = new Map<string, number>();
    for (const commit of commits) {
      const info = await this.contributorService.getContributorInfo(
        commit.author.email,
      );
      for (const team of info?.teams ?? []) {
        const ref = team.startsWith('group:') ? team : `group:default/${team}`;
        if (rejectedActors.has(ref)) continue;
        teamCommitCount.set(ref, (teamCommitCount.get(ref) ?? 0) + 1);
      }
    }
    return teamCommitCount;
  }

  /** Like `ScmRegistry.repoFor`, but lets a provider-client failure throw instead of reading as "no repo". */
  private async resolveRepo(entity: ProposalStrategyContext['entity']) {
    const resolved = await this.scm.forLocation(
      entity.metadata.annotations?.['backstage.io/managed-by-location'],
    );
    return resolved.status === 'ok' ? resolved.location.repo : undefined;
  }
}
