# Configuration

All keys live under `ownershipMatcher` and are optional. The schema is in [`config.d.ts`](../config.d.ts); run `yarn backstage-cli config:check --strict` to check keys and types. Value rules are validated when the backend starts, and an invalid value stops startup.

## Full example

Defaults are shown where they exist.

```yaml
ownershipMatcher:
  schedule:
    frequency: { hours: 24 }
    timeout: { minutes: 30 }
    initialDelay: { seconds: 30 }

  filters:
    excludeKinds: [User, Group, Location, Template]
    requireAnnotations: []
    excludeOwners: []
    excludeNamespaces: []
    excludeTypes: []

  checks:
    enabled: [orphaned, zombie]
    orphaned:
      placeholderValues: [unknown]

  owners:
    excludeUserKind: false

  proposals:
    maxCandidatesPerEntity: 5
    autoExpiry: false
    expirationDays: 14
    minimumScoreThreshold: 0
    notificationThreshold: 0.4
    strategies:
      - name: top-contributor
        weight: 0.5
        maxCandidates: 3
        commitsLimit: 25
      - name: org-proximity
        weight: 0.3
      - name: fallback
        action: escalated

  contributors:
    excludeEmails: []
    excludePatterns: []
    excludeUsernames: []

  notifications:
    enabled: true
    remindersEnabled: false
    reminderAfterDays: 7
    acceptancePendingReminderDays: 7

  escalation:
    gracePeriodDays: 14
    warningDays: 4
    reDecisionDays: 3
    fallbackActors: [group:default/platform-team]
    levels:
      - groupFilter: 'Group:domain'
        titlePatterns: ['Director.*']
        managerChain: false
        timeoutDays: 7
      - groupFilter: 'Group:portfolio'
        titlePatterns: ['.*VP.*']
        timeoutDays: 14

  catalog:
    annotations:
      userAlias: example.com/user-alias
      manager: example.com/manager-alias
    teamGroupTypes: [team]

  scm:
    hosts:
      - host: git.example.com
        writeToken: ${SCM_WRITE_TOKEN}

  prCreation:
    enabled: true
    maxAttempts: 5
    mergeGraceHours: 24

  email:
    dryRun: false
    supportUrl: https://help.example.com
    schedule:
      frequency: { months: 1 }
      timeout: { minutes: 30 }
      initialDelay: { minutes: 5 }

  dangerouslyAllowAsUserOverride: false
```

## Keys

### `schedule`

Schedule of the scan task (`ownership-matcher-scan`). Standard Backstage task schedule: if you set it, `frequency` and `timeout` are required.

### `filters`

| Key                  | Default                               | Description                                                                                                  |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `excludeKinds`       | `[User, Group, Location, Template]`   | Kinds never scanned. Setting it replaces the default.                                                        |
| `requireAnnotations` | `[]`                                  | Only scan entities that have all of these annotations.                                                       |
| `excludeOwners`      | `[]`                                  | Skip entities whose `spec.owner` matches one of these refs.                                                  |
| `excludeNamespaces`  | `[]`                                  | Skip entities in these namespaces.                                                                           |
| `excludeTypes`       | `[]`                                  | Skip entities by `Kind:type` (case-insensitive), e.g. `Resource:cloud-account`. Open cases are closed as out of scope. |

### `checks`

| Key                          | Default              | Description                                                                 |
| ---------------------------- | -------------------- | --------------------------------------------------------------------------- |
| `enabled`                    | `[orphaned, zombie]` | Active checks. Custom checks from modules must be listed here to run.       |
| `orphaned.placeholderValues` | `[unknown]`          | Owner values treated as "no owner" (case-insensitive).                      |

### `owners`

| Key               | Default | Description                                                                                                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `excludeUserKind` | `false` | `true`: entities owned by a User (`user:<ns>/<name>`) are never flagged by `zombie`. `false`: a User owner is flagged only if that User no longer exists in the catalog. Proposals always target groups. |

### `proposals`

See [Proposal scoring](proposal-scoring.md).

| Key                      | Default | Description                                                                                       |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `maxCandidatesPerEntity` | `5`     | Max candidates stored per entity per scan.                                                        |
| `autoExpiry`             | `false` | When true, pending proposals expire after `expirationDays`.                                       |
| `expirationDays`         | `14`    | Days before an unanswered proposal expires.                                                       |
| `expirationMinutes`      | unset   | Overrides `expirationDays`; meant for testing.                                                    |
| `minimumScoreThreshold`  | `0`     | Candidates below it are dropped; the top candidate is always kept.                                |
| `notificationThreshold`  | `0.4`   | Candidates at or above it are notified; lower ones become `possible_owner`. Between `minimumScoreThreshold` and 1. |
| `strategies`             | see example | Ordered list of strategies. Setting it replaces the default list.                             |

Strategy options:

