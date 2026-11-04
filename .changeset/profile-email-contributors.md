---
'@stepstone-tech/backstage-plugin-ownership-matcher-backend': minor
'@stepstone-tech/backstage-plugin-ownership-matcher-node': minor
---

Commit authors are now first matched to catalog users by their full commit email against `spec.profile.email` (case-insensitive). The existing matching on the email local part (user name, then the `userAlias` annotation) remains as the fallback. `CatalogService.getUserData` now also returns `spec.profile.email`.
