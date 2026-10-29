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

/** A single rendered email produced by the ownership digest. */
export interface EmailMessage {
  /** Recipient address. */
  to: string;
  subject: string;
  /** HTML body. */
  content: string;
}

/**
 * Mail transport for the ownership email digest. Core owns the digest content,
 * template rendering and scheduling; a sender only delivers one message.
 *
 * Implementations must not throw for delivery failures: log and resolve
 * `{ success: false }` so the digest records the team as failed and retries
 * it next run.
 *
 * @public
 */
export interface OwnershipEmailSender {
  sendEmail(message: EmailMessage): Promise<{ success: boolean }>;
}
