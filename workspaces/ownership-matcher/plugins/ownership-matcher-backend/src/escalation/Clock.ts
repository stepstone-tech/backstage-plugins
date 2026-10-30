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

/** Injectable time source used by deadline-aware services. */
export interface Clock {
  /** Returns the current instant. */
  now(): Date;
}

/** Production implementation of {@link Clock} backed by `new Date`. */
export class SystemClock implements Clock {
  /** {@inheritdoc Clock.now} */
  now(): Date {
    return new Date();
  }
}
