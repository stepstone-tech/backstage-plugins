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
import { Config } from '@backstage/config';
import type {
  EmailMessage,
  OwnershipEmailSender,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';
import { Client } from '@microsoft/microsoft-graph-client';
import type { Message } from '@microsoft/microsoft-graph-types';
import {
  TokenCredentialAuthenticationProvider,
  TokenCredentialAuthenticationProviderOptions,
} from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { ClientSecretCredential } from '@azure/identity';

/** Sends ownership digest emails via Microsoft Graph `/users/{upn}/sendMail`. */
export class MsGraphEmailSender implements OwnershipEmailSender {
  constructor(
    private readonly userPrincipalName: string,
    private readonly client: Client,
    private readonly logger: LoggerService,
  ) {}

  /** Builds a sender from `ownershipMatcher.email.msgraph`. */
  static fromConfig(config: Config, logger: LoggerService): MsGraphEmailSender {
    const credential = new ClientSecretCredential(
      config.getString('tenantId'),
      config.getString('clientId'),
      config.getString('clientSecret'),
    );
    const options: TokenCredentialAuthenticationProviderOptions = {
      scopes: ['https://graph.microsoft.com/.default'],
    };
    // Build once — the Graph SDK handles token refresh internally.
    const client = Client.initWithMiddleware({
      authProvider: new TokenCredentialAuthenticationProvider(
        credential,
        options,
      ),
    });
    return new MsGraphEmailSender(
      config.getString('userPrincipalName'),
      client,
      logger,
    );
  }

  async sendEmail({
    to,
    subject,
    content,
  }: EmailMessage): Promise<{ success: boolean }> {
    try {
      const email: Message = {
        toRecipients: [{ emailAddress: { address: to } }],
        subject,
        body: { content, contentType: 'html' },
      };
      await this.client
        .api(`/users/${this.userPrincipalName}/sendMail`)
        .post({ message: email });
      this.logger.debug(`Ownership email sent to ${to}`);
      return { success: true };
    } catch (err) {
      this.logger.error(
        `Failed to send ownership email to ${to}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { success: false };
    }
  }
}
