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

import { OrphanedCheck } from './OrphanedCheck';
import { ZombieCheck } from './ZombieCheck';
import { BUILTIN_CHECK_PRIORITY } from './index';
import { OwnershipCheckContext } from './types';
import { CatalogComponent } from '../types';

function makeCtx(
  entity: Partial<CatalogComponent>,
  liveGroups: string[] = [],
  placeholders: string[] = ['unknown'],
): OwnershipCheckContext {
  return {
    entity: {
      kind: 'Component',
      metadata: { name: 'test-service', namespace: 'default' },
      ...entity,
    },
    liveGroupRegistry: new Set(liveGroups),
    orphanedPlaceholders: new Set(placeholders.map(p => p.toLowerCase())),
  };
}

// ─── OrphanedCheck ────────────────────────────────────────────────────────────

describe('OrphanedCheck', () => {
  const check = new OrphanedCheck();

  it('fails when spec.owner is missing', () => {
    const result = check.run(makeCtx({ spec: {} }));
    expect(result.failed).toBe(true);
    expect(result.checkName).toBe('orphaned');
  });

  it('fails when spec.owner is the default placeholder "unknown"', () => {
    const result = check.run(makeCtx({ spec: { owner: 'unknown' } }));
    expect(result.failed).toBe(true);
  });

  it('fails when spec.owner matches a configured placeholder (case-insensitive)', () => {
    const ctx = makeCtx({ spec: { owner: 'TBD' } }, [], ['unknown', 'tbd']);
    expect(check.run(ctx).failed).toBe(true);
  });

  it('passes when spec.owner is a real team', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'group:default/my-team' } }, [
        'group:default/my-team',
      ]),
    );
    expect(result.failed).toBe(false);
  });

  it('includes owner in details when failing', () => {
    const result = check.run(makeCtx({ spec: { owner: 'unknown' } }));
    expect(result.details?.owner).toBe('unknown');
  });

  // 1.1.4 — only configured placeholder values trigger failure
  it('does not fail when owner is a non-configured value', () => {
    // Placeholders are ['unknown'], so 'tbd' should NOT trigger failure.
    const result = check.run(
      makeCtx({ spec: { owner: 'tbd' } }, [], ['unknown']),
    );
    expect(result.failed).toBe(false);
  });

  // 1.1.5 — default placeholder values when config omitted
  it('uses "unknown" as default placeholder when no custom placeholders configured', () => {
    // Default placeholder list is ['unknown']
    const ctx = makeCtx({ spec: { owner: 'unknown' } }, [], ['unknown']);
    expect(check.run(ctx).failed).toBe(true);

    // 'tbd' should pass since it's not in the default placeholder list
    const ctx2 = makeCtx({ spec: { owner: 'tbd' } }, [], ['unknown']);
    expect(check.run(ctx2).failed).toBe(false);
  });
});

// ─── ZombieCheck ──────────────────────────────────────────────────────────────

