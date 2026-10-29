# Catalog-info PRs

When a case is accepted, the plugin opens a pull request that sets `spec.owner` to the accepted team in the entity's `catalog-info.yaml`. The file is found through the `backstage.io/managed-by-location` annotation. Configuration: [`prCreation`](configuration.md#prcreation) and [`scm`](configuration.md#scm).

This needs an SCM provider module with pull request support for the host (e.g. [Bitbucket Server](../../ownership-matcher-backend-module-bitbucket-server/README.md)) and a `writeToken` for it.

## PR job

PR jobs run in the `ownership-matcher-deadline-checker` task, every 15 minutes.

| Outcome                                       | `pr_status`       | Next step                                     |
| --------------------------------------------- | ----------------- | --------------------------------------------- |
| PR opened (or an existing open PR reused)     | `raised`          | Reconciled (below)                            |
| No provider, or provider without PR support   | `unsupported_scm` | Manual retry once a provider is installed     |
| `read-only` repository                        | `failed`          | Retried after 24 hours                        |
| `auth`, `not-found`, `invalid` error          | `failed`          | Manual retry only                             |
| Other errors                                  | `failed`          | Retried with backoff (5 min, 30 min, 2 h, 6 h) up to `maxAttempts` |

A commit `conflict` (the file changed meanwhile) is re-read and committed once more in the same run.

## Reconciliation

Every 15 minutes (at most hourly per case), the plugin compares the catalog with the PR:

| Catalog owner / PR state                                         | `pr_status`  |
| ---------------------------------------------------------------- | ------------ |
| Catalog owner is the accepted team                               | `completed`  |
| The case was closed with another valid owner                     | `superseded` |
| PR declined or not found                                         | `declined`   |
| PR merged more than `mergeGraceHours` ago, catalog not updated   | `failed`     |
| PR open                                                          | `raised`     |

`failed`, `declined` and `unsupported_scm` cases are also compared with the catalog, so a team that fixed the owner by hand still reaches `completed`. Reading the PR state needs the SCM; the catalog comparison does not.

Teams can retry `failed`, `declined` and `unsupported_scm` PRs from the entity page (`POST /entities/:id/pr/retry`).
