# @stepstone-tech/backstage-plugin-ownership-matcher-backend-module-msgraph-email

Microsoft Graph email sender for the ownership-matcher email digest. The backend plugin builds the digest and schedule; this module delivers it through `POST /users/{userPrincipalName}/sendMail`.

## Installation

```ts
// packages/backend/src/index.ts
backend.add(
  import('@stepstone-tech/backstage-plugin-ownership-matcher-backend'),
);
backend.add(
  import(
    '@stepstone-tech/backstage-plugin-ownership-matcher-backend-module-msgraph-email'
  ),
);
```

## Configuration

```yaml
ownershipMatcher:
  email:
    schedule: # digest settings, read by the backend plugin
      frequency: { months: 1 }
      timeout: { minutes: 30 }
    msgraph: # read by this module
      tenantId: ${MICROSOFT_GRAPH_TENANT_ID}
      clientId: ${MICROSOFT_GRAPH_CLIENT_ID}
      clientSecret: ${MICROSOFT_GRAPH_CLIENT_SECRET}
      userPrincipalName: noreply@example.com
```

The app registration needs the `Mail.Send` application permission with admin consent, ideally restricted to the sender mailbox with an application access policy.

- Without `ownershipMatcher.email.msgraph`, the module logs an info message and registers nothing.
- With `ownershipMatcher.email.dryRun: true`, emails are written to the temp directory and this sender is not used.
- Delivery failures are logged and the team is retried on the next digest run.
- Only one email sender module can be installed.
