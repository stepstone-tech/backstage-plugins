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
 * Tests for BackstageNotifier — the adapter implementing the Notifier port.
 * Covers: recipient resolution, dedup key shape, NotifyResult discriminated
 * union, and notification payload pass-through.
 */

import assert from 'node:assert/strict';
import { mockServices } from '@backstage/backend-test-utils';
import { CatalogApi } from '@backstage/catalog-client';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { BackstageNotifier } from './BackstageNotifier';
import { NotifyPayload } from './Notifier';
import {
  groupEntityWithRelations,
  groupEntityWithSpecMembers,
} from './__fixtures__';
import { NotificationsTopic } from './topics';

// ── Helper: minimal CatalogApi stub ──────────────────────────────────────────

function makeCatalogApi(
  entityOrNull: unknown | null,
  throws?: Error,
): CatalogApi {
  return {
    getEntityByRef: jest.fn(async () => {
      if (throws) throw throws;
      return entityOrNull;
    }),
    getEntities: jest.fn(),
    queryEntities: jest.fn(),
  } as unknown as CatalogApi;
}

// ── Helper: minimal NotificationService stub ─────────────────────────────────

function makeNotificationService(throws?: Error) {
  return {
    send: jest.fn(async (_payload: any) => {
      if (throws) throw throws;
    }),
  };
}

// ── Base payload used across send tests ──────────────────────────────────────

const basePayload: NotifyPayload = {
  title: 'Ownership proposal for svc-alpha',
  description: 'Reason: low confidence score.',
  link: '/ownership-matcher/entities/e1',
  severity: 'normal',
  dedupKey: 'proposal:p1',
  topic: NotificationsTopic.AcceptancePending,
};

