---
'@stepstone-tech/backstage-plugin-ownership-matcher-backend': minor
'@stepstone-tech/backstage-plugin-ownership-matcher-node': minor
---

Security dependency bump.

`@backstage/backend-defaults` moves to `devDependencies` on the backend
package — it is imported only by the local dev harness, not by shipped
source, so it no longer lands in a consumer's runtime closure.

`zod` moves to `^4.6.6` in both packages, bumped together so consumers get
a single copy. Public API unchanged.

Remaining updates were already permitted by existing version ranges and
are resolved by a lockfile refresh.