| Key             | Applies to        | Description                                                                                      |
| --------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `name`          | all               | `top-contributor`, `org-proximity`, `fallback`, or the name of a strategy added by a module.     |
| `weight`        | all but fallback  | Weight in the combined score. Defaults: top-contributor 0.5, org-proximity 0.3, others 1.0.      |
| `maxCandidates` | top-contributor   | Max teams returned.                                                                              |
| `commitsLimit`  | top-contributor   | Number of recent commits analysed.                                                               |
| `action`        | fallback          | `escalated` (no candidate; see [when nothing is found](proposal-scoring.md#when-nothing-is-found)) or `fixed-owner`.                              |
| `owner`         | fallback          | Group ref proposed by `fixed-owner`.                                                             |

`proposals.confidenceTiers` is accepted but has no effect.

### `contributors`

Commit authors ignored by `top-contributor`, e.g. bots: `excludeEmails`, `excludeUsernames` and `excludePatterns` (regexes matched against the author email).

### `notifications`

See [Notifications](notifications.md).

| Key                             | Default | Description                                                                         |
| ------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `enabled`                       | `true`  | Turns all Backstage notifications on or off.                                        |
| `remindersEnabled`              | `false` | Runs the daily reminder task for pending proposals.                                 |
| `reminderAfterDays`             | `7`     | Days since the last notification before a reminder is sent.                        |
| `acceptancePendingReminderDays` | `7`     | Minimum days between reminders to update `spec.owner` after an acceptance.          |

`notifications.channels` is accepted but has no effect.

### `escalation`

Omit the block to disable escalation. See [Escalation](escalation.md). Escalation actors are matched by job title, which no Backstage provider sets by default — see [Job titles](escalation.md#job-titles) before enabling this block.

| Key                    | Default | Description                                                                                       |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `levels`               | —       | Required, non-empty. Escalation levels in order.                                                  |
| `gracePeriodDays`      | `14`    | Days to update the catalog owner after an assignment.                                             |
| `warningDays`          | `4`     | Days before the grace period ends to send a warning. Must be less than `gracePeriodDays`.         |
| `reDecisionDays`       | `3`     | Extra window when a grace period ends and no next actor is left.                                  |
| `fallbackActors`       | unset   | User or group refs allowed to retrigger unresolved cases.                                         |

Level options:

| Key             | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `groupFilter`   | `Kind` or `Kind:type` of the ancestor group to escalate to, e.g. `Group:domain`.                  |
| `titlePatterns` | Non-empty list of regexes matched against the user job title (`metadata.userDetails.jobTitle`). See [Job titles](escalation.md#job-titles). |
| `managerChain`  | `false`: match members of the group. `true`: walk each team member's manager chain instead.       |
| `timeoutDays`   | Positive integer. Days the actor has before the case moves on.                                    |

### `catalog`

How your catalog models people and teams. Also read by the frontend and by other plugins built on the node package.

| Key                     | Default  | Description                                                                                                                      |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `annotations.userAlias` | unset    | User annotation with an alternative login. Commit emails whose local part doesn't match a user name are matched against it.      |
| `annotations.manager`   | unset    | User annotation with the manager's `userAlias` value. Required, together with `userAlias`, for levels with `managerChain: true`. |
| `teamGroupTypes`        | `[team]` | Group `spec.type` values that can own entities. Must not be empty.                                                               |

### `scm`

`scm.hosts[]` adds per-host settings to the `integrations.*` entries. `writeToken` is used for catalog-info PRs. Hosts, API URLs and read credentials come from `integrations.*`.

### `prCreation`

See [Catalog-info PRs](catalog-info-prs.md).

| Key               | Default | Description                                                     |
| ----------------- | ------- | --------------------------------------------------------------- |
| `enabled`         | `true`  | Set to `false` to never open PRs.                               |
| `maxAttempts`     | `5`     | Attempts per PR job before it stays failed.                     |
| `mergeGraceHours` | `24`    | Hours a merged PR may take to show up in the catalog.           |

### `email`

Omit the block to disable the email digest. See [Notifications](notifications.md#email-digest).

| Key          | Default             | Description                                                              |
| ------------ | ------------------- | ------------------------------------------------------------------------ |
| `dryRun`     | `false`             | Write emails to the temp directory instead of sending them.              |
| `supportUrl` | unset               | http(s) link shown as "Need help?" in the email.                         |
| `schedule` | monthly, 30 min timeout, 5 min delay | Digest task schedule. If set, `frequency` and `timeout` are required. |

Transport settings belong to the sender module, e.g. `email.msgraph` for the Microsoft Graph module. The digest also requires `app.baseUrl` and uses `app.title` for branding.

### `dangerouslyAllowAsUserOverride`

| Key                              | Default | Description                                                     |
| -------------------------------- | ------- | --------------------------------------------------------------- |
| `dangerouslyAllowAsUserOverride` | `false` | Allow `?asUser=<entityRef>` to override the caller on `/leadership/*`. |

**Local development only.** With it on, `GET /leadership/stats`, `/leadership/entities` and `/leadership/proposals` resolve the identity from the `asUser` query parameter instead of the caller's token.

Those three routes are the only ones that do not call `assertAdmin` — they substitute identity scoping for a permission check, so the resolved identity *is* the authorisation boundary. Enabling this lets any authenticated user pick a ref whose job title matches the escalation `titlePatterns`, expand that person's whole group subtree, and read org-wide ownership data that otherwise requires `ownershipMatcherAdminPermission`. Write paths are unaffected — they always read the identity from the token.

The backend logs a warning at startup whenever it is enabled. Set it in a gitignored `app-config.local.yaml`, never in a deployed config.
