# Proposal scoring

When an entity fails a check, the configured strategies find candidate owner teams and score them. Configuration: [`proposals`](configuration.md#proposals).

## Strategies

| Strategy          | Candidates                                                                                   | Score                             |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------------------- |
| `top-contributor` | Teams of the authors of the last `commitsLimit` commits (needs an SCM provider with history) | Team's commits ÷ analysed commits |
| `org-proximity`   | Owner of the entity's `spec.system`                                                          | 0.6                               |
| `fallback`        | `escalated`: none. `fixed-owner`: the configured `owner`                                     | 0                                 |
| custom            | Strategies added by modules through `ownershipProposalStrategiesExtensionPoint`              | Set by the strategy               |

Commit authors are matched to users, then to their teams. A user matches if, in this order, their `spec.profile.email` equals the full commit email (case-insensitive), their name matches the email local part (ignoring any `_` suffix), or their `userAlias` annotation equals the local part. Only users with `spec.memberOf` are considered. Teams that already rejected the entity are skipped. Authors in `contributors` are ignored.

## Combining scores

1. Each strategy score is multiplied by the strategy `weight` and summed per team.
2. The sum is divided by the total weight of all non-fallback strategies (capped at 1).
3. Only groups whose `spec.type` is in `catalog.teamGroupTypes` are kept.
4. Candidates below `minimumScoreThreshold` are dropped, except the top one. At most `maxCandidatesPerEntity` are kept.
5. Candidates at or above `notificationThreshold` become `pending` proposals and their teams are notified. The others are stored as `possible_owner`: visible in the UI and claimable, but never notified. `possible_owner` entries are regenerated on every scan.

## Example

Default weights (top-contributor 0.5, org-proximity 0.3, total 0.8) and threshold 0.4:

| Team   | Commit share | System owner | Combined                         | Result           |
| ------ | ------------ | ------------ | -------------------------------- | ---------------- |
| team-a | 0.6          | yes          | (0.6×0.5 + 0.6×0.3) / 0.8 = 0.60 | `pending`        |
| team-b | 0.4          | no           | (0.4×0.5) / 0.8 = 0.25           | `possible_owner` |
| team-c | 0            | yes          | (0.6×0.3) / 0.8 = 0.225          | `possible_owner` |

Things to know with the defaults:

- A team that only owns the parent system (0.225) is never notified. Raise the `org-proximity` weight or lower `notificationThreshold` if you want it to be.
- A `fixed-owner` fallback scores 0, so it is stored as `possible_owner` and never notified.

## When nothing is found

- No candidates at all (none found, or none that survive filtering) → the case becomes `unresolved`.
- Only `possible_owner` candidates (all below `notificationThreshold`) → the case becomes `unresolved` (history reason `only_possible_owners`); nobody is notified and teams can still claim the entity from the UI. It reopens only when a later scan produces a notified proposal.
- All notified proposals rejected or expired → the case is [escalated](escalation.md) (or becomes `unresolved` when escalation is disabled).
- A strategy failed (for example, the SCM was unavailable) → the result is treated as unknown and nothing changes; the next scan tries again.
