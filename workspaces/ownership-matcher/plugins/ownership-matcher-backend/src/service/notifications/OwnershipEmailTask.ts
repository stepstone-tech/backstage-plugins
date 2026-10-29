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

import path from 'path';
import fs from 'fs';
import Handlebars from 'handlebars';
import {
  LoggerService,
  resolvePackagePath,
} from '@backstage/backend-plugin-api';
import {
  CatalogService,
  EmailMessage,
  OwnershipEmailSender,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { OwnershipEmailConfig } from '../../config';
import { OwnershipStore } from '../DatabaseOwnershipStore';

const CHECK_TITLES: Record<string, string> = {
  orphaned: 'No owner (orphaned)',
  zombie: 'Dissolved team (zombie)',
};

type TeamSummary = {
  teamRef: string;
  totalCount: number;
  checkBreakdown: { title: string; count: number }[];
  kindBreakdown: { kind: string; count: number }[];
};

export type OwnershipEmailRunResult = {
  periodKey: string;
  emailed: string[];
  skipped: string[];
  unresolvableContact: string[];
  failed: string[];
  totalEntitiesFlagged: number;
};

/** Per-team result of a run; each value names an `OwnershipEmailRunResult` list. */
type TeamOutcome = 'emailed' | 'skipped' | 'unresolvableContact' | 'failed';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class OwnershipEmailTask {
  private readonly template: HandlebarsTemplateDelegate;

  constructor(
    private readonly store: OwnershipStore,
    private readonly catalogService: CatalogService,
    private readonly emailConfig: OwnershipEmailConfig,
    /** Mail transport: a registered sender module, or the dry-run sender. */
    private readonly sender: OwnershipEmailSender,
    private readonly baseUrl: string,
    private readonly logger: LoggerService,
    /** `app.title`, used for branding in the subject and body. */
    private readonly appTitle: string = 'Backstage',
  ) {
    const templatePath = path.join(
      resolvePackagePath(
        '@stepstone-tech/backstage-plugin-ownership-matcher-backend',
        'templates',
      ),
      'ownership-email.html.hbs',
    );
    if (!fs.existsSync(templatePath)) {
      throw new Error(`Ownership email template not found at ${templatePath}`);
    }
    const hbs = Handlebars.create();
    hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    this.template = hbs.compile(fs.readFileSync(templatePath, 'utf8'));
  }

  /**
   * Returns a period key derived from the current date and the configured
   * schedule frequency. The key is used by the idempotency table so each team
   * receives at most one email per period regardless of how often the scheduler
   * fires.
   *
   * - Sub-monthly frequency (days/hours configured): ISO 8601 year+week "YYYY-WW"
   * - Monthly default (no explicit days/hours): "YYYY-MM"
   */
  private periodKey(): string {
    const now = new Date();
    const frequency = this.emailConfig.schedule.frequency as
      | Record<string, number>
      | undefined;

    if (
      frequency &&
      (frequency.days !== undefined || frequency.hours !== undefined)
    ) {
      // Correct ISO 8601 week: Thursday of the week determines the year.
      const thursday = new Date(now);
      thursday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 3);
      const jan4 = new Date(thursday.getFullYear(), 0, 4);
      const week = String(
        1 + Math.ceil((thursday.getTime() - jan4.getTime()) / 604_800_000),
      ).padStart(2, '0');
      return `${thursday.getFullYear()}-W${week}`;
    }

    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${now.getFullYear()}-${m}`;
  }

  private periodLabel(periodKey: string): string {
    if (periodKey.includes('-W')) {
      return `Week ${periodKey.split('-W')[1]}, ${periodKey.split('-W')[0]}`;
    }
    const [year, month] = periodKey.split('-');
    const d = new Date(Number(year), Number(month) - 1, 1);
    return new Intl.DateTimeFormat('en-GB', {
      month: 'long',
      year: 'numeric',
    }).format(d);
  }

  private async alreadySentThisPeriod(
    teamRef: string,
    periodKey: string,
  ): Promise<boolean> {
    return this.store.hasEmailBeenSentThisPeriod(teamRef, periodKey);
  }

  private async recordSend(teamRef: string, periodKey: string): Promise<void> {
    await this.store.recordEmailSent(teamRef, periodKey);
  }

  private async buildTeamSummaries(): Promise<TeamSummary[]> {
    const rows = await this.store.listPendingProposalsForEmail();

    const teamMap = new Map<
      string,
      { checks: Record<string, number>; kinds: Record<string, number> }
    >();

    for (const row of rows) {
      const teamRef = row.team_ref;
      if (!teamMap.has(teamRef)) {
        teamMap.set(teamRef, { checks: {}, kinds: {} });
      }
      const entry = teamMap.get(teamRef)!;
      const check = row.current_check as string;
      const kind = row.entity_kind as string;
      entry.checks[check] = (entry.checks[check] ?? 0) + 1;
      entry.kinds[kind] = (entry.kinds[kind] ?? 0) + 1;
    }

    return Array.from(teamMap.entries()).map(
      ([teamRef, { checks, kinds }]) => ({
        teamRef,
        totalCount: Object.values(checks).reduce((a, b) => a + b, 0),
        checkBreakdown: Object.entries(checks)
          .map(([key, count]) => ({ title: CHECK_TITLES[key] ?? key, count }))
          .sort((a, b) => b.count - a.count),
        kindBreakdown: Object.entries(kinds)
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count),
      }),
    );
  }

  private teamQueueUrl(): string {
    return `${this.baseUrl}/my-ownership-proposals`;
  }

  private async resolveTeamEmail(teamRef: string): Promise<string | undefined> {
    try {
      const entity = await this.catalogService.getEntityByRef(teamRef);
      const email = entity?.spec?.profile?.email as string | undefined;
      return email || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveTeamName(teamRef: string): Promise<string> {
    try {
      const entity = await this.catalogService.getEntityByRef(teamRef);
      return (
        (entity?.spec?.profile?.title as string | undefined) ??
        entity?.metadata?.name ??
        teamRef
      );
    } catch {
      return teamRef;
    }
  }

  private renderEmail(
    summary: TeamSummary,
    teamName: string,
    teamEmail: string,
    periodLabel: string,
  ): EmailMessage {
    const content = this.template({
      teamName,
      totalCount: summary.totalCount,
      checkBreakdown: summary.checkBreakdown,
      kindBreakdown: summary.kindBreakdown,
      queueUrl: this.teamQueueUrl(),
      periodLabel,
      appBaseUrl: this.baseUrl,
      appTitle: this.appTitle,
      supportUrl: this.emailConfig.supportUrl,
    });

    return {
      to: teamEmail,
      subject: `${this.appTitle}: ${teamName} has ${
        summary.totalCount
      } ownership issue${summary.totalCount === 1 ? '' : 's'} to review`,
      content,
    };
  }

  /** Emails one team unless already sent this period or it has no contact address. */
  private async processTeam(
    summary: TeamSummary,
    periodKey: string,
    periodLabel: string,
  ): Promise<TeamOutcome> {
    const { teamRef } = summary;
    if (await this.alreadySentThisPeriod(teamRef, periodKey)) {
      this.logger.debug(
        `OwnershipEmailTask: skipping ${teamRef} — already sent for period ${periodKey}`,
      );
      return 'skipped';
    }

    const teamEmail = await this.resolveTeamEmail(teamRef);
    if (!teamEmail) {
      this.logger.warn(
        `OwnershipEmailTask: no contact email for ${teamRef} — skipping`,
      );
      return 'unresolvableContact';
    }

    const teamName = await this.resolveTeamName(teamRef);
    const message = this.renderEmail(summary, teamName, teamEmail, periodLabel);
    if (!(await this.trySend(teamRef, message))) {
      return 'failed';
    }

    try {
      await this.recordSend(teamRef, periodKey);
    } catch (err) {
      this.logger.error(
        `OwnershipEmailTask: email sent to ${teamRef} but failed to record send — may re-send next run: ${errorMessage(
          err,
        )}`,
      );
    }
    return 'emailed';
  }

  /**
   * Senders come from third-party modules: a throw must not abort the
   * remaining teams, so treat it like a reported failure.
   */
  private async trySend(
    teamRef: string,
    message: EmailMessage,
  ): Promise<boolean> {
    try {
      const { success } = await this.sender.sendEmail(message);
      return success;
    } catch (err) {
      this.logger.error(
        `OwnershipEmailTask: email sender threw for ${teamRef}: ${errorMessage(
          err,
        )}`,
      );
      return false;
    }
  }

  async run(): Promise<OwnershipEmailRunResult> {
    const periodKey = this.periodKey();
    const periodLabel = this.periodLabel(periodKey);

    this.logger.info(
      `OwnershipEmailTask: starting run for period ${periodKey}`,
    );

    const summaries = await this.buildTeamSummaries();
    this.logger.info(
      `OwnershipEmailTask: ${summaries.length} teams with pending proposals`,
    );

    const result: OwnershipEmailRunResult = {
      periodKey,
      emailed: [],
      skipped: [],
      unresolvableContact: [],
      failed: [],
      totalEntitiesFlagged: summaries.reduce((acc, s) => acc + s.totalCount, 0),
    };

    for (const summary of summaries) {
      const outcome = await this.processTeam(summary, periodKey, periodLabel);
      result[outcome].push(summary.teamRef);
    }

    this.logger.info(
      `OwnershipEmailTask: completed for period ${periodKey} — ` +
        `emailed: ${result.emailed.length}, ` +
        `skipped (already sent): ${result.skipped.length}, ` +
        `unresolvable contact: ${result.unresolvableContact.length}, ` +
        `send failed: ${result.failed.length}, ` +
        `total entities flagged: ${result.totalEntitiesFlagged}`,
    );

    return result;
  }
}
