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
import { mockServices } from '@backstage/backend-test-utils';
import { DryRunEmailSender } from './DryRunEmailSender';

describe('DryRunEmailSender', () => {
  it('writes the email to the temp dir and logs it instead of sending', async () => {
    const logger = mockServices.logger.mock();
    const sender = new DryRunEmailSender(logger);

    await expect(
      sender.sendEmail({
        to: 'team-a@example.com',
        subject: 'Digest',
        content: '<p>hi</p>',
      }),
    ).resolves.toEqual({ success: true });

    const file = path.join(
      os.tmpdir(),
      'ownership-email-team_a_example_com.html',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('<p>hi</p>');
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[DRY RUN]'),
    );
    fs.unlinkSync(file);
  });
});
