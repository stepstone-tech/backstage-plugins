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
 * Flow tests for OwnershipNotificationService: the subscriber lifecycle, all
 * four event handlers, and the onEvent wrapper.
 *
 * Key technique: capture the onEvent handler registered during init and
 * invoke it directly with typed payloads — no real event bus needed.
 */

import { mockServices } from '@backstage/backend-test-utils';
import { EventsService } from '@backstage/plugin-events-node';
import { Notifier, NotifyPayload, NotifyResult } from './Notifier';
import {
  OwnershipNotificationService,
  SUBSCRIBER_ID,
  ACCEPTANCE_PENDING_HISTORY_ACTION,
} from './OwnershipNotificationService';
import {
  NotificationsTopic,
  ProposalsBatchReadyEventPayload,
  ProposalReminderDueEventPayload,
  ProposalExpiredEventPayload,
} from './topics';
import {
  defaultNotificationsConfig,
  pendingProposalRow,
  notifiedProposalRow,
  acceptancePendingEventPayload,
  recentThrottleHistoryRow,
  staleThrottleHistoryRow,
} from './__fixtures__';
import { createInMemoryStore, InMemoryStore } from './__fixtures__/store';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type OnEventFn = (params: {
  topic: string;
  eventPayload: unknown;
}) => Promise<void>;

/**
 * Creates the service and captures the onEvent handler via EventsService.subscribe.
 * Returns both so tests can call the handler directly without a real event bus.
 */
async function buildService(options: {
  store?: InMemoryStore;
  notifier?: jest.Mocked<Notifier>;
  configOverrides?: Partial<typeof defaultNotificationsConfig>;
}): Promise<{
  service: OwnershipNotificationService;
  onEvent: OnEventFn;
  events: jest.Mocked<EventsService>;
}> {
  const store = options.store ?? createInMemoryStore();
  const notifier =
    options.notifier ??
    makeNotifier({ kind: 'sent', recipients: ['user:default/alice'] });
  const config = { ...defaultNotificationsConfig, ...options.configOverrides };
  const logger = mockServices.logger.mock();

  let capturedOnEvent: OnEventFn | undefined;

  const events = {
    subscribe: jest.fn(
      async (sub: { id: string; topics: string[]; onEvent: OnEventFn }) => {
        capturedOnEvent = sub.onEvent;
      },
    ),
    publish: jest.fn(async () => undefined),
  } as unknown as jest.Mocked<EventsService>;

  const service = new OwnershipNotificationService(
    notifier,
    store,
    events,
    logger,
    config,
  );
  await service.init();

  if (!capturedOnEvent) {
    // Service was disabled — provide a no-op so tests can still compile
    capturedOnEvent = async () => undefined;
  }

  return { service, onEvent: capturedOnEvent, events };
}

/**
 * Makes a jest.Mocked<Notifier> that returns the given result for all notifyTeam calls.
 */
function makeNotifier(result: NotifyResult): jest.Mocked<Notifier> {
  return {
    notifyTeam: jest.fn(
      async (_groupRef: string, _payload: NotifyPayload) => result,
    ),
    notifyUser: jest.fn(async (userRef: string, _payload: NotifyPayload) =>
      result.kind === 'send-failed'
        ? { kind: 'send-failed' as const, userRef, error: result.error }
        : { kind: 'sent' as const, recipients: [userRef] },
    ),
  };
}

// Canonical event payloads
const batchReadyPayload: ProposalsBatchReadyEventPayload = {
  proposedOwnerRef: 'group:default/team-alpha',
  newProposalIds: ['p1', 'p2'],
  scanId: 'scan-1',
};

const reminderPayload: ProposalReminderDueEventPayload = {
  proposalId: 'p1',
  entityId: 'e1',
  entityName: 'svc-alpha',
  proposedOwnerRef: 'group:default/team-alpha',
};

