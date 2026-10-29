# Contributing

Thanks for contributing. See the [README](README.md) for the repository layout and how to build, test and run the plugins locally.

## Pull requests

1. Branch off `master` and keep the branch focused on one change.
2. Before pushing, run `yarn tsc`, `yarn lint`, `yarn test` and `yarn prettier:check`. CI runs the same checks on every branch.
3. Add a changeset if you changed a published package (see below).
4. Open a pull request to `master`.

## Changesets

Package versions and `CHANGELOG.md` files are managed with [changesets](https://github.com/changesets/changesets). A changeset is a small Markdown file in `.changeset/` that names the packages a PR changes, the semver bump for each of them and a summary that ends up in their changelogs.

To add one, run:

```sh
yarn changeset
```

Select the packages you changed, pick the bump type for each and write a summary for the people who use the package, then commit the generated file with the rest of the PR:

- **patch:** bug fixes and internal changes that don't affect the API
- **minor:** new features and other backwards compatible changes
- **major:** breaking changes, such as a removed export, a changed config key or a database migration that can't be rolled back. Describe what users have to change.

You can edit the file afterwards and add more than one changeset to a PR, for example to describe changes to different packages separately.
