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

import { ReactNode } from 'react';
import { Box, Typography } from '@material-ui/core';

/**
 * Shared "nothing here" block, consolidated from the repeated `Box` +
 * `Typography` pairs used for table empty states, error states and the
 * no-proposals/no-teams messages across all three pages.
 *
 * `center`/`padding` default to the compact table-cell shape (`p={2}`, left
 * aligned); pages that used the roomier centered variant pass `center` and
 * `padding={4}` explicitly, matching their previous layout exactly.
 */
export const EmptyState = ({
  message,
  error,
  center,
  padding = 2,
}: {
  message: ReactNode;
  error?: boolean;
  center?: boolean;
  padding?: number;
}) => {
  return (
    <Box p={padding} textAlign={center ? 'center' : undefined}>
      <Typography color={error ? 'error' : undefined}>{message}</Typography>
    </Box>
  );
};
