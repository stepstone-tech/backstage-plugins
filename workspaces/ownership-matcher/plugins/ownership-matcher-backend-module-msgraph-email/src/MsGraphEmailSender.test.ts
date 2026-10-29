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

import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { Client } from '@microsoft/microsoft-graph-client';
import { MsGraphEmailSender } from './MsGraphEmailSender';

function makeClient(post: jest.Mock) {
  const api = jest.fn().mockReturnValue({ post });
  return { client: { api } as unknown as Client, api };
}

describe('MsGraphEmailSender', () => {
  it('posts an HTML message to the sender mailbox', async () => {
    const post = jest.fn().mockResolvedValue(undefined);
    const { client, api } = makeClient(post);
    const sender = new MsGraphEmailSender(
      'noreply@example.com',
      client,
      mockServices.logger.mock(),
    );

    await expect(
      sender.sendEmail({
        to: 'team-a@example.com',
        subject: 'Digest',
        content: '<p>hi</p>',
      }),
    ).resolves.toEqual({ success: true });

    expect(api).toHaveBeenCalledWith('/users/noreply@example.com/sendMail');
    expect(post).toHaveBeenCalledWith({
      message: {
        toRecipients: [{ emailAddress: { address: 'team-a@example.com' } }],
        subject: 'Digest',
        body: { content: '<p>hi</p>', contentType: 'html' },
      },
    });
  });

  it('logs and reports failure instead of throwing when Graph rejects', async () => {
    const logger = mockServices.logger.mock();
    const { client } = makeClient(
      jest.fn().mockRejectedValue(new Error('403 Forbidden')),
    );
    const sender = new MsGraphEmailSender(
      'noreply@example.com',
      client,
      logger,
    );

    await expect(
      sender.sendEmail({
        to: 'team-a@example.com',
        subject: 'Digest',
        content: '',
      }),
    ).resolves.toEqual({ success: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('403 Forbidden'),
    );
  });

  it('fromConfig requires every credential key', () => {
    const logger = mockServices.logger.mock();
    const full = {
      tenantId: 't',
      clientId: 'c',
      clientSecret: 's',
      userPrincipalName: 'noreply@example.com',
    };

    expect(
      MsGraphEmailSender.fromConfig(new ConfigReader(full), logger),
    ).toBeInstanceOf(MsGraphEmailSender);
    const { clientSecret: _omit, ...missingSecret } = full;
    expect(() =>
      MsGraphEmailSender.fromConfig(new ConfigReader(missingSecret), logger),
    ).toThrow(/clientSecret/);
  });
});
