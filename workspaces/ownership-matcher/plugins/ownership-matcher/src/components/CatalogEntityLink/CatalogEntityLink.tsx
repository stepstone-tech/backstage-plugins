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
import { Link } from '@backstage/core-components';
import { entityRefToCatalogPath } from '../../utils/entityRef';

/**
 * Link to an entity's catalog page, consolidated from the repeated
 * `<Link to={entityRefToCatalogPath(ref)}>` + caption block used across the
 * admin tables, plus the bare "View in catalog" links used in the drawers.
 *
 * With `caption`, renders the name/kind block used in table cells. Without
 * it, renders a bare link — the shape the drawers' "View in catalog →" and
 * the detail page's "View entity" links need.
 */
export const CatalogEntityLink = ({
  entityRef,
  label,
  caption,
}: {
  entityRef: string;
  label?: ReactNode;
  caption?: string;
}) => {
  const link = (
    <Link to={entityRefToCatalogPath(entityRef)}>{label ?? entityRef}</Link>
  );
  if (!caption) return link;
  return (
    <Box>
      {link}
      <Typography variant="caption" color="textSecondary" display="block">
        {caption}
      </Typography>
    </Box>
  );
};
