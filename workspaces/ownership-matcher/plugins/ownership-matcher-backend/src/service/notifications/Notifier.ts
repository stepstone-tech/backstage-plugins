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

import { NotificationSeverity } from '@backstage/plugin-notifications-common';
import { NotificationsTopicValue } from './topics';

/** Inputs the caller (subscriber) provides — pure UI/UX concerns. */
export interface NotifyPayload {
  title: string;
  description: string;
  link: string;
  severity: NotificationSeverity;
  /** Per-aggregate dedup key. */
  dedupKey: string;
  topic: NotificationsTopicValue;
}

/** Result of a `notifyTeam` call. */
export type NotifyResult =
  | { kind: 'sent'; recipients: string[] }
  | { kind: 'no-recipients'; groupRef: string }
  | { kind: 'send-failed'; groupRef: string; error: Error };

/** Result of a `notifyUser` call. */
export type NotifyUserResult =
  | { kind: 'sent'; recipients: string[] }
  | { kind: 'send-failed'; userRef: string; error: Error };

/** Port over `getGroupMembers(groupRef)` + `notifications.send(...)`. */
export interface Notifier {
  notifyTeam(groupRef: string, payload: NotifyPayload): Promise<NotifyResult>;
  /** Notify a single user directly (no group-member expansion). */
  notifyUser(
    userRef: string,
    payload: NotifyPayload,
  ): Promise<NotifyUserResult>;
}
