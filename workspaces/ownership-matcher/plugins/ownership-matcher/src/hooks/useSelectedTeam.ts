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

import { useSearchParams } from 'react-router-dom';

export const ALL_TEAMS = '__all__';

/**
 * Reads/writes the `?team=` search param. Lives in the URL rather than
 * component state so the selection survives navigation between the views
 * that share it, and so a filtered view can be shared by link.
 */
export function useSelectedTeam(): [string, (team: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTeam = searchParams.get('team') ?? ALL_TEAMS;

  const setSelectedTeam = (team: string) => {
    const next = new URLSearchParams(searchParams);
    if (team === ALL_TEAMS) {
      next.delete('team');
    } else {
      next.set('team', team);
    }
    setSearchParams(next, { replace: true });
  };

  return [selectedTeam, setSelectedTeam];
}
