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

import { Route, Routes } from 'react-router-dom';
import { OwnershipMatcherPage } from './components/OwnershipMatcherPage/OwnershipMatcherPage';
import { EntityDetailPage } from './components/EntityDetailPage/EntityDetailPage';

export const Router = () => (
  <Routes>
    <Route path="/" element={<OwnershipMatcherPage />} />
    <Route path="/entities/:entityId" element={<EntityDetailPage />} />
  </Routes>
);

// The Ownership page (proposals + permission-gated Admin tab) has its own
// router since it is mounted at /my-ownership-proposals with no sub-routes.
// The "/" route above only redirects there; entity detail stays here.
export { UserOwnershipPage } from './components/UserOwnershipPage/UserOwnershipPage';
