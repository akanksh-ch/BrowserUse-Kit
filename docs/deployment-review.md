# Deployment/SRS gap review — 2026-10-19

**Release decision: BLOCKED.** This independent review covers deployment config
and documentation, not the concurrent runtime/backend/frontend workers' results.
Historical `docs/acceptance.md` evidence must not be mistaken for a current run.

## Snapshot and executed checks

Reviewed branch `feat/v1-deploy`, baseline `c220bc7` (TLS reference), following
`efbadfb` (preserved implementation), `7a2283a` (SRS) and `97b8c8e`.
Gateway regression/fix: `ff2fdc8`.
Host: Linux 7.2.9-201.fc44.x86_64, native x86-64; Podman reports 5.8.7.
No OCI resources were created, changed or deleted by this review.

Executed 2026-10-19 around 14:58 UTC:

| Command | Observed result | Scope |
|---|---|---|
| `/tmp/buk-caddy version` | `v2.11.7 h1:yj0Y4fYZGPkSvibBJ1sTWE33xC0fxztVyXEW5iIdUT4=` | Available local Caddy binary; not an installed production service |
| `CADDY=/tmp/buk-caddy sh deploy/check.sh` | Exit 0, `Valid configuration` | Original Caddy parser/module provisioning, including automatic HTTPS/redirect setup; no ACME or production listener |
| `CADDY=/tmp/buk-caddy python3 tests/deployment.test.py -v` before fix | Exit 1, `200 != 421 : attacker.invalid` | Reproduced unknown-Host response gap under real TLS |
| Same focused test after fix | Exit 0; 2 tests passed, no skips | Defaults plus real trusted loopback TLS, exact authorities, preserved Host/Authorization/MCP headers and immediate SSE event |

The live test uses a temporary self-signed SAN certificate explicitly trusted by
the client (no insecure certificate bypass), random loopback ports and synthetic
bearer/session values. The production upstream is replaced by an isolated test
HTTP server; ACME/admin are disabled only in the temporary test copy. Production
config is independently validated unchanged. The executable regression test is
the retained reproducible artifact; no full production deployment log bundle was
produced. Production audit acceptance still requires its own retained evidence.

### Defect and narrow correction

Caddy's site matcher bypasses the named site's Host guard for a different host.
It returned an empty 200 rather than forwarding upstream, so the app boundary
was not bypassed, but the documented 421/rejection guarantee was false. Added an
HTTPS catch-all returning 421. Tests now verify both accepted authorities and
rejection of attacker host, localhost, and wrong explicit port, with only the two
accepted requests reaching upstream. Unknown SNI may fail TLS before HTTP.

## Security defaults reviewed

- `BUK_BIND=127.0.0.1`, `PORT=3000`, `BUK_SECURE=1`; the literal accepted hosts
  agree with Caddy. Node refuses direct non-loopback binds in `src/server.ts`.
- No Host rewriting; backend exact-host and same-origin checks retain authority.
  Secure cookie selection does not rely on trusting forwarded headers.
- Caddy defaults preserve authorization/MCP headers, handle WebSockets, and
  `flush_interval -1` supports SSE. Only header/SSE behavior was executed here;
  WSS/noVNC and authenticated Node behavior were **NOT RUN**.
- Reference exposes no raw runtime service through Caddy. Actual host/container
  listener, firewall, IPv6 and tunnel exposure checks were **NOT RUN**.
- No access-log directive is enabled. This is not proof that upstream errors,
  application audit data or service-manager logs redact credentials.
- Example hostname must be replaced consistently before deployment; current
  `buk.example.com` configuration is not a usable public certificate deployment.

## Acceptance gaps remaining

No complete SRS §16 acceptance test is closed by this work. The full matrix in
`acceptance.md` remains the release checklist. Priority gaps:

1. **Non-waivable runtime gates:** active non-root Chrome sandbox on both
   documented OCI configurations, private CDP/VNC/executor reachability, utility
   mount/namespace/credential isolation, proxy-only egress including IPv6,
   rebinding, redirects, alternate DNS, UDP/QUIC/WebRTC/raw sockets, cross-workspace
   denial. These require runtime worker evidence, not config/text inspection.
2. **Non-waivable control gates:** authenticated external MCP with pinned official
   subprocesses, open-session revocation within five seconds, real WSS/noVNC
   forged-input denial and lease takeover, durable-audit disk failure/recovery.
   Unit tests and this synthetic TLS upstream cannot establish these properties.
