# Rootless control namespace integration contract

The helper was introduced separately and is now wired by the backend workstream
in `src/server.ts` and `src/private-network.ts`. This is not a working-v1
readiness claim; the live kernel firewall readback blocker below remains.

## Confirmed mismatch

The built-in host Node process currently reads a container IP, calls host
`fetch`/`net.connect`, and invokes plain host `nsenter` for firewall checks.
Rootless Podman runs its private bridge in another network namespace. Its owning
user namespace is also needed for namespace administration. A same-host public
TLS gateway does not change Node's private network reachability.

`src/rootless-control.ts` supplies two **trusted-internal** bounded operations:

- `firewall(workspace, role, family)`: validate inspected workspace label,
  container state/PID, single assigned private network and no published ports;
  run `podman unshare nsenter -t PID -n iptables|ip6tables -S OUTPUT`. Empty or
  malformed output is rejected, even when the subprocess exits zero. Callers
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

## Backend/runtime integration contract

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

Backend wiring now implements items 1–4 for non-root Podman: firewall inspection
uses the helper, bounded direct CDP commands use a namespace child, pinned official
MCP stdio workers launch inside the rootless bridge, and viewer RFB streams use
supervised stdio relays. `private-network.ts` retains the rootful direct path and
keeps public HTTP in the host namespace. No raw TCP listener is introduced.
Synthetic live backend CDP and binary RFB relay tests pass; real Chrome remains
blocked separately by its fatal zygote startup failure. Item 5's per-workspace
sidecar topology and real firewall acceptance remain unproved. Caddy still
terminates HTTPS/WSS against loopback Node; raw browser/executor services remain
outside public gateway routes.

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

Result: typecheck passed; three focused tests passed without skips. Actual
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
- **Additional blocker:** both `podman unshare nsenter ... iptables -S OUTPUT`
  and its IPv6 counterpart returned **empty output despite exit 0** on this host.
  The helper rejects this and refuses readiness. Successful firewall listing or
  kernel rule enforcement is **NOT VERIFIED**. Earlier rootless runtime checks
  relying only on successful `iptables -P/-A/-C` exit codes need retained kernel
  rule/readback evidence before they can establish network-policy acceptance.

The live fixture has synthetic services, not Chrome or VNC, and no outbound
policy acceptance matrix. Production authentication, MCP, viewer gating,
revocation, real firewall enforcement, Docker and SRS release acceptance remain
unverified by this work. Default `npm test` explicitly skips the live fixture
unless provisioned with `BUK_LIVE_ROOTLESS_CONTROL=1` and the local image.
