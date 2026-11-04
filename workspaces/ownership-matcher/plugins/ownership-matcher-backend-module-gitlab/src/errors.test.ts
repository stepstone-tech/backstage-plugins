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

import { gitlabErrorMessage, toScmError } from './errors';

const body = (message: unknown) => JSON.stringify({ message });

describe('gitlabErrorMessage', () => {
  it('reads a string message', () => {
    expect(gitlabErrorMessage(body('404 Project Not Found'))).toBe(
      '404 Project Not Found',
    );
  });

  it('joins a list of messages', () => {
    expect(
      gitlabErrorMessage(
        body([
          'Another open merge request already exists for this source branch: !1',
        ]),
      ),
    ).toBe(
      'Another open merge request already exists for this source branch: !1',
    );
  });

  it('flattens a field → messages object', () => {
    expect(
      gitlabErrorMessage(
        body({ base: ['Something went wrong'], title: ["can't be blank"] }),
      ),
    ).toBe("Something went wrong; title can't be blank");
  });

  it('reads OAuth-style errors', () => {
    expect(
      gitlabErrorMessage(
        JSON.stringify({
          error: 'insufficient_scope',
          error_description: 'The request requires higher privileges',
        }),
      ),
    ).toBe('insufficient_scope: The request requires higher privileges');
  });

  it('falls back to a truncated raw body', () => {
    expect(gitlabErrorMessage('x'.repeat(500))).toHaveLength(200);
  });
});

describe('toScmError', () => {
  it.each([
    [
      400,
      'You are attempting to update a file that has changed since you started editing it.',
      'conflict',
    ],
    [400, 'Branch already exists', 'conflict'],
    [400, 'A file with this name already exists', 'conflict'],
    [403, 'This project is archived and cannot be modified', 'read-only'],
    [503, 'GitLab is in maintenance mode', 'read-only'],
    [404, 'Archived project not found', 'not-found'],
    [401, '401 Unauthorized', 'auth'],
    [403, '403 Forbidden', 'auth'],
    [404, '404 Not Found', 'not-found'],
    [409, 'Another open merge request already exists', 'conflict'],
    [409, 'Something else', 'conflict'],
    [429, 'Retry later', 'rate-limited'],
    [400, 'Invalid reference name', 'invalid'],
    [422, 'Unprocessable', 'invalid'],
    [500, 'Internal Server Error', 'unavailable'],
    [502, 'Bad gateway', 'unavailable'],
    [418, 'teapot', 'unknown'],
  ])('maps %i %j to %s', (status, message, kind) => {
    const err = toScmError(status, body(message));
    expect(err.kind).toBe(kind);
    expect(err.httpStatus).toBe(status);
    expect(err.message).toBe(message);
  });

  it('uses the HTTP status when the body is empty', () => {
    expect(toScmError(500, '').message).toBe('HTTP 500');
  });
});
