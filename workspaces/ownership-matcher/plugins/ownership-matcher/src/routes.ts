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

import { createRouteRef, createSubRouteRef } from '@backstage/core-plugin-api';

export const rootRouteRef = createRouteRef({
  id: 'ownership-matcher',
});

export const entityDetailRouteRef = createSubRouteRef({
  id: 'ownership-matcher/entity-detail',
  parent: rootRouteRef,
  path: '/entities/:entityId',
});

// Separate top-level route for the user-facing proposals page.
// It lives at a distinct path from the admin page so the two can have
// independent permission policies in the future.
export const userProposalsRouteRef = createRouteRef({
  id: 'ownership-matcher/my-proposals',
});
