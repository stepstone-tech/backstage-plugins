# ownership-matcher

Finds catalog entities whose owner is missing or no longer exists, proposes new owner teams, and escalates through the organization until someone takes ownership.

How it works:

1. A scheduled scan runs **checks** on catalog entities (`orphaned`: no owner or a placeholder owner; `zombie`: the owner is not an existing group).
2. For each failing entity, **proposal strategies** (commit history, catalog hierarchy, fallback) score candidate teams. Teams above a threshold are notified.
3. A team **accepts** or **rejects** the proposal in the UI. On acceptance, the plugin opens a pull request that updates `spec.owner` in `catalog-info.yaml`, then confirms the change reached the catalog.
4. If all proposals are rejected or expire, the case is **escalated** up the group hierarchy to people matched by job title, who can assign an owner or mark the entity for archiving. If they don't act in time, the next person takes over.

```mermaid
flowchart LR
  scan[Scan catalog] --> checks{Checks<br/>orphaned, zombie}
  checks -- passes --> none([No case])
  checks -- fails --> proposals[Score candidate teams]
  proposals -- above threshold --> decision{Team decision}
  proposals -- only below threshold --> possible([Possible owner,<br/>claimable in UI])
  proposals -- no candidates --> unresolved([Unresolved])
  decision -- accept --> pr[Catalog-info PR]
  decision -- all rejected or expired --> escalation{Escalation<br/>up group hierarchy}
  escalation -- assign --> pr
  escalation -- archive --> closed([Closed])
  escalation -- exhausted --> unresolved
  pr -- catalog updated --> closed
  unresolved -- retrigger --> proposals
  unresolved -- admin assigns --> pr
```

See [Statuses](plugins/ownership-matcher-backend/docs/statuses.md) and [Escalation](plugins/ownership-matcher-backend/docs/escalation.md) for details.

## Packages

| Package                                                                                                                                                     | Description                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [`@stepstone-tech/backstage-plugin-ownership-matcher`](plugins/ownership-matcher/README.md)                                                                 | Frontend plugin                                   |
| [`@stepstone-tech/backstage-plugin-ownership-matcher-backend`](plugins/ownership-matcher-backend/README.md)                                                 | Backend plugin: scans, proposals, escalation, PRs |
| [`@stepstone-tech/backstage-plugin-ownership-matcher-node`](plugins/ownership-matcher-node/README.md)                                                       | Extension points and contracts for modules        |
| [`@stepstone-tech/backstage-plugin-ownership-matcher-common`](plugins/ownership-matcher-common/README.md)                                                   | Notification origin and topic names               |
| [`@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-bitbucket-server`](plugins/ownership-matcher-backend-module-bitbucket-server/README.md) | Bitbucket Server SCM provider                     |
| [`@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-msgraph-email`](plugins/ownership-matcher-backend-module-msgraph-email/README.md)       | Email digest sender using Microsoft Graph         |

## Local development

From the repository root:

```sh
yarn start ownership-matcher   # or `yarn start` while this is the only workspace
```

This starts Postgres in Docker (`docker-compose.yml`, `127.0.0.1:54321`) and the `dev/` entry points:

- frontend: http://localhost:3000, with the catalog, notifications, org and signals plugins
- backend: http://127.0.0.1:7007, with catalog, auth, permissions, events, notifications, signals and ownership-matcher

Configuration is in `app-config.yaml`, plus an optional gitignored `app-config.local.yaml`. You are signed in as a guest, permissions are allow-all, and the catalog is loaded from `examples/`. The first scan runs 30 seconds after startup and flags the two sample components with a bad owner.

The Bitbucket Server and Microsoft Graph modules need real credentials, so the dev backend doesn't install them. To try one, configure it in `app-config.local.yaml` and add it in `plugins/ownership-matcher-backend/dev/index.ts`.

## Integration tests

The backend integration tests use a real Postgres through testcontainers, so Docker is required:

```sh
yarn workspace @stepstone-tech/backstage-plugin-ownership-matcher-backend test:integration
```

With Rancher Desktop or Colima, export `DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}')` and `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock` first.
