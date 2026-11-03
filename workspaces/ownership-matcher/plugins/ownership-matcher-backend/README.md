# @stepstone-tech/backstage-plugin-ownership-matcher-backend

Backend for ownership-matcher. It scans the catalog for entities without a valid owner, proposes owner teams, escalates unresolved cases, opens catalog-info PRs for accepted owners and sends an optional email digest.

## Installation

```sh
yarn --cwd packages/backend add @stepstone-tech/backstage-plugin-ownership-matcher-backend
```

```ts
// packages/backend/src/index.ts
backend.add(
  import('@stepstone-tech/backstage-plugin-ownership-matcher-backend'),
);
```

Requires the catalog, notifications, events and permission backends. Add an SCM provider module (for example [Bitbucket Server](../ownership-matcher-backend-module-bitbucket-server/README.md)) for commit-based proposals and catalog-info PRs.

## Configuration

Everything is optional; with no configuration the plugin scans daily with the `orphaned` and `zombie` checks. A typical setup:

```yaml
ownershipMatcher:
  catalog:
    teamGroupTypes: [team]
  scm:
    hosts:
      - host: git.example.com
        writeToken: ${SCM_WRITE_TOKEN}
  escalation:
    levels:
      - groupFilter: 'Group:department'
        titlePatterns: ['.*Director.*']
        timeoutDays: 7
```

`titlePatterns` matches User job titles, which your catalog ingestion must populate — see [Job titles](docs/escalation.md#job-titles).

Set `owners.excludeUserKind: true` if User owners should never be flagged as zombies (default `false`: a User owner must exist in the catalog).

See [Configuration](docs/configuration.md) for all keys.

## Documentation

| Doc                                          | Content                                                    |
| -------------------------------------------- | ---------------------------------------------------------- |
| [Configuration](docs/configuration.md)       | All config keys, defaults and validation                   |
| [Proposal scoring](docs/proposal-scoring.md) | Strategies, weights, thresholds, worked example            |
| [Statuses](docs/statuses.md)                 | Case, proposal and PR statuses and transitions             |
| [Escalation](docs/escalation.md)             | Escalation queue, actors, timeouts, grace periods          |
| [Notifications](docs/notifications.md)       | Notification topics and the email digest                   |
| [Catalog-info PRs](docs/catalog-info-prs.md) | PR jobs, retries and reconciliation with the catalog       |
| [Extending](docs/extending.md)               | Custom checks, strategies, SCM providers and email senders |

## Checks

- `orphaned`: `spec.owner` is missing or a placeholder (`checks.orphaned.placeholderValues`).
- `zombie`: `spec.owner` is a Group that no longer exists. A `user:` owner is flagged when that User no longer exists, or never when `owners.excludeUserKind` is `true`.

If several fail, `orphaned` wins over `zombie`, which wins over custom checks.

## Scheduled tasks

| Task id                              | Schedule                                            |
| ------------------------------------ | --------------------------------------------------- |
| `ownership-matcher-scan`             | `schedule` (daily by default)                       |
| `ownership-matcher-deadline-checker` | Every 15 min: deadlines, PR jobs, PR reconciliation |
| `ownership-matcher-reminders`        | Daily, if `notifications.remindersEnabled`          |
| `ownership-matcher-email-digest`     | `email.schedule`, if a sender or `dryRun` is set    |

## Permissions

`ownershipMatcherAdminPermission` (`ownership-matcher.admin`) is required for the admin endpoints (stats, entity and proposal lists, scans, manager chain, digest trigger) and lets admins act on any case. Team members act on their own team's proposals, and escalation actors on cases assigned to them.

## API

Base path `/api/ownership-matcher`.

| Method | Path                                                                 | Access                                                            |
| ------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/stats`, `/entities`, `/proposals`, `/scans`, `/scans/:id`          | admin                                                             |
| POST   | `/scans/trigger`, `/email-digest/trigger`                            | admin                                                             |
| GET    | `/entities/:id`, `/entities/:id/proposals`                           | admin, proposed or assigned team, actor                           |
| POST   | `/entities/:id/pr/retry`                                             | admin, assigned team                                              |
| GET    | `/proposals/mine/summary`, `/proposals/for-team?teamRef=`            | user (own teams)                                                  |
| POST   | `/proposals/:id/accept`, `/proposals/:id/reject`                     | admin, proposed team                                              |
| GET    | `/leadership/stats`, `/leadership/entities`, `/leadership/proposals` | user (managed teams)                                              |
| GET    | `/definitions`                                                       | user                                                              |
| POST   | `/entities/:id/escalation/{assign,suggest,archive,reject}`           | escalation actor; admins can assign or archive `unresolved` cases |
| POST   | `/entities/:id/escalation/retrigger`                                 | fallback actors                                                   |
| GET    | `/escalation/manager-chain?ref=`                                     | admin                                                             |

The `/leadership/*` routes accept `?asUser=<entityRef>` to resolve a different identity, but only when `ownershipMatcher.dangerouslyAllowAsUserOverride` is set — off by default, local development only. See [Configuration](docs/configuration.md#dangerouslyallowasuseroverride).

Escalation endpoints exist only when `escalation` is configured. The UI uses only `assign` and `archive`; `suggest` and `reject` are API-only (see [Escalation](docs/escalation.md#actor-decisions)).

## Development

Run `yarn start` from the workspace root; see the [workspace README](../../README.md#local-development).
