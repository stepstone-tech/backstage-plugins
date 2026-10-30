# Backstage plugins

Plugins for [Backstage](https://backstage.io). Installation and configuration are described in each plugin's README.

## Workspaces

Plugins are grouped into workspaces under `workspaces/<name>/`, one per plugin family, like [backstage/community-plugins](https://github.com/backstage/community-plugins).

| Workspace                                                   | Description                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [ownership-matcher](workspaces/ownership-matcher/README.md) | Finds catalog entities without a valid owner, proposes owners and escalates until one is assigned |

## Getting started

Requirements: Node.js 22 or 24, Yarn 4 (bundled in `.yarn/releases`), and Docker for local development.

```sh
yarn install
yarn tsc          # type check
yarn lint         # lint all packages
yarn test         # unit tests
yarn build        # type check and build every package
yarn start <name> # run workspaces/<name> locally, see its README
```

All workspaces share one Yarn project at the repository root (one `package.json` and `yarn.lock`).

## Repository structure

```
.changeset/            changesets for versioning
workspaces/<name>/
  plugins/*            one directory per package
  app-config.yaml      configuration for local development
  docker-compose.yml   services for local development
  examples/            sample catalog data
  README.md            packages, local development and tests
```

## Adding a plugin

Run `yarn new`, pick a template, and move the generated package into `workspaces/<name>/plugins/`. Run `yarn backstage-cli repo fix --publish` to add the metadata needed for publishing. `yarn start <name>` runs the `dev/` entry points of the plugins whose plugin ID matches the workspace name, so name the workspace after the plugin ID.