describe('BackstageNotifier', () => {
  const logger = mockServices.logger.mock();

  // ─── Recipient resolution via getGroupMembers ────────────────────────────

  describe('recipient resolution (getGroupMembers)', () => {
    it('hasMember relations present — returns targetRef values', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-alpha',
        basePayload,
      );

      expect(result.kind).toBe('sent');
      assert(result.kind === 'sent');
      expect(result.recipients).toEqual([
        'user:default/alice',
        'user:default/bob',
      ]);
    });

    it('no hasMember relations — falls back to spec.members with prefixing', async () => {
      const api = makeCatalogApi(groupEntityWithSpecMembers);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-alpha',
        basePayload,
      );

      expect(result.kind).toBe('sent');
      assert(result.kind === 'sent');
      expect(result.recipients).toContain('user:default/carol');
      expect(result.recipients).toContain('user:default/dave');
    });

    it('spec.members entries with colon not prefixed; entries without colon get user:default/ prefix', async () => {
      const entityWithMixedMembers = {
        ...groupEntityWithSpecMembers,
        spec: { members: ['alice', 'user:default/bob', 'group:default/wrong'] },
      };
      const api = makeCatalogApi(entityWithMixedMembers);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-alpha',
        basePayload,
      );

      assert(result.kind === 'sent');
      expect(result.recipients).toContain('user:default/alice');
      expect(result.recipients).toContain('user:default/bob');
      // 'group:default/wrong' has a colon — must NOT be prefixed
      expect(result.recipients).toContain('group:default/wrong');
      expect(result.recipients).not.toContain(
        'user:default/group:default/wrong',
      );
    });

    it('group entity missing — returns no-recipients result and warn-logs', async () => {
      const api = makeCatalogApi(null);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/nonexistent',
        basePayload,
      );

      expect(result.kind).toBe('no-recipients');
      assert(result.kind === 'no-recipients');
      expect(result.groupRef).toBe('group:default/nonexistent');
    });

    it('group entity has no members at all — returns no-recipients result', async () => {
      const emptyGroup = {
        kind: 'Group',
        metadata: { name: 'empty-team', namespace: 'default' },
        spec: { members: [] },
        relations: [],
      };
      const api = makeCatalogApi(emptyGroup);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/empty-team',
        basePayload,
      );

      expect(result.kind).toBe('no-recipients');
    });

    it('catalog call throws — returns no-recipients, warn-logs error cause', async () => {
      const api = makeCatalogApi(null, new Error('network timeout'));
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-x',
        basePayload,
      );

      // Catalog throws → empty members → no-recipients
      expect(result.kind).toBe('no-recipients');
    });
  });

  // ─── Dedup key shape ──────────────────────────────

  describe('dedup key → NotificationPayload.scope mapping', () => {
    // Pin the exact dedup key passed as scope.
    // Backstage deduplicates by `scope`, not `topic`. `topic` is a stable
    // category string used for user-preference filtering.
    it('passes dedupKey as the underlying notification scope field and sets a stable topic', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      await notifier.notifyTeam('group:default/team-alpha', {
        ...basePayload,
        dedupKey: 'proposal:p1',
      });

      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            scope: 'proposal:p1',
            topic: NotificationsTopic.AcceptancePending,
          }),
        }),
      );
    });
  });

  // ─── NotifyResult discriminated union ────────────────────────────────────

  describe('NotifyResult discriminated union', () => {
    // Sent path
    it('returns { kind: "sent", recipients } on successful send', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-alpha',
        basePayload,
      );

      expect(result.kind).toBe('sent');
      assert(result.kind === 'sent');
      expect(Array.isArray(result.recipients)).toBe(true);
      expect(result.recipients.length).toBeGreaterThan(0);
    });

    // No-recipients path
    it('returns { kind: "no-recipients", groupRef } when member list is empty', async () => {
      const api = makeCatalogApi(null);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-x',
        basePayload,
      );

      expect(result.kind).toBe('no-recipients');
      assert(result.kind === 'no-recipients');
      expect(result.groupRef).toBe('group:default/team-x');
    });

    // Send-failed path — adapter catches, does not throw
    it('returns { kind: "send-failed", groupRef, error } when notifications.send throws', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const sendError = new Error('notifications API unavailable');
      const notifications = makeNotificationService(sendError);
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const result = await notifier.notifyTeam(
        'group:default/team-alpha',
        basePayload,
      );

      expect(result.kind).toBe('send-failed');
      assert(result.kind === 'send-failed');
      expect(result.groupRef).toBe('group:default/team-alpha');
      expect(result.error).toBe(sendError);
    });

    // Adapter must NOT throw regardless of result kind
    it('never throws — all error paths are returned as discriminated values', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService(new Error('boom'));
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      await expect(
        notifier.notifyTeam('group:default/team-alpha', basePayload),
      ).resolves.not.toThrow();
    });
  });

  // ─── Payload pass-through ────────────────────────────────────────────────

  describe('notification payload pass-through', () => {
    // Title/severity/link/description correctly forwarded
    it('passes title, description, link, severity through to notifications.send', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      const payload: NotifyPayload = {
        title: 'Ownership proposal for svc-alpha',
        description: 'Reason: low confidence score.',
        link: '/ownership-matcher/entities/e1',
        severity: 'normal',
        dedupKey: 'proposal:p1',
        topic: NotificationsTopic.ProposalsBatchReady,
      };

      await notifier.notifyTeam('group:default/team-alpha', payload);

      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            title: 'Ownership proposal for svc-alpha',
            description: 'Reason: low confidence score.',
            link: '/ownership-matcher/entities/e1',
            severity: 'normal',
          }),
        }),
      );
    });

    // single-fan-out invariant — N members must produce exactly ONE send call
    it('group with N members produces exactly one notifications.send call', async () => {
      const fiveMemberGroup = {
        kind: 'Group',
        metadata: { name: 'big-team', namespace: 'default' },
        spec: {},
        relations: [
          { type: 'hasMember', targetRef: 'user:default/alice' },
          { type: 'hasMember', targetRef: 'user:default/bob' },
          { type: 'hasMember', targetRef: 'user:default/carol' },
          { type: 'hasMember', targetRef: 'user:default/dave' },
          { type: 'hasMember', targetRef: 'user:default/eve' },
        ],
      };
      const api = makeCatalogApi(fiveMemberGroup);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      await notifier.notifyTeam('group:default/big-team', basePayload);

      expect(notifications.send).toHaveBeenCalledTimes(1);
      const call = notifications.send.mock.calls[0][0];
      expect(call.recipients.entityRef).toHaveLength(5);
    });

    // recipients shape: type='entity' with entityRef array
    it('sends with recipients.type="entity" and entityRef array', async () => {
      const api = makeCatalogApi(groupEntityWithRelations);
      const catalog = new CatalogService(api, logger);
      const notifications = makeNotificationService();
      const notifier = new BackstageNotifier(
        catalog,
        notifications as any,
        logger,
      );

      await notifier.notifyTeam('group:default/team-alpha', basePayload);

      expect(notifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          recipients: expect.objectContaining({
            type: 'entity',
            entityRef: expect.arrayContaining([
              'user:default/alice',
              'user:default/bob',
            ]),
          }),
        }),
      );
    });
  });
});

describe('BackstageNotifier.notifyUser', () => {
  const logger = mockServices.logger.mock();
  const USER = 'user:default/jane.director';

  it('sends directly to the user without catalog group lookup', async () => {
    const api = makeCatalogApi(null);
    const notifications = makeNotificationService();
    const notifier = new BackstageNotifier(
      new CatalogService(api, logger),
      notifications as any,
      logger,
    );

    const result = await notifier.notifyUser(USER, basePayload);

    expect(result).toEqual({ kind: 'sent', recipients: [USER] });
    expect(api.getEntityByRef).not.toHaveBeenCalled();
    expect(notifications.send).toHaveBeenCalledWith({
      recipients: { type: 'entity', entityRef: [USER] },
      payload: expect.objectContaining({
        title: basePayload.title,
        link: basePayload.link,
        scope: basePayload.dedupKey,
        topic: basePayload.topic,
      }),
    });
  });

  it('returns { kind: "send-failed", userRef, error } when notifications.send throws', async () => {
    const sendError = new Error('notifications API unavailable');
    const notifier = new BackstageNotifier(
      new CatalogService(makeCatalogApi(null), logger),
      makeNotificationService(sendError) as any,
      logger,
    );

    const result = await notifier.notifyUser(USER, basePayload);

    expect(result).toEqual({
      kind: 'send-failed',
      userRef: USER,
      error: sendError,
    });
  });
});
