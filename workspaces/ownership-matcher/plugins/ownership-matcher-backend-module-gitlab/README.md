# @stepstone-tech/backstage-plugin-ownership-matcher-backend-module-gitlab

GitLab (gitlab.com and self-managed) SCM provider for the ownership-matcher backend. It serves `integrations.gitlab` hosts and provides:

- commit history for the `top-contributor` proposal strategy,
- branch, commit and merge request calls for the catalog-info `spec.owner` change.

## Installation

```ts
// packages/backend/src/index.ts
backend.add(
  import('@stepstone-tech/backstage-plugin-ownership-matcher-backend'),
);
backend.add(
  import(
    '@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-gitlab'
  ),
);
```

## Configuration

```yaml
integrations:
  gitlab:
    - host: gitlab.com
      token: ${GITLAB_TOKEN}
    # Self-managed, optionally served under a relative path:
    - host: gitlab.example.com
      apiBaseUrl: https://gitlab.example.com/gitlab/api/v4
      baseUrl: https://gitlab.example.com/gitlab
      token: ${GITLAB_EXAMPLE_TOKEN}

ownershipMatcher:
  scm:
    hosts:
      # Required for the merge request flow. May reuse the integration's
      # secret (writeToken: ${GITLAB_TOKEN}) if that token has the `api` scope.
      - host: gitlab.com
        writeToken: ${GITLAB_WRITE_TOKEN}
```

| Token                                     | Used for                                     | Scope      |
| ----------------------------------------- | -------------------------------------------- | ---------- |
| `integrations.gitlab[].token`             | Commit history                               | `read_api` |
| `ownershipMatcher.scm.hosts[].writeToken` | The whole merge request flow, reads included | `api`      |

The `writeToken`'s user needs at least the Developer role on the projects and must be allowed to push to new branches. The merge request flow never falls back to the integration token: without a `writeToken`, a warning is logged at startup and merge request jobs fail with `auth`, so writes are always an explicit opt-in. Without an integration token, commit history is read anonymously (public projects only). Requests time out after 30 seconds.

## Behaviour

- **Locations**: `managed-by-location` URLs of the form `<baseUrl>/<group>[/<subgroup>...]/<project>/-/blob/<ref>/<path>`. `<ref>` is used as the merge request's target branch.
- **Commit history**: the newest commits on the default branch (`GET /projects/:id/repository/commits`). `per_page` follows the strategy's `commitsLimit` (capped at 100, paging through larger limits). Each commit's `author_email` is matched to catalog users by the core plugin.
- **File edits**: one commit via the Files API, guarded by the file's `last_commit_id`. A concurrent change yields a `conflict`, and the core plugin re-reads the file and retries.
- **Merge requests**: one open merge request per source branch. A duplicate is reused, and merge requests from forks are ignored. States map as `opened`/`locked` → `open`, `merged` → `merged`, `closed` → `declined`.
- **Reviewers**: GitLab user ids. The acceptor is found by searching users by email. The default reviewers are the active eligible approvers of the project's approval rules (excluding `any_approver`, `report_approver` and `code_owner` rules) that apply to the target branch.

## Error mapping

Checked in this order:

| GitLab response                                                 | `ScmError` kind                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| 400/409 "changed since you started editing" or "already exists" | `conflict` (`createBranch` returns `exists`)                     |
| Archived, read-only or maintenance mode (non-404)               | `read-only`                                                      |
| 401, 403                                                        | `auth`                                                           |
| 404                                                             | `not-found` (`readFile` and `getPullRequest` return `undefined`) |
| 409                                                             | `conflict` (`createPullRequest` returns `reused`)                |
| 429                                                             | `rate-limited`                                                   |
| 400, 422                                                        | `invalid`                                                        |
| 5xx, network errors, timeouts                                   | `unavailable`                                                    |
| Anything else                                                   | `unknown`                                                        |

A reviewer that isn't a numeric GitLab user id is rejected as `invalid`, with the reviewer named, so the core plugin retries without it.

## Limitations

- **Branch names with `/` in locations**: in a blob URL, only the first segment after `/-/blob/` is taken as the branch, so `-/blob/feature/x/catalog-info.yaml` reads as branch `feature` (same as Backstage's own GitLab URL parsing). Register catalog files from branches without `/`.
- **Commit SHAs in locations**: a location pinned to a full commit SHA is treated as the default branch.
- **Finding reviewers by email**: on gitlab.com, a non-admin token only finds users by their **public** email, and the search response carries no email to compare. A single search hit is then accepted, unless its name or username contains the email (GitLab's search also matches those). If the acceptor can't be found, the merge request is opened without them as a reviewer.
- **Approval rules** are a Premium feature. On Free tier projects (403/404) there are no default reviewers. GitLab still enforces any approval rules on the merge request itself. Group-based rules can make the reviewer list long.
- **Archived projects**: GitLab may reject writes to an archived project with a plain 403, which maps to `auth`.