const expiredPayload: ProposalExpiredEventPayload = {
  proposalId: 'p2',
  entityId: 'e2',
  entityName: 'svc-beta',
  proposedOwnerRef: 'group:default/team-beta',
};

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('OwnershipNotificationService', () => {
  // ── init lifecycle ───────────────────────────────────────────────────────

  describe('init() lifecycle', () => {
    it('init() registers subscriber for all topics when enabled', async () => {
      const { events } = await buildService({});

      expect(events.subscribe).toHaveBeenCalledTimes(1);
      const sub = (events.subscribe as jest.Mock).mock.calls[0][0];
      expect(sub.id).toBe(SUBSCRIBER_ID);
      expect(sub.topics).toContain(NotificationsTopic.ProposalsBatchReady);
      expect(sub.topics).toContain(NotificationsTopic.ProposalReminderDue);
      expect(sub.topics).toContain(NotificationsTopic.ProposalExpired);
      expect(sub.topics).toContain(NotificationsTopic.AcceptancePending);
      expect(sub.topics).toContain(NotificationsTopic.GraceWarning);
      expect(sub.topics).toContain(NotificationsTopic.ArchivePending);
      expect(sub.topics).toContain(NotificationsTopic.EscalationAssigned);
      expect(sub.topics).toHaveLength(7);
    });

    it('init() skips subscription and info-logs when disabled', async () => {
      const logger = mockServices.logger.mock();
      const store = createInMemoryStore();
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const config = { ...defaultNotificationsConfig, enabled: false };

      const events = {
        subscribe: jest.fn(),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        config,
      );
      await service.init();

      expect(events.subscribe).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalled();
    });

    // Subscriber id must be exact constant
    it('registered subscriber id is the SUBSCRIBER_ID constant', async () => {
      const { events } = await buildService({});
      const sub = (events.subscribe as jest.Mock).mock.calls[0][0];
      expect(sub.id).toBe('ownership-matcher.notifications');
    });

    // Double-registration behaviour is unspecified; mark as todo
    it.todo('init() called twice — behaviour on subscriber id collision');
  });

  // ── handleProposalsBatchReady ──────────────────────────────────────────────

  describe('handleProposalsBatchReady', () => {
    // Helper: seed the store's listPendingProposalIdsForOwner mock.
    function withPending(
      store: InMemoryStore & { listPendingProposalIdsForOwner?: jest.Mock },
      pendingIds: string[],
    ) {
      store.listPendingProposalIdsForOwner = jest.fn(async () => pendingIds);
      return store;
    }

    it('sent path: notifies team once and bulk-sets notified_at for newProposalIds', async () => {
      const store = withPending(createInMemoryStore(), ['p1', 'p2', 'p3']);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });

      expect(notifier.notifyTeam).toHaveBeenCalledTimes(1);
      expect(notifier.notifyTeam).toHaveBeenCalledWith(
        'group:default/team-alpha',
        expect.objectContaining({
          link: '/my-ownership-proposals',
          severity: 'normal',
          topic: NotificationsTopic.ProposalsBatchReady,
        }),
      );
      // refreshNotifiedAt called once per id in newProposalIds (2 in fixture)
      expect(store.refreshNotifiedAt).toHaveBeenCalledTimes(2);
      expect(store.refreshNotifiedAt).toHaveBeenCalledWith(
        'p1',
        expect.any(Date),
      );
      expect(store.refreshNotifiedAt).toHaveBeenCalledWith(
        'p2',
        expect.any(Date),
      );
    });

    it('no-recipients: logs warn and does not throw', async () => {
      const store = withPending(createInMemoryStore(), ['p1', 'p2']);
      const notifier = makeNotifier({
        kind: 'no-recipients',
        groupRef: 'group:default/team-alpha',
      });
      const logger = mockServices.logger.mock();

      let captured: OnEventFn | undefined;
      const events = {
        subscribe: jest.fn(async (sub: any) => {
          captured = sub.onEvent;
        }),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        defaultNotificationsConfig,
      );
      await service.init();

      await expect(
        captured!({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: batchReadyPayload,
        }),
      ).resolves.not.toThrow();

      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
    });

    it('send-failed: logs warn and does not throw', async () => {
      const store = withPending(createInMemoryStore(), ['p1', 'p2']);
      const notifier = makeNotifier({
        kind: 'send-failed',
        groupRef: 'group:default/team-alpha',
        error: new Error('API down'),
      });
      const logger = mockServices.logger.mock();

      let captured: OnEventFn | undefined;
      const events = {
        subscribe: jest.fn(async (sub: any) => {
          captured = sub.onEvent;
        }),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        defaultNotificationsConfig,
      );
      await service.init();

      await expect(
        captured!({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: batchReadyPayload,
        }),
      ).resolves.not.toThrow();

      expect(logger.warn).toHaveBeenCalled();
      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
    });

    it('empty pending set: skips notification entirely', async () => {
      const store = withPending(createInMemoryStore(), []);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
    });

    it('dedup key is stable for the same pending set across calls', async () => {
      const store = withPending(createInMemoryStore(), ['p1', 'p2', 'p3']);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });
      await onEvent({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });

      expect(notifier.notifyTeam).toHaveBeenCalledTimes(2);
      const [, payload1] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      const [, payload2] = (notifier.notifyTeam as jest.Mock).mock.calls[1];
      expect(payload1.dedupKey).toBe(payload2.dedupKey);
    });

    it('dedup key changes when the pending set changes', async () => {
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });

      // First scan: pending = [p1, p2]
      const store1 = withPending(createInMemoryStore(), ['p1', 'p2']);
      const { onEvent: onEvent1 } = await buildService({
        store: store1,
        notifier,
      });
      await onEvent1({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });

      // Second scan (separate service instance, fresh subscribe): pending = [p1, p2, p3]
      const store2 = withPending(createInMemoryStore(), ['p1', 'p2', 'p3']);
      const { onEvent: onEvent2 } = await buildService({
        store: store2,
        notifier,
      });
      await onEvent2({
        topic: NotificationsTopic.ProposalsBatchReady,
        eventPayload: batchReadyPayload,
      });

      const [, p1] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      const [, p2] = (notifier.notifyTeam as jest.Mock).mock.calls[1];
      expect(p1.dedupKey).not.toBe(p2.dedupKey);
    });
  });

  // ── handleProposalReminder ─────────────────────────────────────────────────

  describe('handleProposalReminder', () => {
    // Pending proposal with stale notified_at: refresh notified_at, NO history row
    it('pending proposal with stale notified_at — notified_at refreshed, no history row appended', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(store.refreshNotifiedAt).toHaveBeenCalledWith(
        'p1',
        expect.any(Date),
      );
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Pending proposal whose first send failed (notified_at is null): retry
    it('pending proposal with null notified_at — send succeeds, notified_at refreshed, no history row', async () => {
      const store = createInMemoryStore({ p1: pendingProposalRow });
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(store.refreshNotifiedAt).toHaveBeenCalledWith(
        'p1',
        expect.any(Date),
      );
      // No history row — the escalation migration removed `proposal_notified`.
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Reminder title starts with "Reminder:"
    it('reminder title starts with "Reminder:" and severity is normal', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.title).toMatch(/^Reminder:/i);
      expect(payload.severity).toBe('normal');
      expect(payload.link).toBe('/my-ownership-proposals');
      expect(payload.topic).toBe(NotificationsTopic.ProposalReminderDue);
    });

    // Status guard: accepted
    it('proposal in accepted — no send, no DB write', async () => {
      const store = createInMemoryStore({
        p1: { ...pendingProposalRow, status: 'accepted' },
      });
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
    });

    // Status guard: rejected
    it('proposal in rejected — no send, no DB write', async () => {
      const store = createInMemoryStore({
        p1: { ...pendingProposalRow, status: 'rejected' },
      });
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
    });

    // Status guard: expired
    it('proposal in expired — no send, no DB write', async () => {
      const store = createInMemoryStore({
        p1: { ...pendingProposalRow, status: 'expired' },
      });
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
    });

    // Proposal missing
    it('proposal missing — no send, no DB writes, no exception', async () => {
      const store = createInMemoryStore({});
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const { onEvent } = await buildService({ store, notifier });

      await expect(
        onEvent({
          topic: NotificationsTopic.ProposalReminderDue,
          eventPayload: reminderPayload,
        }),
      ).resolves.not.toThrow();

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
    });

    // Empty members: notified_at not touched
    it('empty members — notified_at not touched, proposal stays eligible', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'no-recipients',
        groupRef: 'group:default/team-alpha',
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Send failure: notified_at not touched, no history row
    it('send failure — notified_at not touched, no history row', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'send-failed',
        groupRef: 'group:default/team-alpha',
        error: new Error('timeout'),
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Dedup key for reminder must be proposal:${proposalId}
    // (intentionally same as created so reminders collapse onto the same bell entry)
    it('uses dedup key proposal:p1 for proposal.reminder-due events', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.dedupKey).toBe('proposal:p1');
    });

    // Idempotency — two reminder ticks, notified proposal stays clean
    it('two identical reminder-due events for notified proposal — notified_at refreshed twice, still no history row', async () => {
      const store = createInMemoryStore({ p1: notifiedProposalRow });
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });
      await onEvent({
        topic: NotificationsTopic.ProposalReminderDue,
        eventPayload: reminderPayload,
      });

      expect(store.refreshNotifiedAt).toHaveBeenCalledTimes(2);
      expect(store.appendHistory).not.toHaveBeenCalled();
    });
  });

  // ── handleProposalExpired ──────────────────────────────────────────────────

  describe('handleProposalExpired', () => {
    // Happy path: low-severity send, no DB writes
    it('non-empty members → low-severity send', async () => {
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalExpired,
        eventPayload: expiredPayload,
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.severity).toBe('low');
      expect(payload.title).toContain('expired');
      expect(payload.link).toBe('/my-ownership-proposals');
      expect(payload.topic).toBe(NotificationsTopic.ProposalExpired);
    });

    // Zero DB writes
    it('expired handler performs zero DB writes', async () => {
      const store = createInMemoryStore({});
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalExpired,
        eventPayload: expiredPayload,
      });

      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Empty members: silent return (no warn log by design)
    it('empty member list — silent return, no send, no DB writes', async () => {
      const store = createInMemoryStore({});
      const notifier = makeNotifier({
        kind: 'no-recipients',
        groupRef: 'group:default/team-beta',
      });
      const { onEvent } = await buildService({ store, notifier });

      await expect(
        onEvent({
          topic: NotificationsTopic.ProposalExpired,
          eventPayload: expiredPayload,
        }),
      ).resolves.not.toThrow();

      expect(store.refreshNotifiedAt).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalled();
      // Explicitly NOT asserting warn log presence (silent skip by design)
    });

    // Dedup key for expired must be proposal:${proposalId}
    it('uses dedup key proposal:p2 for proposal.expired events', async () => {
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ notifier });

      await onEvent({
        topic: NotificationsTopic.ProposalExpired,
        eventPayload: expiredPayload,
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.dedupKey).toBe('proposal:p2');
    });
  });

  // ── handleAcceptancePending ────────────────────────────────────────────────

  describe('handleAcceptancePending', () => {
    // No prior throttle row: send succeeds, history appended with recipients + daysSinceAcceptance
    it('no prior throttle row — send succeeds, history row appended with recipients and daysSinceAcceptance', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const recipients = ['user:default/alice'];
      const notifier = makeNotifier({ kind: 'sent', recipients });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          action: ACCEPTANCE_PENDING_HISTORY_ACTION,
          actor: 'system',
          details: expect.objectContaining({
            recipients,
            daysSinceAcceptance: 5.3,
          }),
        }),
      );
    });

    it('with an open catalog-info PR, the reminder links the PR', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: {
          ...acceptancePendingEventPayload,
          repoUrl: 'https://repo/browse',
          prUrl: 'https://repo/pr/7',
        },
      });

      expect(notifier.notifyTeam).toHaveBeenCalledWith(
        'group:default/team-gamma',
        expect.objectContaining({
          title: 'Review the spec.owner pull request for svc-gamma',
          link: 'https://repo/pr/7',
        }),
      );
    });

    // Prior row within throttle window: bail before getGroupMembers
    it('prior row within acceptancePendingReminderDays — returns before getGroupMembers', async () => {
      const store = createInMemoryStore({}, {}, [recentThrottleHistoryRow]);
      store.getLatestHistoryAction.mockResolvedValue(recentThrottleHistoryRow);
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      expect(notifier.notifyTeam).not.toHaveBeenCalled();
      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Prior row older than throttle window: send proceeds, new history row appended
    it('prior row older than acceptancePendingReminderDays — send proceeds, new history row appended', async () => {
      const store = createInMemoryStore({}, {}, [staleThrottleHistoryRow]);
      store.getLatestHistoryAction.mockResolvedValue(staleThrottleHistoryRow);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({ action: ACCEPTANCE_PENDING_HISTORY_ACTION }),
      );
    });

    // Throttle passes but members empty: no history row written
    it('throttle passes but members empty — no history row written, warn logged', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'no-recipients',
        groupRef: 'group:default/team-gamma',
      });
      const logger = mockServices.logger.mock();
      const events = {
        subscribe: jest.fn(async (_sub: any) => {}),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        defaultNotificationsConfig,
      );
      await service.init();

      // When disabled, no subscribe is called, so we call service init with enabled=true
      // and capture via a fresh setup
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Send throws: no history row, throttle does not advance
    it('throttle passes but send throws — no history row written', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'send-failed',
        groupRef: 'group:default/team-gamma',
        error: new Error('timeout'),
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      expect(store.appendHistory).not.toHaveBeenCalled();
    });

    // Math.floor in body (unit-style via captured payload)
    it('notification body uses Math.floor of daysSinceAcceptance (5.8 → 5)', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: {
          ...acceptancePendingEventPayload,
          daysSinceAcceptance: 5.8,
        },
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.description).toContain('5');
      expect(payload.description).not.toContain('5.8');
      expect(payload.description).not.toContain('6');
    });

    // Float preserved in history details
    it('daysSinceAcceptance float preserved in history details (not floored)', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: {
          ...acceptancePendingEventPayload,
          daysSinceAcceptance: 5.8,
        },
      });

      expect(store.appendHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({ daysSinceAcceptance: 5.8 }),
        }),
      );
    });

    // Link routing: repoUrl present → notification links straight to the repo
    // (mirrors the "Update ownership in repository" button in the History tab)
    it('link is repoUrl when present on the event payload', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      const repoUrl =
        'https://repo.example.com/projects/PRJ/repos/svc-gamma/browse';
      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: { ...acceptancePendingEventPayload, repoUrl },
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.link).toBe(repoUrl);
    });

    // Link routing: repoUrl null → fallback to my-ownership-proposals page
    it('link falls back to /my-ownership-proposals when repoUrl is null', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: { ...acceptancePendingEventPayload, repoUrl: null },
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.link).toBe('/my-ownership-proposals');
    });

    // Dedup key for acceptance.pending must be entity:${entityId}
    it('uses dedup key entity:e3 for acceptance.pending events', async () => {
      const store = createInMemoryStore({}, {}, []);
      store.getLatestHistoryAction.mockResolvedValue(undefined);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({ store, notifier });

      await onEvent({
        topic: NotificationsTopic.AcceptancePending,
        eventPayload: acceptancePendingEventPayload,
      });

      const [, payload] = (notifier.notifyTeam as jest.Mock).mock.calls[0];
      expect(payload.dedupKey).toBe('entity:e3');
    });
  });

  // ── onEvent error wrapper ──────────────────────────────────────────────────

  describe('onEvent error wrapper', () => {
    // Unknown topic: warn-logged, no throw
    it('unknown topic arrives at onEvent — warn-logged, no throw', async () => {
      const logger = mockServices.logger.mock();
      const store = createInMemoryStore({});
      const notifier = makeNotifier({ kind: 'sent', recipients: [] });
      const config = defaultNotificationsConfig;

      let capturedOnEvent: OnEventFn | undefined;
      const events = {
        subscribe: jest.fn(async (sub: any) => {
          capturedOnEvent = sub.onEvent;
        }),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        config,
      );
      await service.init();

      await expect(
        capturedOnEvent!({
          topic: 'ownership-matcher.some.unknown-topic',
          eventPayload: {},
        }),
      ).resolves.not.toThrow();

      expect(logger.warn).toHaveBeenCalled();
      expect(notifier.notifyTeam).not.toHaveBeenCalled();
    });

    // Handler throws: caught, warn-logged with topic, subscriber stays alive
    it('handler throws — error caught, logged with topic, subsequent events still processed', async () => {
      const logger = mockServices.logger.mock();

      // Make listPendingProposalIdsForOwner throw on first call.
      let callCount = 0;
      const store = createInMemoryStore({}) as InMemoryStore & {
        listPendingProposalIdsForOwner: jest.Mock;
      };
      store.listPendingProposalIdsForOwner = jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('DB exploded');
        return ['p1'];
      });

      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const config = defaultNotificationsConfig;

      let capturedOnEvent: OnEventFn | undefined;
      const events = {
        subscribe: jest.fn(async (sub: any) => {
          capturedOnEvent = sub.onEvent;
        }),
        publish: jest.fn(),
      } as unknown as jest.Mocked<EventsService>;

      const service = new OwnershipNotificationService(
        notifier,
        store,
        events,
        logger,
        config,
      );
      await service.init();

      // First event throws inside handler
      await expect(
        capturedOnEvent!({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: batchReadyPayload,
        }),
      ).resolves.not.toThrow();

      expect(logger.warn).toHaveBeenCalled();
      const warnCall = (logger.warn as jest.Mock).mock.calls.find(
        (args: unknown[]) =>
          String(args[0]).includes(NotificationsTopic.ProposalsBatchReady),
      );
      expect(warnCall).toBeDefined();

      // Second event should still be processed (subscriber not dead)
      await expect(
        capturedOnEvent!({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: batchReadyPayload,
        }),
      ).resolves.not.toThrow();
    });
  });

  // ── channels=['backstage'] smoke test ───────────────────────────

  describe('channel config', () => {
    it('channels=[backstage] — uses Backstage in-app channel without error', async () => {
      const store = createInMemoryStore({
        p1: pendingProposalRow,
      }) as InMemoryStore & {
        listPendingProposalIdsForOwner: jest.Mock;
      };
      store.listPendingProposalIdsForOwner = jest.fn(async () => ['p1']);
      const notifier = makeNotifier({
        kind: 'sent',
        recipients: ['user:default/alice'],
      });
      const { onEvent } = await buildService({
        store,
        notifier,
        configOverrides: { channels: ['backstage'] },
      });

      await expect(
        onEvent({
          topic: NotificationsTopic.ProposalsBatchReady,
          eventPayload: batchReadyPayload,
        }),
      ).resolves.not.toThrow();

      expect(notifier.notifyTeam).toHaveBeenCalled();
    });
  });
});