3. **Production TLS:** real DNS/ACME, persistent certificate storage, port-80
   redirect, host firewall/public IPv4+IPv6 probes, HTTPS login cookie/CSRF,
   authenticated MCP streaming/session lifecycle and viewer WSS remain NOT RUN.
   Caddy's shared loopback login throttle is documented, not per-client control.
4. **Persistence and operational proof:** future-expiry cookies and files across
   Chrome restart/container replacement/actual host reboot, idle shutdown,
   revoke-first deletion, bounded crash recovery and interrupted flush diagnostics.
5. **Storage and provenance:** quota-enforced volume backend for browser/shell
   writes, disk-full atomicity, immutable image digest and exact build manifest;
   mutable local images and API-only upload accounting do not satisfy the SRS.
6. **Architecture gap:** SRS §7.5 requires a protected per-workspace control
   sidecar; the reference is a host Node process. Demonstrate equivalent approved
   architecture or implement the required boundary; TLS config does not resolve it.
7. **Coverage/sign-off:** independent Docker evidence (a Podman CLI wrapper is
   not independent Docker), five-workspace resource/performance report with SRS
   §15 metadata, full SHALL traceability and signed §18 release decision remain
   open. No waivers or release approval are supplied by this review.

No npm suite, image build, browser runtime, external agent, host reboot or
performance test was executed in this deployment-only review. Merge other
workers' evidence explicitly with source commits and environment before changing
any release status; do not infer their results from this document.

## Opt-in deployed MCP/SSE + WSS smoke gate (follow-up)

`tests/deployment-live.test.ts` can target an **already running, ready** workspace
without changing runtime/backend/UI files. Supply short-lived workspace-scoped
credentials through a trusted environment/secret injector, never URL arguments:

```sh
# Inject BUK_DEPLOY_AGENT_TOKEN (automation) and BUK_DEPLOY_VIEW_TOKEN (view only).
# They must be distinct; do not paste secrets into shell history or this document.
export BUK_DEPLOY_URL=https://your-configured-host.example
export BUK_DEPLOY_WORKSPACE=your-ready-workspace-id
BUK_DEPLOY_LIVE=1 node --import tsx --test tests/deployment-live.test.ts
unset BUK_DEPLOY_AGENT_TOKEN BUK_DEPLOY_VIEW_TOKEN
```

Use the normal trusted public certificate chain. For an internal PKI, set
`NODE_EXTRA_CA_CERTS` to its trusted CA file before launching Node. Never use
`NODE_TLS_REJECT_UNAUTHORIZED=0`. Origin configuration rejects plaintext, URL
credentials, paths, queries and fragments. Failure messages omit credentials,
raw MCP errors and page results; protected deployment diagnostics are still needed.

The gate checks unauthenticated and view-only MCP initialization denial, an
actual SDK Streamable HTTP session, tool discovery, read-only `list_pages`, an
observed `text/event-stream` response, session termination, unauthenticated WSS
denial, and an authenticated binary RFB banner over WSS. It sends **no RFB client
input**, navigations, mutations, lifecycle calls, or automation-lease requests.
The underlying MCP service may assign an initial tab per its normal connect
contract; use a disposable test workspace. Bearer credentials stay in headers.

### Executed harness verification versus unexecuted deployment proof

Executed locally on 2026-10-19 with Node 22.23.1 and Caddy 2.11.7:

- `npm run typecheck`: passed including both new TypeScript files.
- `node --import tsx --test tests/deployment-live.test.ts`: config guard passed;
  real-deployment test **SKIPPED**, because no deployment credentials were supplied.
- `CADDY=/tmp/buk-caddy node --import tsx tests/deployment-fixture.ts`: **2 tests
  passed, no skips** through a real loopback TLS Caddy gateway. This fixture uses
  the production Caddyfile with only test origin/ports/certificate substitutions,
  a real MCP SDK server/transport, a synthetic empty page-list tool, synthetic
  bearer checks and an artificial RFB banner. The temporary certificate is
  explicitly trusted, and all listeners/files/processes are test-scoped.

The fixture proves the smoke harness and real Caddy MCP/SSE/WSS forwarding work
with these synthetic protocol endpoints. It **does not** exercise production
Node authorization, Chrome DevTools MCP, real Chrome/VNC/noVNC, per-event input
gating, revocation timing, workspace scoping, public ACME, firewalling or Docker.
The opt-in gate against a real provisioned workspace remains **NOT RUN** here.
Even a future successful deployed smoke is partial §16 evidence, not complete
`AT-020`, `AT-040`, `AT-060`, `AT-067` or release acceptance.
