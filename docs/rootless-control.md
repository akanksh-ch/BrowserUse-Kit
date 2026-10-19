# Rootless control namespace integration contract

This is an unwired helper, not a working-v1 readiness claim. `src/server.ts` is
owned by the backend workstream and is deliberately unchanged in this PR.

## Confirmed mismatch

The built-in host Node process currently reads a container IP, calls host
`fetch`/`net.connect`, and invokes plain host `nsenter` for firewall checks.
Rootless Podman runs its private bridge in another network namespace. Its owning
user namespace is also needed for namespace administration. A same-host public
TLS gateway does not change Node's private network reachability.

`src/rootless-control.ts` supplies two **trusted-internal** bounded operations:

- `firewall(workspace, role, family)`: validate inspected workspace label,
  container state/PID, single assigned private network and no published ports;
  run `podman unshare python3 <anonymous-pipe relay> nsenter -t PID -n
  iptables|ip6tables -S OUTPUT`. The trusted relay captures child stdout/stderr
  through actual anonymous pipes, preserves status and an eight-second deadline,
  then forwards the result to the host runner. Empty or malformed output is
  rejected, even when the subprocess exits zero. Callers
  must still validate the complete default-deny rule set, not just nonempty text.
- `probe(workspace, trustedCommand)`: inspect the browser similarly, then run
  the caller's trusted executable with `podman unshare --rootless-netns` and the
  inspected IP. This tests the **bridge route**, not browser-container loopback.
  Commands/arguments must never be selected by an agent/API request. Execution
  uses argument arrays, a ten-second deadline, SIGKILL and 256-KiB output bound.

The helper requires actual rootless Podman. It does not silently fall back to
rootful Docker, host networking, privileged containers, public port publication,
relaxed seccomp, or disabled Chrome sandboxing. It does not attach the utility to
the browser network or give a container the host OCI socket.

## Backend/runtime integration still required

1. Replace the backend rootless branch's plain `nsenter` runner with `firewall`,
   preserving its full rule comparison and fail-closed readiness. Rootful Docker
   needs a separately reviewed privileged control execution path.
2. A successful helper probe **does not move host Node into that namespace**.
   Host `fetch`, `WebSocket`, and `net.connect` remain unreachable on the observed
   rootless topology. The backend must provide an explicit private transport.
3. For MCP stdio, a supervised spawn adapter can launch the pinned official MCP
   executable under `podman unshare --rootless-netns`; retain per-session auth,
   leases, cancellation, audit, version checks and bounded subprocess cleanup.
   This bounded exec helper must not be used as a long-lived MCP supervisor.
4. For direct CDP metadata/control and the viewer's raw RFB stream, supply a
   reviewed private bridge attachment or protected Unix-socket/stdio relay.
   Endpoint credentials and socket ownership must remain control-only; do not
   replace this with a publicly/host-TCP-published CDP/VNC listener. Unix relays
   require backend client/transport integration, not just a runtime-script tweak.
5. A protected per-workspace sidecar attached to that workspace's browser network
   is the SRS §7.5 topology. Moving the host service into Podman's shared rootless
   bridge namespace alone is not proof of a per-workspace sidecar boundary.

No relay, per-workspace sidecar or server wiring is implemented here. Those
changes require coordination with runtime/backend owners rather than an unsafe
transparent fallback. Caddy still terminates HTTPS/WSS against loopback Node;
raw browser/executor services must remain outside public gateway routes.

## Actual verification, 2026-10-19

Host: UID 1000, native Fedora Linux x86-64 kernel 7.2.9-201.fc44, Podman 5.8.7
rootless=true, Node 22.23.1. Local image `browseruse-egress:local` supplies Python
only; its entrypoint is overridden for an isolated synthetic HTTP/RFB-shaped
fixture, running UID/GID 1000, read-only rootfs, no capabilities,
no-new-privileges, CPU/memory/PID limits and no published ports.

```sh
npm ci
npm run typecheck
BUK_LIVE_ROOTLESS_CONTROL=1 node --import tsx --test tests/rootless-control.test.ts
```

Result after the output-capture correction: typecheck passed; four focused tests
passed without skips (unit planning/identity, relay status/output bounds, and
actual rootless connectivity plus IPv4/IPv6 firewall readback). Actual
resources used unique `buk-control-<UUID>-browser` names. Cleanup removed only
that fixture container/internal network. No persistent volumes were allocated.
No image build, unrelated resource mutation, CDP/VNC exposure or sandbox change.

Observed live evidence:

- Direct host TCP connection to the inspected fixture IP failed.
- From the same non-root service identity, the helper's rootless bridge child
  reached the private HTTP endpoint and validated a synthetic binary RFB banner.
  Host UID remained 1000. This proves helper-route connectivity, not real Chrome.
- Plain `nsenter` against the actual fixture PID failed with Operation not
  permitted, reproducing the backend's privilege mismatch.
- **Output-capture defect diagnosed and fixed:** direct rootless `iptables -S
  OUTPUT` and IPv6 returned empty stdout despite exit 0. An anonymous-pipe relay
  now returns the real kernel policy. The disposable fixture installed OUTPUT
  DROP, established/related replies and loopback accepts using the runtime's
  existing commands; both families' complete expected entries were then read back
  through the helper. Empty output still fails closed. This establishes actual
  rule presence in this fixture, not a full egress-bypass acceptance matrix.