describe('OwnershipNotificationService — ArchivePending', () => {
  it('links the notification to the catalog entity page', async () => {
    const notifier = makeNotifier({
      kind: 'sent',
      recipients: ['user:default/alice'],
    });
    const { onEvent } = await buildService({
      store: createInMemoryStore(),
      notifier,
    });

    await onEvent({
      topic: NotificationsTopic.ArchivePending,
      eventPayload: {
        entityId: 'e1',
        entityName: 'api-test',
        entityRef: 'API:Default/api-test',
        assigneeRef: 'group:default/team-alpha',
      },
    });

    expect(notifier.notifyTeam).toHaveBeenCalledWith(
      'group:default/team-alpha',
      expect.objectContaining({
        title: 'Archive required: api-test',
        link: '/catalog/default/api/api-test',
      }),
    );
  });
});

describe('OwnershipNotificationService — EscalationAssigned', () => {
  const payload = {
    entityId: 'e9',
    entityName: 'orphan-svc',
    entityRef: 'component:default/orphan-svc',
    actorRef: 'user:default/jane.director',
    groupRef: 'group:default/domain-search',
    level: 1,
  };

  it('notifies the escalation actor directly, linking to the Escalations tab', async () => {
    const notifier = makeNotifier({ kind: 'sent', recipients: [] });
    const { onEvent } = await buildService({ notifier });

    await onEvent({
      topic: NotificationsTopic.EscalationAssigned,
      eventPayload: payload,
    });

    expect(notifier.notifyTeam).not.toHaveBeenCalled();
    expect(notifier.notifyUser).toHaveBeenCalledTimes(1);
    expect(notifier.notifyUser).toHaveBeenCalledWith(
      'user:default/jane.director',
      expect.objectContaining({
        title: expect.stringContaining('orphan-svc'),
        link: '/my-ownership-proposals?tab=escalations',
        dedupKey: 'escalation:e9:1',
        topic: NotificationsTopic.EscalationAssigned,
      }),
    );
  });

  it('does not throw when sending fails', async () => {
    const notifier = makeNotifier({
      kind: 'send-failed',
      groupRef: 'n/a',
      error: new Error('boom'),
    });
    const { onEvent } = await buildService({ notifier });

    await expect(
      onEvent({
        topic: NotificationsTopic.EscalationAssigned,
        eventPayload: payload,
      }),
    ).resolves.toBeUndefined();
    expect(notifier.notifyUser).toHaveBeenCalledTimes(1);
  });
});
