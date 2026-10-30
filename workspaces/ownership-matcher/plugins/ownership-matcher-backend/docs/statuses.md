# Statuses

Every entity that fails a check gets an ownership case. The case, its proposals and its catalog-info PR each have a status. All changes are recorded in the case history, shown as a timeline in the UI.

## Case

| Status       | Meaning                                                                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`       | Failing check; notified proposals are pending                                                                                                                    |
| `escalated`  | Waiting for an [escalation](escalation.md) actor                                                                                                                 |
| `accepted`   | An owner team was chosen; waiting for `spec.owner` to change in the catalog                                                                                      |
| `to_archive` | An escalation actor decided the entity should be archived                                                                                                        |
| `unresolved` | No notified candidates (none at all, or only `possible_owner` ones) or no escalation path; needs an admin, a fallback actor, or a team claiming a possible owner |
| `closed`     | Resolved, with a resolution type (below)                                                                                                                         |

```
open ──accept──────────────────────────────► accepted ──owner updated──► closed
  │                                              ▲
  └─all rejected/expired──► escalated ──assign───┘
                               │  └──archive──► to_archive ──entity removed──► closed
                               └──queue exhausted──► unresolved
```

Transitions:

- **open → accepted**: a team accepts a `pending` or `possible_owner` proposal. Other proposals are cancelled and a [catalog-info PR](catalog-info-prs.md) is queued.
- **open → escalated / unresolved**: see [when nothing is found](proposal-scoring.md#when-nothing-is-found).
- **escalated → accepted / to_archive**: an escalation actor assigns an owner or marks the entity for archiving.
- **escalated → unresolved**: no escalation actor is left.
- **unresolved → accepted**: a team claims a `possible_owner` proposal, or an admin assigns an owner.
- **accepted / to_archive → open / escalated**: the grace period ends without the catalog being updated (see [grace periods](escalation.md#grace-periods)).
- **unresolved → open**: a later scan produces a notified (`pending`) proposal, or a fallback actor retriggers the case. Finding only `possible_owner` candidates keeps the case `unresolved`.
- **any → closed**: on the next scan.

Resolution types of `closed` cases:

| Resolution          | When                                                         |
| ------------------- | ------------------------------------------------------------ |
| `ownership_changed` | The entity passes all checks (except for `to_archive` cases) |
| `archived`          | The entity was removed from the catalog                      |
| `out_of_scope`      | The entity is now excluded by `filters`                      |

## Proposal

| Status           | Meaning                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `pending`        | Above `notificationThreshold`; the team was notified and can accept or reject                             |
| `possible_owner` | Below the threshold; shown in the UI and claimable, never notified                                        |
| `accepted`       | The team took ownership                                                                                   |
| `rejected`       | The team declined, with a reason                                                                          |
| `expired`        | Not answered within `expirationDays` (only with `autoExpiry`), or the grace period ended after acceptance |
| `cancelled`      | Another proposal was accepted, or the case was regenerated or closed                                      |

## Catalog-info PR

`none`, `pending`, `raised`, `failed`, `unsupported_scm`, `declined`, `superseded`, `completed`. See [Catalog-info PRs](catalog-info-prs.md).
