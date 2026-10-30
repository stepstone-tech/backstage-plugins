---
'@stepstone-tech/backstage-plugin-ownership-matcher-backend': patch
---

Fixed an identity-spoofing hole in the `?asUser=` override on `/leadership/*`. Any authenticated user could pass another person's entity ref and read their managed group subtree, bypassing the admin permission gate those routes rely on. The override was enabled whenever `NODE_ENV` was anything other than `production` — including unset, which is what Node defaults to — so a deployment that never sets the variable shipped it live.

It is now off unless you explicitly set `ownershipMatcher.dangerouslyAllowAsUserOverride: true`. `NODE_ENV` is no longer consulted at all. The backend logs a warning at startup whenever the override is enabled.

If you used `?asUser=` for local development, add the flag to a gitignored `app-config.local.yaml`. Never set it in a deployed configuration.
