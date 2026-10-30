# @stepstone-tech/backstage-plugin-ownership-matcher-backend-module-bitbucket-server

Bitbucket Server (Data Center) SCM provider for the ownership-matcher backend. It serves `integrations.bitbucketServer` hosts and provides:

- commit history for the `top-contributor` proposal strategy,
- branch, commit and pull request calls for the catalog-info `spec.owner` PR.

## Installation

```ts
// packages/backend/src/index.ts
backend.add(
  import('@stepstone-tech/backstage-plugin-ownership-matcher-backend'),
);
backend.add(
  import(
    '@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-bitbucket-server'
  ),
);
```

## Configuration

```yaml
integrations:
  bitbucketServer:
    - host: bitbucket.example.com
      apiBaseUrl: https://bitbucket.example.com/rest/api/1.0
      token: ${BITBUCKET_TOKEN} # commit history

ownershipMatcher:
  scm:
    hosts:
      - host: bitbucket.example.com
        writeToken: ${BITBUCKET_WRITE_TOKEN} # all PR-flow calls
```

Without `writeToken`, a warning is logged at startup and PR jobs fail with `auth`. Requests time out after 30 seconds.

## Error mapping

Checked in this order:

| Bitbucket response                         | `ScmError` kind                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Invalid reviewers                          | `invalid` (with the rejected reviewers)                                            |
| Archived or read-only repository (non-404) | `read-only`                                                                        |
| 401, 403                                   | `auth`                                                                             |
| 404                                        | `not-found` (`readFile` returns `undefined`)                                       |
| 409                                        | `conflict` (`createBranch` returns `exists`, `createPullRequest` returns `reused`) |
| 429                                        | `rate-limited`                                                                     |
| 400                                        | `invalid`                                                                          |
| 5xx, network errors, timeouts              | `unavailable`                                                                      |
| Anything else                              | `unknown`                                                                          |
