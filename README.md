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
yarn install   # once, from here
yarn tsc       # type check
yarn lint      # lint all packages
yarn test      # unit tests
yarn build     # type check and build every package
```

All workspaces share one Yarn project at the repository root — one `package.json` and one `yarn.lock` — but each workspace is its own entry point for running the app. To run one locally, go into it:

```sh
cd workspaces/ownership-matcher
yarn start
```

## Repository structure

```
.changeset/            changesets for versioning
workspaces/<name>/
  package.json         workspace entry point, nests packages/* and plugins/*
  packages/app         dev frontend, private, never published
  packages/backend     dev backend, private, never published
  plugins/*            one directory per published package
  scripts/start.js     `yarn start` — database, then the two dev packages
  app-config.yaml      configuration for local development
  docker-compose.yml   services for local development
  examples/            sample catalog data
  README.md            packages, local development and tests
```

## Adding a plugin

Run `yarn new`, pick a template, and move the generated package into `workspaces/<name>/plugins/`. Run `yarn backstage-cli repo fix --publish` to add the metadata needed for publishing. A new workspace needs its own `package.json` nesting `packages/*` and `plugins/*`, plus a `packages/app` and `packages/backend` to run it — the root glob only reaches `workspaces/*`.
