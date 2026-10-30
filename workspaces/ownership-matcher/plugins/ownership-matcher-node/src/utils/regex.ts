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

/** Maximum length of a regex pattern string sourced from operator config. */
export const MAX_REGEX_PATTERN_LENGTH = 200;

/** Maximum length of a string passed to a config-sourced regex `.test()`. */
export const MAX_REGEX_INPUT_LENGTH = 512;

/**
 * Compile a regex pattern sourced from operator-controlled configuration.
 *
 * Caps pattern length as a defense-in-depth bound against pathological inputs.
 * Patterns failing to compile throw the underlying `SyntaxError` from `RegExp`.
 */
export function compileConfigRegex(pattern: string, flags?: string): RegExp {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern too long (${pattern.length} > ${MAX_REGEX_PATTERN_LENGTH} chars)`,
    );
  }
  return new RegExp(pattern, flags);
}

/**
 * Run a regex `.test()` against caller-supplied input, truncating to
 * {@link MAX_REGEX_INPUT_LENGTH} first. Bounds worst-case execution time
 * against pathological patterns that would otherwise allow ReDoS.
 */
export function testConfigRegex(re: RegExp, input: string): boolean {
  const bounded =
    input.length > MAX_REGEX_INPUT_LENGTH
      ? input.slice(0, MAX_REGEX_INPUT_LENGTH)
      : input;
  return re.test(bounded);
}
