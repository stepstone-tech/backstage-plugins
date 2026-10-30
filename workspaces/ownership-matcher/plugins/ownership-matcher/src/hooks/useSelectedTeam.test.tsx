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

import { PropsWithChildren } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook, act } from '@testing-library/react';
import { useSelectedTeam } from './useSelectedTeam';

const wrapper = ({ children }: PropsWithChildren<{}>) => (
  <MemoryRouter initialEntries={['/my-ownership-proposals']}>
    {children}
  </MemoryRouter>
);

describe('useSelectedTeam', () => {
  it('defaults to __all__ when no ?team= param is present', () => {
    const { result } = renderHook(() => useSelectedTeam(), { wrapper });
    expect(result.current[0]).toBe('__all__');
  });

  it('reads the ?team= param when present', () => {
    const { result } = renderHook(() => useSelectedTeam(), {
      wrapper: ({ children }) => (
        <MemoryRouter
          initialEntries={['/my-ownership-proposals?team=group:default/a']}
        >
          {children}
        </MemoryRouter>
      ),
    });
    expect(result.current[0]).toBe('group:default/a');
  });

  it('writes the selected team into the ?team= param', () => {
    const { result } = renderHook(() => useSelectedTeam(), { wrapper });

    act(() => result.current[1]('group:default/a'));

    expect(result.current[0]).toBe('group:default/a');
  });

  it('removes the ?team= param when set back to __all__', () => {
    const { result } = renderHook(() => useSelectedTeam(), {
      wrapper: ({ children }) => (
        <MemoryRouter
          initialEntries={['/my-ownership-proposals?team=group:default/a']}
        >
          {children}
        </MemoryRouter>
      ),
    });

    act(() => result.current[1]('__all__'));

    expect(result.current[0]).toBe('__all__');
  });
});
