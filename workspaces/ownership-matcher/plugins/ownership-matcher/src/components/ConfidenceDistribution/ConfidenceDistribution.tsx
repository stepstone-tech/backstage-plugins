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

import { Card, CardContent, Box, Typography } from '@material-ui/core';
import { ConfidenceBucket } from '../../api';

const BUCKET_COLORS = ['#e57373', '#ff9800', '#ffb74d', '#81c784', '#4caf50'];

/** Compact horizontal-bar chart of proposal confidence buckets. */
export const ConfidenceDistribution = ({
  buckets,
}: {
  buckets: ConfidenceBucket[];
}) => {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  const maxCount = Math.max(...buckets.map(b => b.count), 1);

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
          padding: '16px 20px',
          flexGrow: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <Typography variant="subtitle2" color="textSecondary" gutterBottom>
          Confidence Distribution
        </Typography>
        <Box display="flex" flexDirection="column" style={{ gap: 6 }}>
          {buckets.map((b, i) => {
            const widthPct = (b.count / maxCount) * 100;
            const sharePct =
              total > 0 ? ((b.count / total) * 100).toFixed(0) : '0';
            return (
              <Box
                key={b.label}
                display="flex"
                alignItems="center"
                style={{ gap: 8 }}
              >
                <Typography
                  variant="caption"
                  color="textSecondary"
                  style={{ width: 52, flexShrink: 0 }}
                >
                  {b.label}
                </Typography>
                <Box
                  style={{
                    flex: 1,
                    backgroundColor: '#f0f0f0',
                    borderRadius: 3,
                    height: 10,
                  }}
                >
                  <Box
                    style={{
                      width: `${Math.max(widthPct, b.count > 0 ? 2 : 0)}%`,
                      height: '100%',
                      backgroundColor: BUCKET_COLORS[i],
                      borderRadius: 3,
                    }}
                  />
                </Box>
                <Typography
                  variant="caption"
                  style={{ width: 28, flexShrink: 0, textAlign: 'right' }}
                >
                  {b.count}
                </Typography>
                <Typography
                  variant="caption"
                  color="textSecondary"
                  style={{ width: 32, flexShrink: 0, textAlign: 'right' }}
                >
                  {sharePct}%
                </Typography>
              </Box>
            );
          })}
        </Box>
      </CardContent>
    </Card>
  );
};
