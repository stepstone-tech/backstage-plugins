# Notifications

## Backstage notifications

Sent through the [notifications plugin](https://backstage.io/docs/notifications/) with origin `plugin:ownership-matcher`. Group recipients reach all members. Turned off with `notifications.enabled: false`.

| Topic (`ownership-matcher.` prefix) | Recipient          | When                                                                                     |
| ----------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `proposals.batch-ready`             | Proposed team      | After a scan creates new `pending` proposals; one notification per team                  |
| `proposal.reminder-due`             | Proposed team      | A proposal is still pending `reminderAfterDays` after the last notification (needs `remindersEnabled`) |
| `proposal.expired`                  | Proposed team      | A proposal expired (`autoExpiry`, or an unanswered escalation suggestion)                |
| `acceptance.pending`                | Accepted team      | The case is accepted but `spec.owner` isn't updated yet; at most every `acceptancePendingReminderDays`, with a link to the PR if one is open |
| `grace.warning`                     | Responsible team   | `warningDays` before a [grace period](escalation.md#grace-periods) ends                  |
| `archive.pending`                   | Chosen team        | An escalation actor marked the entity for archiving                                      |
| `escalation.assigned`               | Escalation actor   | A case is assigned to them                                                               |

The `-common` package exports the origin and topic display names for use in the notifications UI.

## Email digest

An optional periodic email to each team with pending proposals, summarising them by check and entity kind and linking to the Ownership page. Enabled by the [`email`](configuration.md#email) block.

- Runs as the `ownership-matcher-email-digest` task, monthly by default.
- Sent to the team's `spec.profile.email`; teams without one are skipped.
- Each team gets at most one email per period (a calendar month, or an ISO week when the schedule uses `days` or `hours`).
- Teams whose delivery failed are retried on the next run.
- Admins can run it on demand with `POST /email-digest/trigger`.

Delivery needs an email sender module, such as the [Microsoft Graph module](../../ownership-matcher-backend-module-msgraph-email/README.md), or `dryRun: true`, which writes the emails to the temp directory. Without either, the digest is not scheduled.

| `email` block | Sender module | Result                                     |
| ------------- | ------------- | ------------------------------------------ |
| absent        | any           | Digest disabled                            |
| `dryRun: true` | any          | Emails written to the temp directory       |
| present       | installed     | Emails sent through the module             |
| present       | none          | Digest not scheduled (logged at startup)   |
