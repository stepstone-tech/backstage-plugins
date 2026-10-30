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
import { NotificationService } from '@backstage/plugin-notifications-node';
import { CatalogService } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import {
  Notifier,
  NotifyPayload,
  NotifyResult,
  NotifyUserResult,
} from './Notifier';

/** Adapter implementing `Notifier` against the real Backstage primitives. */
export class BackstageNotifier implements Notifier {
  constructor(
    private readonly catalog: CatalogService,
    private readonly notifications: NotificationService,
    private readonly logger: LoggerService,
  ) {}

  async notifyTeam(
    groupRef: string,
    payload: NotifyPayload,
  ): Promise<NotifyResult> {
    const recipients = await this.catalog.getGroupMembers(groupRef);
    if (recipients.length === 0) {
      return { kind: 'no-recipients', groupRef };
    }

    try {
      await this.send(recipients, payload);
      return { kind: 'sent', recipients };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(
        `BackstageNotifier.notifyTeam(${groupRef}) send failed: ${err.message}`,
      );
      return { kind: 'send-failed', groupRef, error: err };
    }
  }

  async notifyUser(
    userRef: string,
    payload: NotifyPayload,
  ): Promise<NotifyUserResult> {
    try {
      await this.send([userRef], payload);
      return { kind: 'sent', recipients: [userRef] };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.debug(
        `BackstageNotifier.notifyUser(${userRef}) send failed: ${err.message}`,
      );
      return { kind: 'send-failed', userRef, error: err };
    }
  }

  private async send(recipients: string[], payload: NotifyPayload) {
    await this.notifications.send({
      recipients: { type: 'entity', entityRef: recipients },
      payload: {
        title: payload.title,
        description: payload.description,
        link: payload.link,
        severity: payload.severity,
        scope: payload.dedupKey,
        topic: payload.topic,
      },
    });
  }
}
