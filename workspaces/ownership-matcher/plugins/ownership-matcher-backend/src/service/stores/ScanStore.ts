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

import { Knex } from 'knex';
import { OwnershipScanRow } from '../../types';
import {
  CreateScanInput,
  CompleteScanInput,
  ScanFilter,
} from '../DatabaseOwnershipStore';

export class ScanStore {
  constructor(private readonly db: Knex) {}

  async createScan(input?: CreateScanInput): Promise<string> {
    const [row] = await this.db('ownership_scans')
      .insert({
        started_at: input?.started_at ?? new Date(),
        status: 'running',
      })
      .returning('id');
    return typeof row === 'object' ? row.id : row;
  }

  async completeScan(id: string, input: CompleteScanInput): Promise<void> {
    await this.db('ownership_scans').where({ id }).update(input);
  }

  async failScan(
    id: string,
    errorMessage: string,
    durationMs: number,
  ): Promise<void> {
    await this.db('ownership_scans').where({ id }).update({
      status: 'failed',
      completed_at: new Date(),
      error_message: errorMessage,
      duration_ms: durationMs,
    });
  }

  async failStaleScans(): Promise<number> {
    return this.db('ownership_scans').where({ status: 'running' }).update({
      status: 'failed',
      completed_at: new Date(),
      error_message:
        'Marked as failed on startup — backend restarted while scan was running',
    });
  }

  async getScan(id: string): Promise<OwnershipScanRow | undefined> {
    return this.db('ownership_scans').where({ id }).first();
  }

  async listScans(
    limit = 20,
    filter?: ScanFilter,
  ): Promise<OwnershipScanRow[]> {
    let query = this.db('ownership_scans');

    if (filter?.status) {
      query = query.where({ status: filter.status });
    }
    if (filter?.since) {
      query = query.where('started_at', '>=', filter.since);
    }
    if (filter?.until) {
      query = query.where('started_at', '<=', filter.until);
    }

    return query.orderBy('started_at', 'desc').limit(limit);
  }
}
