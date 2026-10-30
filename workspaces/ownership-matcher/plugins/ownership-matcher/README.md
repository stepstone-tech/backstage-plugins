# @stepstone-tech/backstage-plugin-ownership-matcher

Frontend for ownership-matcher. Teams see and accept or reject ownership proposals, escalation actors resolve escalated cases, and admins get a catalog-wide overview.

Requires the [backend plugin](../ownership-matcher-backend/README.md), the catalog plugin and the permission framework. Only the new frontend system is supported.

## Installation

```sh
yarn --cwd packages/app add @stepstone-tech/backstage-plugin-ownership-matcher
```

With feature discovery (`app.packages: all`) adding the package is enough. Otherwise:

```ts
// packages/app/src/App.tsx
import ownershipMatcherPlugin from '@stepstone-tech/backstage-plugin-ownership-matcher/alpha';

const app = createApp({
  features: [ownershipMatcherPlugin],
});
```

## Extensions

| Extension                               | Path                      | Description                                                                  |
| --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `page:ownership-matcher/user-proposals` | `/my-ownership-proposals` | Main "Ownership" page with tabs (below)                                      |
| `page:ownership-matcher`                | `/ownership-matcher`      | Entity details at `/entities/:entityId`; the root redirects to the Admin tab |
| `api:ownership-matcher`                 |                           | Client for the backend API                                                   |

Tabs on `/my-ownership-proposals`, shown only when relevant to the signed-in user:

- **Pending** and **History**: proposals for the user's teams.
- **My Teams** and **Escalations**: for leaders (matched by escalation title patterns) and escalation actors.
- **Admin**: dashboard, entities, unresolved cases and scans. Requires `ownershipMatcherAdminPermission`.

## Components

```tsx
import {
  OwnershipProposalBanner,
  PendingProposalsBanner,
} from '@stepstone-tech/backstage-plugin-ownership-matcher';
```

- `OwnershipProposalBanner`: for the entity page (needs entity context). Shown when one of the user's teams has a pending proposal for the entity; links to `/my-ownership-proposals`.
- `PendingProposalsBanner`: an auto-hiding toast telling the user how many proposals wait for their teams. Refreshes every 5 minutes and on notifications; dismissal lasts for the browser session.

## Permissions

`ownershipMatcherAdminPermission` (`ownership-matcher.admin`) shows the Admin tab and enables admin actions. The backend enforces the same permission.

## Configuration

```yaml
ownershipMatcher:
  catalog:
    teamGroupTypes: [team] # Group spec.type values treated as teams (default [team])
```

Use the same value as the backend.
