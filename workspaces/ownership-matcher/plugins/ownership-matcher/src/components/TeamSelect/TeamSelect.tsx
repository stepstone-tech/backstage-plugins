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

import { FormControl, InputLabel, Select, MenuItem } from '@material-ui/core';
import { makeStyles } from '@material-ui/core/styles';
import { displayGroupRef } from '../../utils/entityRef';

const useStyles = makeStyles(theme => ({
  root: {
    minWidth: 320,
    marginBottom: theme.spacing(3),
  },
}));

/**
 * Team picker for the user-facing page, consolidated from `GroupSelector`.
 * Still Material UI — the BUI conversion to an async-loaded select is
 * pending.
 */
export const TeamSelect = ({
  groups,
  value,
  onChange,
}: {
  groups: string[];
  value: string;
  onChange: (v: string) => void;
}) => {
  const classes = useStyles();
  return (
    <FormControl variant="outlined" className={classes.root}>
      <InputLabel>Showing proposals for</InputLabel>
      <Select
        value={value}
        onChange={e => onChange(e.target.value as string)}
        label="Showing proposals for"
      >
        <MenuItem value="__all__">All my teams</MenuItem>
        {groups.map(g => (
          <MenuItem key={g} value={g}>
            {displayGroupRef(g)}
          </MenuItem>
        ))}
      </Select>
    </FormControl>
  );
};
