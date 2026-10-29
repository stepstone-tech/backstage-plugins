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

import { act, renderHook } from '@testing-library/react';
import {
  PR_POLL_FAST_COUNT,
  PR_POLL_FAST_MS,
  PR_POLL_SLOW_MS,
  usePrStatusPolling,
} from './usePrStatusPolling';

type Props = Parameters<typeof usePrStatusPolling>[0];

/** Each refresh simulates a completed fetch by handing the hook a new `data` object. */
function setup(initial: Partial<Props> = {}) {
  const refresh = jest.fn();
  let props: Props = {
    pending: true,
    loading: false,
    refresh,
    data: {},
    resetKey: 'a',
    ...initial,
  };
  const hook = renderHook((p: Props) => usePrStatusPolling(p), {
    initialProps: props,
  });
  refresh.mockImplementation(() => {
    props = { ...props, data: {} };
    hook.rerender(props);
  });
  const update = (patch: Partial<Props>) => {
    props = { ...props, ...patch };
    hook.rerender(props);
  };
  return { refresh, hook, update };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('usePrStatusPolling', () => {
  it('polls fast while pending, then slows down — never gives up', () => {
    const { refresh } = setup();

    for (let i = 0; i < PR_POLL_FAST_COUNT; i++) {
      act(() => {
        jest.advanceTimersByTime(PR_POLL_FAST_MS);
      });
    }
    expect(refresh).toHaveBeenCalledTimes(PR_POLL_FAST_COUNT);

    // Next poll is on the slow cadence.
    act(() => {
      jest.advanceTimersByTime(PR_POLL_FAST_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(PR_POLL_FAST_COUNT);
    act(() => {
      jest.advanceTimersByTime(PR_POLL_SLOW_MS - PR_POLL_FAST_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(PR_POLL_FAST_COUNT + 1);
  });

  it('does not poll when the PR is not pending, and stops once it leaves pending', () => {
    const { refresh, update } = setup({ pending: false });
    act(() => {
      jest.advanceTimersByTime(PR_POLL_SLOW_MS * 2);
    });
    expect(refresh).not.toHaveBeenCalled();

    update({ pending: true });
    act(() => {
      jest.advanceTimersByTime(PR_POLL_FAST_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    update({ pending: false });
    act(() => {
      jest.advanceTimersByTime(PR_POLL_SLOW_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not arm a timer while a fetch is in flight', () => {
    const { refresh } = setup({ loading: true });
    act(() => {
      jest.advanceTimersByTime(PR_POLL_SLOW_MS * 2);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('restart() refreshes immediately and returns to the fast cadence', () => {
    const { refresh, hook } = setup();
    for (let i = 0; i < PR_POLL_FAST_COUNT; i++) {
      act(() => {
        jest.advanceTimersByTime(PR_POLL_FAST_MS);
      });
    }
    refresh.mockClear();

    act(() => {
      hook.result.current.restart();
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(PR_POLL_FAST_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

// react-query behaves differently from the useAsyncRetry this hook was built
// against: `refetch` is a stable reference and structural sharing hands back
// the *same* `data` object while the PR is still pending. Only `isFetching`
// changes. These two cases pin down that the call sites must pass isFetching
// as `loading` — passing isLoading stalls polling after one attempt.
describe('usePrStatusPolling under react-query semantics', () => {
  /**
   * Same `data` reference every poll, and `loading` flips like `isFetching`.
   * The fetch is async in reality, so starting and settling it are separate
   * renders — collapsing them into one batch would hide the change.
   */
  function setupReactQuery() {
    const refresh = jest.fn();
    const stableData = { entity: { pr_status: 'pending' } };
    let props: Parameters<typeof usePrStatusPolling>[0] = {
      pending: true,
      loading: false,
      refresh,
      data: stableData,
      resetKey: 'a',
    };
    const hook = renderHook(
      (p: Parameters<typeof usePrStatusPolling>[0]) => usePrStatusPolling(p),
      { initialProps: props },
    );
    // Starting the fetch is all the poll callback does.
    refresh.mockImplementation(() => {
      props = { ...props, loading: true };
      hook.rerender(props);
    });
    /** The response lands: isFetching goes false, data unchanged. */
    const settle = () => {
      props = { ...props, loading: false };
      hook.rerender(props);
    };
    return { refresh, settle };
  }

  it('keeps polling when only the fetching flag changes', () => {
    const { refresh, settle } = setupReactQuery();

    for (let i = 1; i <= 3; i++) {
      act(() => {
        jest.advanceTimersByTime(PR_POLL_FAST_MS);
      });
      expect(refresh).toHaveBeenCalledTimes(i);
      act(() => settle());
    }
  });

  it('stalls after one poll if the fetching flag never changes', () => {
    const refresh = jest.fn();
    const stableData = { entity: { pr_status: 'pending' } };
    renderHook(() =>
      usePrStatusPolling({
        pending: true,
        // isLoading: false throughout a background refetch — the bug.
        loading: false,
        refresh,
        data: stableData,
        resetKey: 'a',
      }),
    );

    act(() => {
      jest.advanceTimersByTime(PR_POLL_FAST_MS * 5);
    });
    // Nothing re-armed the timer, so only the first poll ever fires.
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
