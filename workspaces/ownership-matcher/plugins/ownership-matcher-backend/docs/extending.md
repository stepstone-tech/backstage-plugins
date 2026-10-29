# Extending

Backend modules extend ownership-matcher through extension points exported by [`@stepstone-tech/backstage-plugin-ownership-matcher-node`](../../ownership-matcher-node/README.md). Register them with `pluginId: 'ownership-matcher'`.

| Extension point                             | Method                   | Adds                                                         |
| ------------------------------------------- | ------------------------ | ------------------------------------------------------------ |
| `ownershipChecksExtensionPoint`             | `addCheck(check)`        | A check; list its `name` in `checks.enabled` to run it       |
| `ownershipProposalStrategiesExtensionPoint` | `addStrategy(strategy)`  | A proposal strategy; runs before `fallback`, weight from config or 1.0 |
| `ownershipMatcherScmExtensionPoint`         | `addProvider(provider)`  | An SCM provider, one per integration type                    |
| `ownershipMatcherNotifierExtensionPoint`    | `setEmailSender(sender)` | The email digest transport; only one allowed                 |

## SCM provider

The core has no SCM-specific code. For each entity it finds the `integrations.*` entry for the host of `backstage.io/managed-by-location` and uses the provider registered for that integration `type`. One client is created per host, and its `fetch` can only reach that integration's hosts.

```ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  ownershipMatcherScmExtensionPoint,
  type ScmProvider,
} from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

const gitlabProvider: ScmProvider = {
  type: 'gitlab', // the ScmIntegration type it serves
  createClient({ integration, hostConfig, logger, fetch }) {
    return {
      parseLocation(url) {
        // → { repo: { type, host, path, webUrl }, path, ref }
      },
      // Optional: commit history for the top-contributor strategy
      history: {
        async getCommits(repo, { limit }) {
          // use the provided `fetch`, not the global one
        },
      },
      // Optional: catalog-info PRs
      pullRequests: {
        // getDefaultBranch, readFile, createBranch, commitFile,
        // findOpenPullRequest, getPullRequest, createPullRequest,
        // updatePullRequest, resolveReviewer, getDefaultReviewers
      },
    };
  },
};

export default createBackendModule({
  pluginId: 'ownership-matcher',
  moduleId: 'gitlab',
  register(env) {
    env.registerInit({
      deps: { scm: ownershipMatcherScmExtensionPoint },
      async init({ scm }) {
        scm.addProvider(gitlabProvider);
      },
    });
  },
});
```

On failure, throw `ScmError` with one of the kinds `auth`, `not-found`, `conflict`, `read-only`, `rate-limited`, `unavailable`, `invalid` or `unknown`. See [Catalog-info PRs](catalog-info-prs.md#pr-job) for how each is handled. Leave out capabilities the SCM doesn't support; the plugin works without them.

Check a provider against the contract with the conformance suite:

```ts
import { describeScmProviderConformance } from '@stepstone-tech/backstage-plugin-ownership-matcher-node/testUtils';

describeScmProviderConformance(gitlabProvider, { fakeServer });
```

`fakeServer` provides the integration, a `fetch` serving a fake SCM, a sample location with its expected parse, and a hook that makes a file revision stale. The suite covers location parsing, host-restricted `fetch`, idempotent branch and PR creation, `conflict` on a stale revision and reading a PR back.

[Bitbucket Server](../../ownership-matcher-backend-module-bitbucket-server/README.md) is the reference implementation.

## Email sender

The core selects the teams and renders one HTML email per team; the sender only delivers it. `sendEmail` must not throw: return `{ success: false }` and the team is retried on the next run.

```ts
import { createBackendModule } from '@backstage/backend-plugin-api';
import { ownershipMatcherNotifierExtensionPoint } from '@stepstone-tech/backstage-plugin-ownership-matcher-node';

export default createBackendModule({
  pluginId: 'ownership-matcher',
  moduleId: 'my-email',
  register(env) {
    env.registerInit({
      deps: { notifier: ownershipMatcherNotifierExtensionPoint },
      async init({ notifier }) {
        notifier.setEmailSender({
          async sendEmail({ to, subject, content }) {
            // deliver the HTML `content`
            return { success: true };
          },
        });
      },
    });
  },
});
```

## Checks and strategies

A check implements `OwnershipCheck` (`name`, `title`, `description`, `run(ctx)`); a strategy implements `ProposalStrategy` (`name`, `signalDefinitions`, `findCandidates(ctx)`). If several checks fail, built-in checks take precedence over custom ones.
