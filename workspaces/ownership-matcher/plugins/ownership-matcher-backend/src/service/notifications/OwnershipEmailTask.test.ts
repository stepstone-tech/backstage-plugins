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

/**
 * Tests for OwnershipEmailTask.run() and the private periodKey() logic
 * (exercised indirectly through the returned OwnershipEmailRunResult).
 *
 * A fake OwnershipEmailSender is injected through the constructor; tests
 * control success / failure via `fakeSender.sendEmail`.
 *
 * fs and resolvePackagePath are mocked so the constructor's template-loading
 * step never touches the real filesystem.
 */

import fs from 'fs';

// Automock fs for the constructor's template loading (existsSync/readFileSync),
// but keep the real `fs.promises`: @backstage/backend-test-utils now eagerly
// loads the AWS SDK, whose token-providers destructures `writeFile` from
// `fs.promises` at module load and would otherwise crash on the automock.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...jest.createMockFromModule<typeof import('fs')>('fs'),
    promises: actual.promises,
  };
});

jest.mock('@backstage/backend-plugin-api', () => ({
  ...jest.requireActual('@backstage/backend-plugin-api'),
  resolvePackagePath: jest.fn().mockReturnValue('/fake/templates'),
}));

import { mockServices } from '@backstage/backend-test-utils';
import { OwnershipEmailTask } from './OwnershipEmailTask';
import { OwnershipEmailConfig } from '../../config';

