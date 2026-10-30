# Escalation

When every notified team rejected a case or let it expire, the case is escalated up the group hierarchy until someone decides. Escalation is off unless [`escalation`](configuration.md#escalation) is configured; without it, such cases become `unresolved`.

## Queue

When a case is escalated, the plugin builds a queue of escalation targets:

1. For each proposed team, walk up the catalog group hierarchy (`childOf` relations).
2. For each configured level, take the first ancestor that matches the level's `groupFilter`.
3. Order the targets by level, then by the best proposal score of the teams below them.

For each target group, the **actor** is resolved:

- `managerChain: false`: the first member of the group whose job title matches `titlePatterns`.
- `managerChain: true`: for each team member, the nearest manager whose job title matches. Requires the `catalog.annotations.userAlias` and `manager` annotations.

Both paths depend on job titles being present on User entities — see [Job titles](#job-titles). Targets without a matching actor are skipped. If the queue is empty, the case becomes `unresolved`.

## Job titles

`titlePatterns` is the only actor matcher the plugin implements, so escalation does nothing without job titles in the catalog: no target resolves an actor, the queue stays empty, and every escalated case becomes `unresolved`. Nothing logs an error — check this first if escalation looks inert.

Titles are read from `metadata.userDetails.jobTitle` on the User entity, for both `managerChain: false` (the group's own members) and `managerChain: true` (each member's managers).

This is not a field Backstage populates. `spec.profile` carries only `displayName`, `email` and `picture`, and the MS Graph, GitHub, GitLab, LDAP, Keycloak and Okta providers all drop the job title their source returns. Your catalog ingestion has to write it.

Check what your catalog actually holds before configuring `escalation`:

```sh
curl -sH "Authorization: Bearer $TOKEN" \
  "$BACKSTAGE_URL/api/catalog/entities/by-name/user/default/<name>" \
  | jq '.metadata.userDetails'
```

With `managerChain: true`, `GET /escalation/manager-chain?ref=<groupRef>` (admin) returns each member's chain with the title resolved per hop — use it to confirm titles reach the managers, not just the team members.

### Populating it: MS Graph example

Microsoft Graph returns `jobTitle` on the user object, so a `userTransformer` that delegates to the default transformer and adds the field is enough. Register it as a catalog backend module:

```ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  defaultUserTransformer,
  microsoftGraphOrgEntityProviderTransformExtensionPoint,
} from '@backstage/plugin-catalog-backend-module-msgraph';

export const catalogModuleMsgraphJobTitle = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'msgraph-job-title',
  register(env) {
    env.registerInit({
      deps: {
        transformers: microsoftGraphOrgEntityProviderTransformExtensionPoint,
      },
      async init({ transformers }) {
        transformers.setUserTransformer(async (user, userPhoto) => {
          const entity = await defaultUserTransformer(user, userPhoto);
          if (!entity || !user.jobTitle) return entity;
          return {
            ...entity,
            metadata: {
              ...entity.metadata,
              userDetails: { jobTitle: user.jobTitle },
            },
          };
        });
      },
    });
  },
});
```

```ts
// packages/backend/src/index.ts
backend.add(import('@backstage/plugin-catalog-backend-module-msgraph'));
backend.add(catalogModuleMsgraphJobTitle);
```

If the provider config narrows the Graph query with `user.select`, add `jobTitle` — otherwise the field never reaches the transformer:

```yaml
catalog:
  providers:
    microsoftGraphOrg:
      default:
        user:
          select: [id, displayName, mail, userPrincipalName, jobTitle]
```

Levels with `managerChain: true` additionally need the `catalog.annotations.userAlias` and `catalog.annotations.manager` annotations, which the same transformer can write from `user.userPrincipalName` and the Graph `manager` relationship.

Other providers follow the same shape: GitLab exposes `job_title` on its user API, LDAP can map `title` through a custom transformer. GitHub has no job-title field — a separate ingestion or a catalog processor is needed there.

## Actor decisions

The active actor is notified and the case shows up in their **Escalations** tab. They have `timeoutDays` to act:

| Action  | Result                                                                            |
| ------- | --------------------------------------------------------------------------------- |
| Assign  | The chosen team becomes the owner → `accepted`, catalog-info PR queued            |
| Archive | → `to_archive`; the chosen team is notified to remove the entity from the catalog |

If the timeout passes, the next actor takes over. When the queue is exhausted, the case becomes `unresolved`. `timeoutDays` is required on every level, so the timeout can't be turned off.

The backend also exposes two API-only actions that the UI doesn't offer:

- `POST /entities/:id/escalation/reject`: the next actor takes over. Unlike the timeout, rejecting the last actor leaves the case `escalated`.
- `POST /entities/:id/escalation/suggest`: creates a `pending` proposal for the suggested team, which has `gracePeriodDays` to accept. The actor's timeout is paused; if the suggestion expires, the next actor takes over.

## Grace periods

After an assignment (by a team or an actor) or an archive decision, the catalog must reflect the change within `gracePeriodDays`. A warning is sent `warningDays` before the end. If the grace period ends first:

- Team acceptance: the case reopens (`open`) and the accepted proposal expires.
- `to_archive`: the case returns to `escalated` for a new decision.
- Actor assignment: the next actor takes over; if none is left, a `reDecisionDays` window opens before the queue is exhausted.

## Unresolved cases

`unresolved` cases are listed in the Admin tab. They are handled by:

- **Admins**: assign an owner or archive, like an escalation actor.
- **Fallback actors** (`fallbackActors`, users or groups): retrigger. The entity is rescanned; if the check now passes, the case is closed; otherwise proposals are regenerated, or the escalation queue is rebuilt if none are found.
- **Scans**: a later scan that finds candidates reopens the case.

Fallback actors are not notified automatically.
