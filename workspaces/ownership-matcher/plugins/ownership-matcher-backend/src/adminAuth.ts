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

import {
  BackstageCredentials,
  HttpAuthService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { NotAllowedError } from '@backstage/errors';
import type express from 'express';
import { ownershipMatcherAdminPermission } from './permissions';

/** Admin-permission checks shared by the plugin's routers. */
export function createAdminAuth(deps: {
  httpAuth: HttpAuthService;
  permissions?: PermissionsService;
}) {
  const { httpAuth, permissions } = deps;

  /** Returns true when the credentials resolve to a user with admin permission. */
  async function isAdmin(credentials: BackstageCredentials): Promise<boolean> {
    if (!permissions) return false;
    const [result] = await permissions.authorize(
      [{ permission: ownershipMatcherAdminPermission }],
      { credentials },
    );
    return result.result === AuthorizeResult.ALLOW;
  }

  /** Throws unless the request carries a user credential with admin permission. */
  async function assertAdmin(req: express.Request): Promise<void> {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    if (!(await isAdmin(credentials))) {
      throw new NotAllowedError('Ownership matcher admin permission required');
    }
  }

  return { isAdmin, assertAdmin };
}
