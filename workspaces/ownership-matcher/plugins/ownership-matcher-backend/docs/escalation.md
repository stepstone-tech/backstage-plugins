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

Job titles are read from `metadata.userDetails.jobTitle` or `spec.profile.title`. Targets without a matching actor are skipped. If the queue is empty, the case becomes `unresolved`.

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