### Why the output disappeared (Fedora SELinux)

This is a capture/label-transition issue, not evidence that `iptables -P/-A`
failed to install the rules. Reproduction on the actual non-root service account:

```sh
podman unshare iptables --version                    # exit 0, empty output
podman unshare sh -c 'iptables --version | cat'       # actual version text
podman unshare python3 -c 'import subprocess,sys;p=subprocess.run(sys.argv[1:],capture_output=True,timeout=8);sys.stdout.buffer.write(p.stdout);sys.stderr.buffer.write(p.stderr);sys.exit(p.returncode)' iptables --version
# iptables v1.8.11 (nf_tables)
```

The host runner's stdout/stderr are socketpair FDs (`/proc/self/fd` inspection),
not anonymous pipes. `podman unshare id -Z` reports `container_runtime_t`; the
iptables/nft executables have `iptables_exec_t` labels and transition into
`iptables_t`. A direct file-redirection reproduction also lost output. Retained
journal inspection (`journalctl --since '-5 min' -g 'avc:.*denied' --no-pager`)
showed `comm="iptables"`, `scontext=...:iptables_t:...`,
`tcontext=...:container_var_run_t:s0`, `tclass=file`, `{ write }`, `permissive=0`.
Thus zero process exit status did not guarantee successful stdio writes. The
anonymous-pipe path works while enforcing SELinux remains enabled; no labels,
policy, capabilities or sandbox settings were weakened.

**Runtime-worker proposal:** for retained rule readback under rootless Podman,
use this same fixed anonymous-pipe relay or a reviewed equivalent preserving
both stderr and exit status. Do not interpret direct empty capture as policy
absence or success, and do not disable SELinux. Keep actual kernel readback and
negative egress assertions. Existing `-P/-A` commands were sufficient to install
the disposable fixture policy, as the corrected readback confirms. The runtime
scripts were not changed by this PR.

The live fixture has synthetic services, not Chrome or VNC, and no outbound
policy acceptance matrix. Production authentication, MCP, viewer gating,
revocation, real firewall enforcement, Docker and SRS release acceptance remain
unverified by this work. Default `npm test` explicitly skips the live fixture
unless provisioned with `BUK_LIVE_ROOTLESS_CONTROL=1` and the local image.

## Independent backend transport/supervision review

Reviewed backend commit `c47f349` in `/tmp/buk-backend`. It already implements
private CDP, viewer and MCP namespace launch in `src/private-network.ts` and
`src/mcp.ts`; no competing transport implementation was added here.

Executed its existing live test read-only:

```sh
cd /tmp/buk-backend
BUK_LIVE_PRIVATE_NETWORK=1 node --import tsx --test tests/private-network.test.ts
```

**2 passed, no skips.** This exercises actual backend code through disposable
rootless Podman HTTP/WebSocket CDP-shaped and RFB-shaped private endpoints,
without published ports. Its fixture is synthetic, not real Chrome/VNC acceptance.
Its unique fixture containers/networks were removed by its own cleanup.

### Confirmed MCP worker cleanup defect

`src/mcp.ts:132` uses the SDK `StdioClientTransport` with the wrapper returned by
`src/private-network.ts:7–8` (`podman unshare --rootless-netns env ... WORKER`).
SDK `client/stdio.js:143–176` closes stdin and signals only the direct wrapper PID,
first TERM then KILL. It does not kill a worker process group. An uncooperative
stdio worker survives the wrapper's termination:

- Spawned a unique marked Node stdio worker through the **actual backend**
  `privateNetworkCommand` and SDK `StdioClientTransport` under rootless Podman.
- Worker sent a JSON-RPC PID notification, ignored SIGTERM and remained alive on
  stdin EOF. No browser, credentials, listeners or external service were involved.
- Called `transport.close()`: returned after **4205 ms** while `kill(workerPID, 0)`
  still succeeded. Thus close did not prove child termination.
- Before cleanup, checked `/proc/PID/cmdline` contained this test's unique random
  marker; killed only that exact owned worker. No marked worker remained afterward.

Minimal reproduction contract for a backend regression test:

```ts
const marker = 'owned-probe-' + randomUUID();
const script = `process.on('SIGTERM',()=>{});process.stdin.resume();
console.log(JSON.stringify({jsonrpc:'2.0',method:'probe/pid',params:{pid:process.pid,marker:process.argv[1]}}));
setInterval(()=>{},1000)`;
const transport = new StdioClientTransport({
  ...privateNetworkCommand(process.execPath, ['-e', script, marker], true),
  env: privateNetworkEnvironment(true), stderr: 'ignore',
});
// Register onmessage before start; retain only PID with matching marker.
await transport.start();
await ownPidNotification;
await transport.close();
// Observed: owned worker is still alive. Always verify its unique cmdline marker
// before force-killing it in the regression test's finally block.
```

**Required fix contract:** supervise a dedicated process group or equivalent
owned subtree, close stdin/cancel work, apply bounded TERM→KILL escalation to the
whole owned group, and await actual worker exit before acknowledging cleanup.
Do not kill by executable name or broadly signal unrelated Podman processes.
Credential revocation and lifecycle stop must use this same awaited cleanup.
The backend owner should add this regression before claiming abandoned-worker
termination; no server/transport files were modified by this independent review.
