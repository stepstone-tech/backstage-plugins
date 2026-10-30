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

import { Clock } from '../Clock';

/**
 * Controllable clock for tests. Inject this into services instead of using
 * `jest.useFakeTimers`; tests drive time explicitly via `setTime` / `advance`.
 */
export class TestClock implements Clock {
  private current: Date;

  constructor(initial?: Date) {
    this.current = initial ?? new Date('2026-01-01T00:00:00.000Z');
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /**
   * Set the clock to an absolute point in time.
   */
  setTime(date: Date): void {
    this.current = new Date(date.getTime());
  }

  /**
   * Advance the clock by the given number of milliseconds.
   * Use `advance(days * 24 * 60 * 60 * 1000)` for day-based advances.
   */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /**
   * Convenience: advance by a number of days.
   */
  advanceDays(days: number): void {
    this.advance(days * 24 * 60 * 60 * 1000);
  }
}
