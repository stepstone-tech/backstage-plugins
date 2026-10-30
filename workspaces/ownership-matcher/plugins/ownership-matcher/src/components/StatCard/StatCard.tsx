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
import { Card, CardContent, Typography } from '@material-ui/core';

/**
 * Glance-level KPI tile: title, big value, optional subtitle.
 *
 * Consolidated from two copies (`UserOwnershipPage`, `OwnershipMatcherPage`)
 * that had drifted slightly in layout — the admin page's flex/space-evenly
 * `CardContent` is kept over the user page's `gutterBottom` title, since it
 * degrades more gracefully in a `Grid` of uneven-height siblings.
 */
export const StatCard = ({
  title,
  value,
  subtitle,
}: {
  title: string;
  value: ReactNode;
  subtitle?: string;
}) => {
  return (
    <Card
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <CardContent
        style={{
          flexGrow: 1,
          textAlign: 'center',
          padding: '24px 16px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-evenly',
        }}
      >
        <Typography variant="subtitle2" color="textSecondary">
          {title}
        </Typography>
        <Typography variant="h3">{value}</Typography>
        {subtitle && (
          <Typography variant="caption" color="textSecondary">
            {subtitle}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
};
