# @stepstone-tech/backstage-plugin-ownership-matcher-node

Node library for building ownership-matcher backend modules. It contains:

- **Extension points**: `ownershipChecksExtensionPoint`, `ownershipProposalStrategiesExtensionPoint`, `ownershipMatcherScmExtensionPoint`, `ownershipMatcherNotifierExtensionPoint`, with the `OwnershipCheck`, `ProposalStrategy`, `ScmProvider` and `OwnershipEmailSender` contracts.
- **SCM**: `ScmProvider`/`ScmClient` types, `ScmError` and its kinds, `createRestrictedFetch`, `readScmHostConfigs`.
- **Catalog**: `CatalogService`, `DefaultActorResolver` (finds escalation actors by job title or manager chain), type filters.
- **Config**: `readEscalationConfig`, `readCatalogConventions`.
- **Utils**: `assertSafeUrl`, `normalizeGroupRef`, regex helpers.

Test utilities are exported from `./testUtils`, including `describeScmProviderConformance` for SCM providers.

See [Extending](../ownership-matcher-backend/docs/extending.md) in the backend docs for examples.
