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

import { setSpecOwner, toCatalogOwnerValue } from './catalogInfoEditor';

const target = { kind: 'Component', name: 'my-service' };

describe('setSpecOwner', () => {
  it('replaces only the owner scalar, preserving comments and formatting byte-for-byte', () => {
    const content = [
      '# Top-level comment',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Component',
      'metadata:',
      '  name: my-service   # trailing comment',
      '  annotations:',
      '    backstage.io/techdocs-ref: dir:.',
      'spec:',
      '  type: service',
      '',
      '  # who owns this',
      '  owner: group:old-team # legacy owner',
      '  lifecycle:   production',
      '',
    ].join('\n');

    const result = setSpecOwner(content, target, 'group:new-team');

    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect(result.content).toBe(
      content.replace('owner: group:old-team', 'owner: group:new-team'),
    );
    expect((result.entity.spec as any).owner).toBe('group:new-team');
  });

  it('keeps the original quote style', () => {
    const single =
      "kind: Component\nmetadata:\n  name: my-service\nspec:\n  owner: 'old'\n";
    const double =
      'kind: Component\nmetadata:\n  name: my-service\nspec:\n  owner: "old"\n';

    const r1 = setSpecOwner(single, target, 'group:new-team');
    const r2 = setSpecOwner(double, target, 'group:new-team');

    expect(r1.status === 'changed' && r1.content).toContain(
      "owner: 'group:new-team'",
    );
    expect(r2.status === 'changed' && r2.content).toContain(
      'owner: "group:new-team"',
    );
  });

  it('edits only the matching document in a multi-document file', () => {
    const content = [
      'kind: System',
      'metadata:',
      '  name: my-service',
      'spec:',
      '  owner: group:system-team',
      '---',
      '# the component',
      'kind: Component',
      'metadata:',
      '  name: my-service',
      'spec:',
      '  owner: group:old-team',
      '---',
      'kind: API',
      'metadata:',
      '  name: my-api',
      'spec:',
      '  owner: group:old-team',
      '',
    ].join('\n');

    const result = setSpecOwner(content, target, 'group:new-team');

    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    const lines = result.content.split('\n');
    expect(lines[4]).toBe('  owner: group:system-team');
    expect(lines[11]).toBe('  owner: group:new-team');
    expect(lines[17]).toBe('  owner: group:old-team');
    expect(result.content).toContain('# the component');
  });

  it('adds spec.owner when it is missing', () => {
    const content =
      'kind: Component\nmetadata:\n  name: my-service\nspec:\n  # keep me\n  type: service\n';

    const result = setSpecOwner(content, target, 'group:new-team');

    expect(result.status).toBe('changed');
    if (result.status !== 'changed') return;
    expect(result.content).toContain('# keep me');
    expect(result.content).toContain('owner: group:new-team');
    expect((result.entity.spec as any).type).toBe('service');
  });

  it('returns unchanged when the owner already matches', () => {
    const content =
      'kind: Component\nmetadata:\n  name: my-service\nspec:\n  owner: group:new-team\n';
    expect(setSpecOwner(content, target, 'group:new-team')).toEqual({
      status: 'unchanged',
    });
  });

  it('returns entity-not-found when no document matches kind/name/namespace', () => {
    const content =
      'kind: Component\nmetadata:\n  name: other\n  namespace: default\nspec:\n  owner: x\n';
    expect(setSpecOwner(content, target, 'group:t').status).toBe(
      'entity-not-found',
    );
    expect(
      setSpecOwner(
        'kind: Component\nmetadata:\n  name: my-service\n  namespace: other\nspec:\n  owner: x\n',
        target,
        'group:t',
      ).status,
    ).toBe('entity-not-found');
  });

  it('returns parse-error for invalid YAML', () => {
    const result = setSpecOwner(
      'kind: Component\n  bad: [unclosed\n',
      target,
      'group:t',
    );
    expect(result.status).toBe('parse-error');
  });

  it('returns parse-error when the entity has no spec mapping', () => {
    const result = setSpecOwner(
      'kind: Component\nmetadata:\n  name: my-service\n',
      target,
      'group:t',
    );
    expect(result.status).toBe('parse-error');
  });
});

describe('toCatalogOwnerValue (catalog-info template convention)', () => {
  it('writes default-namespace groups as the bare name', () => {
    expect(toCatalogOwnerValue('group:default/team-a')).toBe('team-a');
  });
  it.each(['group:other/team-x', 'user:default/jane.doe'])(
    'keeps any other ref verbatim: %s',
    ref => {
      expect(toCatalogOwnerValue(ref)).toBe(ref);
    },
  );
});
