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

export interface Config {
  ownershipMatcher?: {
    email?: {
      /**
       * Microsoft Graph transport for the ownership email digest. Omitted =
       * this module registers no sender.
       */
      msgraph?: {
        /** Entra ID (Azure AD) tenant of the app registration. */
        tenantId: string;
        /** Client ID of the app registration. */
        clientId: string;
        /**
         * Client secret of the app registration.
         * @visibility secret
         */
        clientSecret: string;
        /**
         * UPN of the mailbox to send from, e.g. noreply@example.com. The app
         * registration needs the `Mail.Send` application permission for it.
         */
        userPrincipalName: string;
      };
    };
  };
}
