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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { LoggerService } from '@backstage/backend-plugin-api';
import type {
  EmailMessage,
  OwnershipEmailSender,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

/**
 * Used when `ownershipMatcher.email.dryRun` is true: writes each rendered
 * email to the OS temp dir and logs it instead of sending. Needs no sender
 * module, so adopters can preview the digest before wiring a transport.
 */
export class DryRunEmailSender implements OwnershipEmailSender {
  constructor(private readonly logger: LoggerService) {}

  async sendEmail({
    to,
    subject,
    content,
  }: EmailMessage): Promise<{ success: boolean }> {
    const slug = to.replace(/[^a-z0-9]/gi, '_');
    const file = path.join(os.tmpdir(), `ownership-email-${slug}.html`);
    fs.writeFileSync(file, content, 'utf8');
    this.logger.info(
      `[DRY RUN] Would send ownership email to ${to} — subject: "${subject}" — preview: ${file}`,
    );
    return { success: true };
  }
}
