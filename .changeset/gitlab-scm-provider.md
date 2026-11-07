---
'@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-gitlab': minor
---

Added the GitLab SCM provider module. It serves `integrations.gitlab` hosts (gitlab.com and self-managed, including nested groups) with commit history for the `top-contributor` strategy and merge requests for catalog-info owner changes. Merge-request calls need `ownershipMatcher.scm.hosts[].writeToken` and never fall back to the integration token.