const fakeSender = {
  sendEmail: jest.fn().mockResolvedValue({ success: true }),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmailConfig(
  overrides: Partial<OwnershipEmailConfig> = {},
): OwnershipEmailConfig {
  return {
    schedule: {
      frequency: { months: 1 },
      timeout: { minutes: 30 },
      initialDelay: { minutes: 5 },
    },
    ...overrides,
  };
}

function makeStore(overrides: Record<string, jest.Mock> = {}) {
  return {
    listPendingProposalsForEmail: jest.fn().mockResolvedValue([]),
    hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
    recordEmailSent: jest.fn().mockResolvedValue(undefined),
    // Remaining OwnershipStore methods — not exercised by OwnershipEmailTask
    listEntities: jest.fn(),
    getEntityById: jest.fn(),
    listProposalsByEntity: jest.fn(),
    listAllProposals: jest.fn(),
    listHistory: jest.fn(),
    listScans: jest.fn(),
    getScan: jest.fn(),
    createScan: jest.fn(),
    completeScan: jest.fn(),
    createEntity: jest.fn(),
    updateEntityLastScanned: jest.fn(),
    acceptEntity: jest.fn(),
    reopenEntity: jest.fn(),
    updateAssignee: jest.fn(),
    markEntityToArchive: jest.fn(),
    setEntityEscalated: jest.fn(),
    getActiveEntityByRef: jest.fn(),
    createProposal: jest.fn(),
    getProposal: jest.fn(),
    listActiveProposalsByEntity: jest.fn(),
    updateProposalStatus: jest.fn(),
    appendHistory: jest.fn(),
    getRejectedActors: jest.fn(),
    getDashboardStats: jest.fn(),
    getStatsForOwners: jest.fn(),
    listProposalsForOwners: jest.fn(),
    listPendingProposalIdsForOwner: jest.fn(),
    ...overrides,
  };
}

function makeCatalogService(
  overrides: Partial<{ getEntityByRef: jest.Mock }> = {},
) {
  return {
    getEntityByRef: jest.fn().mockResolvedValue({
      metadata: { name: 'team-a' },
      spec: { profile: { email: 'team-a@example.com', title: 'Team A' } },
    }),
    ...overrides,
  };
}

function makeTask(
  storeOverrides: Record<string, jest.Mock> = {},
  catalogOverrides: Partial<{ getEntityByRef: jest.Mock }> = {},
  configOverrides: Partial<OwnershipEmailConfig> = {},
) {
  (fs.existsSync as jest.Mock).mockReturnValue(true);
  (fs.readFileSync as jest.Mock).mockReturnValue('<p>{{teamName}}</p>');

  return new OwnershipEmailTask(
    makeStore(storeOverrides) as any,
    makeCatalogService(catalogOverrides) as any,
    makeEmailConfig(configOverrides),
    fakeSender,
    'http://localhost:3000',
    mockServices.logger.mock(),
  );
}

// ─── periodKey() — tested indirectly via run().periodKey ──────────────────────

describe('OwnershipEmailTask — periodKey via run()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Pin to a Wednesday in week 4 of January 2025 (ISO week 4).
    // 2025-01-22 is a Wednesday; ISO week 4 of 2025.
    jest.setSystemTime(new Date('2025-01-22T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns YYYY-MM format when schedule frequency uses months', async () => {
    const task = makeTask(
      {},
      {},
      {
        schedule: {
          frequency: { months: 1 },
          timeout: { minutes: 30 },
          initialDelay: { minutes: 5 },
        },
      },
    );
    const result = await task.run();
    expect(result.periodKey).toMatch(/^\d{4}-\d{2}$/);
    expect(result.periodKey).toBe('2025-01');
  });

  it('returns YYYY-WW format when schedule frequency uses days', async () => {
    const task = makeTask(
      {},
      {},
      {
        schedule: {
          frequency: { days: 7 },
          timeout: { minutes: 30 },
          initialDelay: { minutes: 5 },
        },
      },
    );
    const result = await task.run();
    expect(result.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(result.periodKey).toBe('2025-W04');
  });

  it('returns YYYY-WW format when schedule frequency uses hours', async () => {
    const task = makeTask(
      {},
      {},
      {
        schedule: {
          frequency: { hours: 24 },
          timeout: { minutes: 30 },
          initialDelay: { minutes: 5 },
        },
      },
    );
    const result = await task.run();
    expect(result.periodKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(result.periodKey).toBe('2025-W04');
  });

  it('falls through to YYYY-MM format when schedule frequency uses cron', async () => {
    const task = makeTask(
      {},
      {},
      {
        schedule: {
          frequency: { cron: '0 0 1 * *' },
          timeout: { minutes: 30 },
        },
      },
    );
    const result = await task.run();
    expect(result.periodKey).toMatch(/^\d{4}-\d{2}$/);
    expect(result.periodKey).toBe('2025-01');
  });

  it('YYYY-WW week number is ISO 8601 compliant — early January pinned to week 1', async () => {
    // 2025-01-06 is a Monday in ISO week 2 of 2025.
    jest.setSystemTime(new Date('2025-01-06T12:00:00.000Z'));
    const task = makeTask(
      {},
      {},
      { schedule: { frequency: { days: 1 }, timeout: { minutes: 30 } } },
    );
    const result = await task.run();
    expect(result.periodKey).toBe('2025-W02');
  });
});

// ─── run() — routing logic ─────────────────────────────────────────────────────

describe('OwnershipEmailTask — run() routing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-06-15T10:00:00.000Z'));
    fakeSender.sendEmail.mockReset().mockResolvedValue({ success: true });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('skips a team that already received an email this period', async () => {
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(true),
    });

    const task = makeTask(store);
    const result = await task.run();

    expect(result.skipped).toContain('group:default/team-a');
    expect(result.emailed).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(result.unresolvableContact).toHaveLength(0);
  });

  it('puts a team in unresolvableContact when catalog returns no email', async () => {
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
    });
    const catalog = makeCatalogService({
      getEntityByRef: jest.fn().mockResolvedValue({
        metadata: { name: 'team-b' },
        spec: { profile: {} }, // no email field
      }),
    });

    const task = makeTask(store, catalog);
    const result = await task.run();

    expect(result.unresolvableContact).toContain('group:default/team-b');
    expect(result.emailed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('puts a team in unresolvableContact when getEntityByRef throws', async () => {
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-c',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
    });
    const catalog = makeCatalogService({
      getEntityByRef: jest
        .fn()
        .mockRejectedValue(new Error('catalog unavailable')),
    });

    const task = makeTask(store, catalog);
    const result = await task.run();

    expect(result.unresolvableContact).toContain('group:default/team-c');
    expect(result.emailed).toHaveLength(0);
  });

  it('emails the team and calls recordEmailSent when send succeeds', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const recordEmailSent = jest.fn().mockResolvedValue(undefined);
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
      recordEmailSent,
    });

    const task = makeTask(store);
    const result = await task.run();

    expect(result.emailed).toContain('group:default/team-a');
    expect(result.failed).toHaveLength(0);
    expect(recordEmailSent).toHaveBeenCalledWith(
      'group:default/team-a',
      expect.any(String),
    );
  });

  it('records a throwing sender as failed and carries on with the remaining teams', async () => {
    fakeSender.sendEmail
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ success: true });
    const recordEmailSent = jest.fn().mockResolvedValue(undefined);

    const result = await makeTask({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      recordEmailSent,
    }).run();

    expect(result.failed).toEqual(['group:default/team-a']);
    expect(result.emailed).toEqual(['group:default/team-b']);
    expect(recordEmailSent).toHaveBeenCalledTimes(1);
  });

  it('puts a team in failed and does NOT call recordEmailSent when send fails', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: false });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const recordEmailSent = jest.fn().mockResolvedValue(undefined);
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
      recordEmailSent,
    });

    const task = makeTask(store);
    const result = await task.run();

    expect(result.failed).toContain('group:default/team-a');
    expect(result.emailed).toHaveLength(0);
    expect(recordEmailSent).not.toHaveBeenCalled();
  });

  it('still puts team in emailed when recordEmailSent throws after a successful send', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const recordEmailSent = jest
      .fn()
      .mockRejectedValue(new Error('db write failure'));
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
      recordEmailSent,
    });

    const task = makeTask(store);
    const result = await task.run();

    // Email was sent; the failed-record error must not downgrade it to failed
    expect(result.emailed).toContain('group:default/team-a');
    expect(result.failed).toHaveLength(0);
  });

  it('totalEntitiesFlagged is the sum of entity counts across all teams', async () => {
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        // team-a: 2 entities
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-a',
          current_check: 'zombie',
          entity_kind: 'API',
        },
        // team-b: 3 entities
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest.fn().mockResolvedValue(false),
    });
    // Provide email for both teams
    const catalog = makeCatalogService({
      getEntityByRef: jest.fn().mockResolvedValue({
        metadata: { name: 'a-team' },
        spec: { profile: { email: 'team@example.com', title: 'A Team' } },
      }),
    });

    const task = makeTask(store, catalog);
    const result = await task.run();

    expect(result.totalEntitiesFlagged).toBe(5);
  });

  it('result contains the periodKey returned from the run', async () => {
    const task = makeTask();
    const result = await task.run();
    expect(result.periodKey).toBeDefined();
    expect(typeof result.periodKey).toBe('string');
    expect(result.periodKey.length).toBeGreaterThan(0);
  });

  it('processes multiple teams independently — each routes to its own bucket', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/already-sent',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/no-email',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/send-ok',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
      hasEmailBeenSentThisPeriod: jest
        .fn()
        .mockImplementation(async (ref: string) => {
          return ref === 'group:default/already-sent';
        }),
    });

    const catalog = makeCatalogService({
      getEntityByRef: jest.fn().mockImplementation(async (ref: string) => {
        if (ref === 'group:default/no-email') {
          return { metadata: { name: 'no-email' }, spec: { profile: {} } };
        }
        return {
          metadata: { name: 'team' },
          spec: { profile: { email: 'team@example.com', title: 'Team' } },
        };
      }),
    });

    const task = makeTask(store, catalog);
    const result = await task.run();

    expect(result.skipped).toContain('group:default/already-sent');
    expect(result.unresolvableContact).toContain('group:default/no-email');
    expect(result.emailed).toContain('group:default/send-ok');
    expect(result.failed).toHaveLength(0);
  });

  // The digest follows pending proposals, not `ownership_entities.assigned_to`,
  // which keeps pointing at the first broadcast candidate after it rejects.
  it('first candidate rejected, sibling still pending — only the sibling is emailed', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const proposals = [
      { proposed_owner_ref: 'group:default/team-first', status: 'rejected' },
      { proposed_owner_ref: 'group:default/team-sibling', status: 'pending' },
    ];
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue(
        proposals
          .filter(p => p.status === 'pending')
          .map(p => ({
            team_ref: p.proposed_owner_ref,
            current_check: 'orphaned',
            entity_kind: 'Component',
          })),
      ),
    });

    const result = await makeTask(store).run();

    expect(result.emailed).toEqual(['group:default/team-sibling']);
    expect(result.totalEntitiesFlagged).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].subject).toContain(
      'has 1 ownership issue to review',
    );
  });

  it('emails every broadcast candidate with a pending proposal for the same entity', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-b',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
        {
          team_ref: 'group:default/team-c',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
    });

    const result = await makeTask(store).run();

    expect(result.emailed).toEqual([
      'group:default/team-a',
      'group:default/team-b',
      'group:default/team-c',
    ]);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
  });

  it('sends nothing when there are no pending proposals', async () => {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);

    const result = await makeTask().run();

    expect(result.emailed).toHaveLength(0);
    expect(result.totalEntitiesFlagged).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('OwnershipEmailTask — template links', () => {
  const realTemplate = jest
    .requireActual<typeof import('fs')>('fs')
    .readFileSync(
      require.resolve('../../../templates/ownership-email.html.hbs'),
      'utf8',
    );

  async function renderOne(
    configOverrides: Partial<OwnershipEmailConfig>,
    appTitle?: string,
  ): Promise<{ subject: string; content: string }> {
    const mockSendEmail = jest.fn().mockResolvedValue({ success: true });
    fakeSender.sendEmail.mockImplementation(mockSendEmail);
    const store = makeStore({
      listPendingProposalsForEmail: jest.fn().mockResolvedValue([
        {
          team_ref: 'group:default/team-a',
          current_check: 'orphaned',
          entity_kind: 'Component',
        },
      ]),
    });
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(realTemplate);
    const task = new OwnershipEmailTask(
      store as any,
      makeCatalogService() as any,
      makeEmailConfig(configOverrides),
      fakeSender,
      'https://portal.example.com',
      mockServices.logger.mock(),
      appTitle,
    );
    await task.run();
    return mockSendEmail.mock.calls[0][0];
  }

  it('links the footer to app.baseUrl', async () => {
    const { content } = await renderOne({});
    expect(content).toContain('href="https://portal.example.com"');
  });

  it('renders the support link only when supportUrl is configured', async () => {
    const withLink = await renderOne({
      supportUrl: 'https://issues.example.com/HELP',
    });
    expect(withLink.content).toContain(
      'href="https://issues.example.com/HELP"',
    );
    expect(withLink.content).toContain('Need help?');

    const withoutLink = await renderOne({});
    expect(withoutLink.content).not.toContain('Need help?');
  });

  it('brands the subject and body with app.title, defaulting to Backstage', async () => {
    const branded = await renderOne({}, 'Dev Portal');
    expect(branded.subject).toMatch(/^Dev Portal: /);
    expect(branded.content).toContain('The Dev Portal Team');

    const unbranded = await renderOne({});
    expect(unbranded.subject).toMatch(/^Backstage: /);
  });
});
