# Core integration contract and security gates

## Auth

`Auth.issue()` is a trusted internal primitive (bootstrap and administrator-controlled provisioning), not a public token endpoint. Public token issuance must call:

```ts
return auth.issueFor(credential, workspaceId, requestedPermissions);
```

This reads the issuer's durable permissions, enforces workspace ownership for non-administrator global credentials, rejects escalation, and caps the child expiry at the issuer expiry. Never authorize against a mutable `principal.permissions` array. `authorize()` already reads the durable credential and rejects deleted/deleting workspaces. Explicitly workspace-scoped tokens delegate access to that workspace; global non-administrator credentials require ownership. Wildcard administrator credentials may cross ownership boundaries.

`defineRole`, `createUser`, `setUserRole`, and `issue` are trusted administrative APIs: enforce `workspace:manage` and administrator policy at HTTP callers. `setUserRole` revokes all credentials for the affected user. Role permission sets are copied when assigned; redefine then reassign affected users if changing an existing role. Bootstrap is atomic and may run only once. Browser mutations must separately check `auth.csrf()` for cookie sessions; bearer authentication alone does not grant extra rights.

## Lifecycle admission and inactivity

At startup, **await `lifecycle.reconcile()` before listening**, then call `lifecycle.monitor()`. A fresh lifecycle instance denies operation admission until reconciliation completes. Reconciliation blocks concurrent lifecycle operations and request admission. A durable interrupted-operation lock is not TTL-stolen: deployment stop must finish before its lock is removed. The deployment must fail if it cannot prove Chrome exited. There must be only one host supervisor.

All real workspace work must hold `beginOperation()` until actual completion:

```ts
const end = lifecycle.beginOperation(workspaceId, async () => {
  abortController.abort();
  await actualOperationDone;
});
try {
  return await operation();
} finally {
  end();
}
```

- Track **every MCP call**, including read-only calls, not merely HTTP session lifetime.
- A command's operation ends when its process group exits, not when the start endpoint responds.
- A download ends after its response has finished/closed; an upload after commit/abort.
- Do not hold an operation for an idle MCP or event stream.
- Call `assertReady()` from mutation/security hooks as well as request admission. This denies actions immediately during stopping/recovery/deletion.
- `beginOperation()` admission is synchronous, closing the check/stop race. Completion updates last activity, giving a full inactivity interval after real work ends.

The server's existing `busy: active-count || task-keepalive` callback **does not include human leases or MCP requests**. Wire either the lease-manager getter below or acquisition/renewal/release events. Core does not infer lease validity from audit text.

```ts
const lifecycle = new Lifecycle(store, deployment, {
  // Getter must exclude expired/revoked credentials and pending/invalid leases.
  humanLease: workspaceId => currentValidatedHumanLease(workspaceId),
  busy: workspaceId => otherQualifyingActivity(workspaceId),
  quiesce: async workspaceId => {
    // Reject mutation, disable viewer input, revoke leases, cancel process groups.
    await stopWorkspaceOperations(workspaceId);
  },
});
```

Alternatively call `holdActivity(workspaceId, 'human:' + lease.id, lease.expiresAt)` on grant/renew, then `releaseActivity` on release/revocation. Use distinct keys for viewer/task keepalives. Holds expire automatically; bare open connections do not hold the workspace alive. Ensure credential revocation releases corresponding holds, or use the validated getter. `isBusy()` includes tracked requests, unexpired holds, human leases, and the injected callback, rechecking internal counts after the asynchronous callback resolves.

Explicit stop/restart/delete closes admission via lifecycle state and boundedly drains/cancels tracked operations (default 10 seconds). A request that cannot drain causes failure **without stopping the runtime underneath it**. Cancellation callbacks must settle only after the underlying operation actually terminates. Idle shutdown is skipped while a human lease or real request is active. Recovery also drains before runtime replacement.

## Real deployment readiness

Default `OciDeployment` uses **`scripts/workspace.sh`**, delegating start/stop/delete to the runtime agent's deployment script. OCI inspection verifies browser/utility/egress running, browser health, and no published raw ports. Then readiness requires one of:

1. An injected fourth constructor argument `controlHealth(workspace): Promise<boolean>`, doing real probes; or
2. Administrator environment variable **`BROWSERUSE_CONTROL_HEALTHCHECK`**, an executable invoked by `scripts/workspace.sh health <workspace-id>`.

Without either, health is false. Do not change this to `async () => true` just to start a workspace.

The trusted checker must prove the following for that workspace, not merely return a configured flag:

- Private CDP resolves to the assigned browser and `/json/version` responds.
- The pinned official stdio MCP subprocess connects and lists the supported tool manifest.
- The server-side RFB parser/input gate is available and denies unauthorized input.
- Utility inspection/isolation attestation succeeds and command identity is non-root.
- Protected audit storage accepts a durable write; approved file storage is writable.
- Egress policy installation and private networks match the runtime's policy.

The default server currently supplies no explicit checker; configure the trusted executable or inject a real checker during integration. That deliberate unready state is not a successful release test. An absent control sidecar, inaccessible MCP executable, unavailable input gate, or missing utility-isolation manifest must remain unready.

The runtime agent owns shell scripts, namespace firewall setup, volume provisioning, and shutdown confirmation. Core does not weaken these policies or publish a CDP/VNC/command fallback.

## Verification scope

`tests/core.test.ts` uses SQLite and injected deployment runners. It proves core persistence/authentication/state-machine behavior, not real container sandboxing, MCP interoperability, viewer input security, network enforcement, or reboot persistence. Those require the runtime acceptance environment.
