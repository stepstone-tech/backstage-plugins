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

import { AuthService } from '@backstage/backend-plugin-api';
import { CatalogApi } from '@backstage/catalog-client';
import { Entity } from '@backstage/catalog-model';

/** Result of validating an edited catalog entity. `unavailable` = the validator could not be reached (retryable). */
export type EntityValidationResult =
  | { status: 'valid' }
  | { status: 'invalid'; errors: string[] }
  | { status: 'unavailable'; message: string };

export interface EntityValidator {
  validate(
    entity: Record<string, unknown>,
    locationRef: string,
  ): Promise<EntityValidationResult>;
}

/**
 * Validates via the catalog's `validate-entity` endpoint, which runs every
 * installed catalog processor, including any organisation-specific validation
 * processors.
 */
export class CatalogEntityValidator implements EntityValidator {
  constructor(
    private readonly catalogApi: Pick<CatalogApi, 'validateEntity'>,
    private readonly auth: AuthService,
  ) {}

  async validate(
    entity: Record<string, unknown>,
    locationRef: string,
  ): Promise<EntityValidationResult> {
    try {
      const { token } = await this.auth.getPluginRequestToken({
        onBehalfOf: await this.auth.getOwnServiceCredentials(),
        targetPluginId: 'catalog',
      });
      const result = await this.catalogApi.validateEntity(
        entity as unknown as Entity,
        locationRef,
        { token },
      );
      if (result.valid) return { status: 'valid' };
      return {
        status: 'invalid',
        errors: result.errors.map(e => e.message),
      };
    } catch (err) {
      return {
        status: 'unavailable',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