describe('ZombieCheck', () => {
  const check = new ZombieCheck();

  it('fails when owner group is not in the live registry', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'group:default/dead-team' } }, []),
    );
    expect(result.failed).toBe(true);
    expect(result.checkName).toBe('zombie');
  });

  it('passes when owner group is in the live registry', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'group:default/alive-team' } }, [
        'group:default/alive-team',
      ]),
    );
    expect(result.failed).toBe(false);
  });

  it('does not flag orphaned entities (those are handled by OrphanedCheck)', () => {
    const result = check.run(makeCtx({ spec: { owner: 'unknown' } }, []));
    expect(result.failed).toBe(false);
  });

  it('does not flag entities with no owner', () => {
    const result = check.run(makeCtx({ spec: {} }, []));
    expect(result.failed).toBe(false);
  });

  it('normalises short group names without prefix', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'alive-team' } }, ['group:default/alive-team']),
    );
    expect(result.failed).toBe(false);
  });

  it('normalises group: prefix without namespace', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'group:alive-team' } }, [
        'group:default/alive-team',
      ]),
    );
    expect(result.failed).toBe(false);
  });

  it('includes owner ref in details when failing', () => {
    const result = check.run(
      makeCtx({ spec: { owner: 'group:default/dead-team' } }, []),
    );
    expect(result.details?.owner).toBe('group:default/dead-team');
  });

  describe('User owners', () => {
    const withUsers = (
      owner: string,
      liveUsers: string[] | undefined,
      liveGroups: string[] = [],
    ): OwnershipCheckContext => ({
      ...makeCtx({ spec: { owner } }, liveGroups),
      liveUserRegistry: liveUsers && new Set(liveUsers),
    });

    describe('excludeUserKind: true', () => {
      const lenient = new ZombieCheck({ excludeUserKind: true });

      it('passes for a user owner that is in no registry', () => {
        expect(lenient.run(withUsers('user:default/ghost', [])).failed).toBe(
          false,
        );
        expect(
          lenient.run(withUsers('user:default/ghost', undefined)).failed,
        ).toBe(false);
      });

      it('still flags dead group owners', () => {
        expect(
          lenient.run(withUsers('group:default/dead-team', [])).failed,
        ).toBe(true);
        expect(lenient.run(withUsers('dead-team', [])).failed).toBe(true);
      });

      it('still defers placeholders to OrphanedCheck', () => {
        expect(lenient.run(withUsers('unknown', [])).failed).toBe(false);
      });
    });

    describe('excludeUserKind: false (default)', () => {
      it('passes for a live user owner', () => {
        expect(
          check.run(withUsers('user:default/jdoe', ['user:default/jdoe']))
            .failed,
        ).toBe(false);
      });

      it('fails for a user owner that does not exist', () => {
        const result = check.run(
          withUsers('user:default/ghost', ['user:default/jdoe']),
        );
        expect(result.failed).toBe(true);
        expect(result.details).toEqual({
          owner: 'user:default/ghost',
          normalizedRef: 'user:default/ghost',
        });
      });

      it('fails when no user registry is provided', () => {
        expect(
          check.run(withUsers('user:default/jdoe', undefined)).failed,
        ).toBe(true);
      });

      it('normalises user: prefix without namespace', () => {
        expect(
          check.run(withUsers('user:jdoe', ['user:default/jdoe'])).failed,
        ).toBe(false);
      });

      it('matches user refs case-insensitively', () => {
        expect(
          check.run(withUsers('User:Default/JDoe', ['user:default/jdoe']))
            .failed,
        ).toBe(false);
      });

      it('does not look user owners up in the group registry', () => {
        expect(
          check.run(withUsers('user:default/jdoe', [], ['user:default/jdoe']))
            .failed,
        ).toBe(true);
      });

      it('treats bare names as groups, not users', () => {
        expect(check.run(withUsers('jdoe', ['user:default/jdoe'])).failed).toBe(
          true,
        );
      });
    });
  });
});

// ─── Check Priority ──────────────────────────────────────────────────────────

// 1.1.8 — orphaned wins over zombie when both could fire
describe('Check priority ordering', () => {
  const orphaned = new OrphanedCheck();
  const zombie = new ZombieCheck();

  it('orphaned has higher priority than zombie in BUILTIN_CHECK_PRIORITY', () => {
    const orphanedIdx = BUILTIN_CHECK_PRIORITY.indexOf('orphaned');
    const zombieIdx = BUILTIN_CHECK_PRIORITY.indexOf('zombie');
    expect(orphanedIdx).toBeLessThan(zombieIdx);
  });

  it('entity with placeholder owner: orphaned fails, zombie does not', () => {
    // Owner is 'unknown' (placeholder) and not in liveGroupRegistry.
    // OrphanedCheck should fire; ZombieCheck should NOT (it defers to OrphanedCheck).
    const ctx = makeCtx({ spec: { owner: 'unknown' } }, []);
    expect(orphaned.run(ctx).failed).toBe(true);
    expect(zombie.run(ctx).failed).toBe(false);
  });
});
