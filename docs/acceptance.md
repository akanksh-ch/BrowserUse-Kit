# v1 acceptance traceability record

**Baseline:** `SRS.md` v0.1 (2026-10-18)  
**Record state:** **PARTIAL DEVELOPMENT VERIFICATION; SRS §16 ACCEPTANCE NOT RUN**  
**Release decision:** **BLOCKED — working-v1 and non-waivable runtime gates remain open**  
**Scope:** Native Linux x86-64, one documented Podman configuration, and one genuinely Docker-compatible configuration.

This is the release checklist and evidence index, not a claim that the implementation works. Development checks recorded below passed, but every SRS §16 checkbox remains unchecked unless backed by that test's complete required environment and procedure. A source path is only a static traceability candidate; it is not proof that the requirement is implemented or that an acceptance test passed. Unit tests, mocks, TypeScript checks, and offline runtime-policy tests do not substitute for container-isolation, host-reboot, real network-policy, viewer, external-client, Docker/Podman, or performance acceptance.

## Evidence rules

For each executed item, record the date, operator, commit, exact command/procedure, exit status, complete log/artifact path, and environment. Runtime evidence must also identify host CPU/RAM/storage, kernel, OCI implementation and version, image digest, resolved component manifest, network topology, and relevant client/browser versions. Performance evidence additionally needs workload, warm-up, sample count, percentile method, and measurement endpoints specified in SRS §15.1.

Allowed results are `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`. `PASS` requires retained evidence. A skipped test is `NOT RUN` or `BLOCKED`, never `PASS`. Any approved temporary waiver must name the release authority, risk, compensating controls, expiry date, and tracking issue. Non-waivable gates below cannot be waived.

## Executed development evidence

The following results are historical, not a fresh test of the current tree.
Later scoped gateway checks and deployment/SRS gaps are recorded in
[deployment-review.md](deployment-review.md). They do not complete any §16 test.

Executed on **2026-10-18T23:18:09Z** against working-tree snapshot based on `7a2283a8d1477be973004a9724109148d279b45d`. The repository was not clean (the implementation files were untracked), so this evidence is tied to the inspected working tree and is not reproducible from that commit alone.

| Command | Actual result | What it establishes | What it does not establish |
|---|---|---|---|
| `npm run typecheck` | **PASS**, exit 0; `tsc --noEmit` produced no diagnostics | Current `tsconfig.json` includes `src/**/*.ts` and `tests/**/*.ts`; that TypeScript set typechecks | Runtime behavior or SRS acceptance |
| `npm test` | **PASS WITH SKIP**, 27 tests: **26 passed, 0 failed, 1 skipped**, 907.829 ms | Native unit/integration subchecks for store/auth/lifecycle, file defenses, leases, RFB parser/gate, MCP filtering/ownership, and loopback HTTP boundaries | The skipped real-OCI utility-command test; complete §16 tests; real browser/viewer/MCP/network/runtime behavior |
| `python3 scripts/test-runtime.py` | **PASS**, 5 tests, 0 failures | Offline proxy address-policy and deployment-text invariants exercised by that script | Built images, namespace firewall enforcement, live egress/rebinding/redirect behavior, Chrome sandbox state, or either OCI runtime configuration |

The skipped Node test is `real OCI utility commands: non-root, bounded output, timeout, cancellation, revocation`. It therefore supplies no evidence for the non-waivable utility-isolation gate or container-backed `AT-030`–`AT-032`.

No `npm audit`, image build, live workspace start, real Docker/Podman, browser, viewer, external MCP, persistence, reboot, performance, or full §16 command was run in this evidence update.

## Static implementation inventory (not validation)

One current-source inspection found candidate implementations in `src/core.ts`, `src/auth.ts`, `src/lifecycle.ts`, `src/server.ts`, `src/files.ts`, `src/commands.ts`, `src/mcp.ts`, `src/leases.ts`, and `src/viewer.ts`; tests in `tests/core.test.ts`, `tests/files.test.ts`, `tests/gateway.test.ts`, and `tests/server.test.ts`; operator assets in `public/*`; and runtime assets in `containers/*`, `scripts/runtime.sh`, `scripts/workspace.sh`, and `scripts/test-runtime.py`.

No acceptance result is inferred from this inventory.

## Non-waivable release gates

SRS §18.2 makes the following test areas non-waivable. Any failure, block, or missing evidence blocks release:

- [ ] **Private privileged services:** raw CDP, raw VNC, and the utility command executor are unreachable from public, host-published, utility, and cross-workspace paths as applicable (`AT-002`, `AT-022`, `AT-031`, `AT-045`, `AT-055`, `AT-073`). **NOT RUN**
- [ ] **Non-root sandboxed Chrome:** Chrome is non-root, uses a supported active sandbox, never uses `--no-sandbox`, and uses a workspace-specific non-default profile in both documented OCI configurations (`AT-003`). **NOT RUN**
- [ ] **Utility isolation:** no sudo, runtime socket, host root, profile, CDP/VNC/X, process namespace, control credential, or unrestricted-capability access (`AT-031`). **NOT RUN**
- [ ] **Authentication and authorization:** unauthorized, expired, revoked, wrong-audience/workspace, CSRF, Host, cookie-isolation, and permission-boundary cases fail closed, including open-session revocation (`AT-021`, `AT-025`, `AT-060`, `AT-061`, `AT-067`). **NOT RUN** — native subchecks passed; open-session and external-protocol acceptance did not run.
- [ ] **Server-side input gating:** forged/fragmented keyboard, mouse, and clipboard input is checked server-side per event and stops on invalid lease/authority (`AT-040`–`AT-045`). **NOT RUN** — RFB parser/gate unit subchecks passed; no live noVNC/VNC session ran.
- [ ] **Durable-audit fail closed:** mutations and lease/lifecycle changes stop when durable audit writes fail and resume only after a successful durable write (`AT-074`, plus mutation-path tests). **NOT RUN** — injected unit failures passed; unavailable/full durable storage and operator alert/recovery acceptance did not run.
- [ ] **Network-policy bypass resistance:** browser and utility direct egress, private/metadata destinations, redirects, rebinding, IPv6, alternate DNS, UDP/QUIC/WebRTC/raw sockets, and cross-workspace paths cannot bypass policy (`AT-050`–`AT-057`). **NOT RUN** — five offline runtime-policy tests passed; no live network namespace or bypass matrix ran.

The remaining SRS §18 release criteria are also mandatory for release, though §18.2 permits only formally documented temporary waivers for acceptance tests outside the non-waivable areas:

- [ ] All v1 `SHALL` requirements have implementation and test evidence. **NOT RUN**
- [ ] All SRS §16 tests pass on the documented reference host. **NOT RUN**
- [ ] Profile/files persist across Chrome restart, runtime replacement, and host reboot. **NOT RUN**
- [ ] External remote MCP and terminal/file workflows operate without manual container entry. **NOT RUN**
- [ ] Concurrent trusted agents, visible shared-profile warning, view-only mode, and workspace-wide takeover work. **NOT RUN**
- [ ] Revocation, deletion, bounded recovery, redaction, component-version, and image-digest checks pass. **NOT RUN**
- [ ] Release documentation covers trust, resources, backup limits, runtime prerequisites, and non-goals. **NOT RUN**

## Working-v1 blockers and high-priority security gaps

This is a source-to-SRS gap list, not a penetration-test result. Resolve and execute the linked acceptance tests before any working-v1 or release claim.

1. **No live egress/isolation proof (non-waivable).** Offline `scripts/test-runtime.py` checks policy functions and script text only. Browser and utility namespace firewalling, proxy-only egress, redirect/rebinding behavior, IPv6, alternate DNS, UDP/QUIC/WebRTC/raw sockets, host gateway, metadata, and cross-workspace denial remain untested (`FR-NET-001`–`012`, `SEC-CTR-010`, `AT-050`–`057`).
2. **Real utility isolation/command execution is skipped (non-waivable).** The only real-OCI command test was skipped, leaving non-root identity, mounts, namespaces, capabilities, runtime-socket/profile/CDP/VNC/X isolation, process-group cancellation, limits, and revocation timing unproved (`FR-CMD-001`–`013`, `SEC-CTR-003`, `006`–`008`, `AT-030`–`032`, `AT-036`, `AT-037`).
3. **Open-session revocation within five seconds lacks end-to-end evidence and appears incomplete for passive viewer output.** HTTP operations reauthenticate, and RFB client input is revalidated per message, but no observed watchdog forcibly terminates or disables an already-open passive viewer connection after credential revocation; external MCP/event/command session timing is likewise untested (`FR-AUTH-011`, `AT-060`).
4. **TLS/public gateway reference now exists; full deployment acceptance remains open.** `deploy/Caddyfile`, `deploy/buk.env`, and `docs/deployment.md` configure a same-host TLS proxy to loopback Node. Focused Caddy parser and real loopback TLS/authority/header/SSE checks passed on 2026-10-19; see [deployment review](deployment-review.md) for exact scope and evidence. This does not establish real public DNS/ACME, authenticated Node behind TLS, external MCP, WSS/noVNC, or runtime isolation (`FR-AUTH-001`, `FR-VIEW-002`, §7.4, `AT-021`, `AT-040`).
5. **Network-policy denials are not connected to durable mandatory audit evidence.** The egress proxy prints a generic denial, while no inspected path showed those denials becoming protected `SEC-LOG-007` audit events. This also leaves policy-denial diagnostics and durable-audit failure behavior unproved (`FR-NET-007`, `SEC-LOG-007`, `SEC-LOG-008`, `AT-050`–`057`, `AT-074`).
6. **Chrome/runtime security is static-only.** No image was built or started, and no runtime inspection proved non-root Chrome, active supported sandbox, seccomp compatibility, `no-new-privileges`, dropped capabilities, private CDP/VNC, profile lock, or workspace-specific user-data directory on either documented OCI configuration (`AT-001`–`004`).
7. **Live viewer takeover remains unproved.** Unit tests passed for lease preemption and fragmented/coalesced RFB input parsing, but no actual noVNC → authenticated WSS → gate → VNC path proved view-only output, per-event denial, lease expiry/revocation cutoff, tab-wide takeover, or direct-VNC unreachability (`FR-VIEW-001`–`014`, `AT-040`–`045`).
8. **External MCP workflow and subprocess lifecycle remain unproved.** Capability filtering unit tests passed, but no official external MCP client demonstrated authenticated Streamable HTTP, one stdio process per agent, private CDP, upload-path integration, subprocess failure containment, reconnect, or exact supported package mapping (`FR-MCP-001`–`018`, `AT-020`–`029`, `AT-072`).
9. **Persistent storage capacity enforcement is incomplete.** Runtime documentation states that persistent filesystem quota is not implemented by the script; API accounting cannot constrain utility-shell or browser writes. A quota-enforced backend and disk-full tests are required before agent commands/downloads are safe (`FR-FILE-003`, `FR-FILE-007`, `SEC-CTR-006`, `AT-035`, `AT-074`).
10. **Release identity and compatibility evidence are absent.** No immutable image digest/build manifest, real Podman run, independent Docker run, host reboot, five-workspace capacity test, or benchmark report exists (`FR-VER-002`–`007`, `NFR-COMP-001`–`004`, `NFR-PERF-001`–`005`, `AT-001`, `003`, `005`, `012`).
11. **The required per-workspace control-sidecar topology is not demonstrated.** The inspected runtime starts browser, utility, and egress containers; the Node control server runs as a host process. No evidence shows the SRS-required protected per-workspace sidecar identity, network attachment, lifecycle, or failure boundary. This needs either implementation evidence or an approved requirements/design change before §7.3/§7.5 and `NFR-REL-001` can pass.

Additional working-v1 feature gaps still requiring end-to-end evidence include screenshot capture/disablement, resumable event cursors and retention gaps, browser download attribution, profile export, UI/API workflow compatibility, and full deletion/recovery behavior (`AT-014`, `033`, `062`–`066`, `070`–`075`).

## Executable verification commands known now

These commands are documented or exposed by the repository. The three marked above were run only with the results recorded in **Executed development evidence**; the remaining commands were not run for this record.

```sh
# Native development gates
npm ci
npm run typecheck          # executed: PASS
npm test                   # executed: 26 PASS, 1 SKIP
npm run test:runtime       # equivalent underlying command was executed: 5 PASS
npm audit                  # NOT RUN

# Podman acceptance lifecycle (unique disposable identifier)
OCI=podman ./scripts/runtime.sh build
OCI=podman ./scripts/runtime.sh start acceptance-podman
OCI=podman ./scripts/runtime.sh inspect acceptance-podman
OCI=podman ./scripts/runtime.sh stop acceptance-podman
OCI=podman ./scripts/runtime.sh delete acceptance-podman

# Run only on a host verified to have an independent Docker Engine/configuration
# (use a different unique identifier and retain `docker info` output)
docker info
OCI=docker ./scripts/runtime.sh build
OCI=docker ./scripts/runtime.sh start acceptance-docker
OCI=docker ./scripts/runtime.sh inspect acceptance-docker
OCI=docker ./scripts/runtime.sh stop acceptance-docker
OCI=docker ./scripts/runtime.sh delete acceptance-docker
```

Use `--rm` for disposable ad-hoc containers where applicable, unique persistent-volume names, and explicit project-scoped cleanup. Never broadly prune existing user images, containers, or volumes. The commands above are entry points only; they do not by themselves execute all §16 assertions. Tests without a repository harness require a documented manual or external-client procedure before execution.

### Docker-wrapper warning

The observed development host reports `docker` as a Podman compatibility wrapper. Running `OCI=docker ...` there exercises Podman through a Docker-compatible CLI; it does **not** establish independent Docker Engine coverage and cannot satisfy `AT-003`/`NFR-COMP-002` for both documented Podman and Docker configurations. Docker acceptance needs retained `docker info` evidence showing the actual server implementation/version and must run against a real documented Docker-compatible runtime configuration. Podman results and Docker results must be recorded separately.

## SRS requirement traceability

All listed SRS acceptance states remain **NOT RUN**. The development subchecks above are supporting evidence only. “Candidate implementation” means where evidence should be sought, not that the path is complete.

| Requirement IDs | Candidate implementation / documentation | Primary acceptance evidence | State |
|---|---|---|---|
| `FR-WS-001`, `FR-WS-002`, `FR-WS-003`, `FR-WS-004`, `FR-WS-005`, `FR-WS-006`, `FR-WS-007`, `FR-WS-008`, `FR-WS-009` | `src/core.ts`, `src/lifecycle.ts`, `src/server.ts`, runtime scripts | `AT-002`, `004`, `010`–`014`, `070`–`075` | NOT RUN |
| `FR-BR-001`, `FR-BR-002`, `FR-BR-003`, `FR-BR-004`, `FR-BR-005`, `FR-BR-006`, `FR-BR-007`, `FR-BR-008`, `FR-BR-009`, `FR-BR-010`, `FR-BR-011`, `FR-BR-012` | `containers/browser/*`, `src/mcp.ts`, `src/auth.ts` | `AT-003`, `010`, `020`, `024`, `025`, `028`, `033`, `040` | NOT RUN |
| `FR-MCP-001`, `FR-MCP-002`, `FR-MCP-003`, `FR-MCP-004`, `FR-MCP-005`, `FR-MCP-006`, `FR-MCP-007`, `FR-MCP-008`, `FR-MCP-009`, `FR-MCP-010`, `FR-MCP-011`, `FR-MCP-012`, `FR-MCP-013`, `FR-MCP-014`, `FR-MCP-015`, `FR-MCP-016`, `FR-MCP-017`, `FR-MCP-018` | `src/mcp.ts`, `src/leases.ts`, `src/server.ts` | `AT-020`–`029`, `060`, `061`, `063`, `072`–`074` | NOT RUN |
| `FR-PG-001`, `FR-PG-002`, `FR-PG-003`, `FR-PG-004`, `FR-PG-005`, `FR-PG-006`, `FR-PG-007`, `FR-PG-008`, `FR-PG-009`, `FR-PG-010` | `src/mcp.ts`, `public/*` | `AT-023`, `024`, `026`–`029`, `043` | NOT RUN |
| `FR-CMD-001`, `FR-CMD-002`, `FR-CMD-003`, `FR-CMD-004`, `FR-CMD-005`, `FR-CMD-006`, `FR-CMD-007`, `FR-CMD-008`, `FR-CMD-009`, `FR-CMD-010`, `FR-CMD-011`, `FR-CMD-012`, `FR-CMD-013` | `src/commands.ts`, `containers/utility/Dockerfile`, `tests/files.test.ts` | `AT-030`–`032`, `036`, `037`, `042`, `052`, `057`, `060`, `061`, `074` | NOT RUN |
| `FR-FILE-001`, `FR-FILE-002`, `FR-FILE-003`, `FR-FILE-004`, `FR-FILE-005`, `FR-FILE-006`, `FR-FILE-007`, `FR-FILE-008` | `src/files.ts`, `src/server.ts`, `tests/files.test.ts`, `public/*` | `AT-033`–`035`, `060`, `061`, `074` | NOT RUN |
| `FR-VIEW-001`, `FR-VIEW-002`, `FR-VIEW-003`, `FR-VIEW-004`, `FR-VIEW-005`, `FR-VIEW-006`, `FR-VIEW-007`, `FR-VIEW-008`, `FR-VIEW-009`, `FR-VIEW-010`, `FR-VIEW-011`, `FR-VIEW-012`, `FR-VIEW-013`, `FR-VIEW-014` | `src/viewer.ts`, `src/leases.ts`, `public/*`, browser container | `AT-040`–`045`, `060`, `061`, `067`, `073` | NOT RUN |
| `FR-EVT-001`, `FR-EVT-002`, `FR-EVT-003`, `FR-EVT-004`, `FR-EVT-005`, `FR-EVT-006`, `FR-EVT-007`, `FR-EVT-008`, `FR-EVT-009`, `FR-EVT-010` | `src/core.ts`, `src/server.ts`, `public/*` | `AT-030`, `037`, `062`–`066`, `074` | NOT RUN |
| `FR-AUTH-001`, `FR-AUTH-002`, `FR-AUTH-003`, `FR-AUTH-004`, `FR-AUTH-005`, `FR-AUTH-006`, `FR-AUTH-007`, `FR-AUTH-008`, `FR-AUTH-009`, `FR-AUTH-010`, `FR-AUTH-011`, `FR-AUTH-012`, `FR-AUTH-013`, `FR-AUTH-014`, `FR-AUTH-015`, `FR-AUTH-016`, `FR-AUTH-017` | `src/auth.ts`, `src/server.ts` | `AT-021`, `025`, `040`–`045`, `060`, `061`, `067` | NOT RUN |
| `FR-NET-001`, `FR-NET-002`, `FR-NET-003`, `FR-NET-004`, `FR-NET-005`, `FR-NET-006`, `FR-NET-007`, `FR-NET-008`, `FR-NET-009`, `FR-NET-010`, `FR-NET-011`, `FR-NET-012` | `containers/egress/*`, `scripts/runtime.sh` | `AT-050`–`057`, `073` | NOT RUN |
| `FR-VER-001`, `FR-VER-002`, `FR-VER-003`, `FR-VER-004`, `FR-VER-005`, `FR-VER-006`, `FR-VER-007` | OCI Dockerfiles/script; build-manifest evidence not observed | `AT-001`–`003`, `010`–`013`, `020`, `040`, `050`; image digest/manifest inspection | NOT RUN |
| `SEC-CTR-001`, `SEC-CTR-002`, `SEC-CTR-003`, `SEC-CTR-004`, `SEC-CTR-005`, `SEC-CTR-006`, `SEC-CTR-007`, `SEC-CTR-008`, `SEC-CTR-009`, `SEC-CTR-010`, `SEC-CTR-011`, `SEC-CTR-012` | `containers/*`, `scripts/runtime.sh` | `AT-002`, `003`, `005`, `031`, `045`, `050`–`057`, `073` | NOT RUN |
| `SEC-PROF-001`, `SEC-PROF-002`, `SEC-PROF-003`, `SEC-PROF-004`, `SEC-PROF-005` | browser container/runtime; lifecycle/profile export paths not observed | `AT-003`, `004`, `010`–`014`, `031`, `070`, `075` | NOT RUN |
| `SEC-LOG-001`, `SEC-LOG-002`, `SEC-LOG-003`, `SEC-LOG-004`, `SEC-LOG-005`, `SEC-LOG-006`, `SEC-LOG-007`, `SEC-LOG-008` | `src/core.ts`, mutation modules, `src/server.ts`, egress proxy | `AT-025`, `030`, `037`, `041`, `044`, `063`, `064`, `074` | NOT RUN |
| `NFR-PERF-001`, `NFR-PERF-002`, `NFR-PERF-003`, `NFR-PERF-004`, `NFR-PERF-005` | No performance harness observed | timed `AT-002`, `005`, `020`, `040`, `062` with §15.1 report metadata | NOT RUN |
| `NFR-REL-001`, `NFR-REL-002`, `NFR-REL-003`, `NFR-REL-004`, `NFR-REL-005` | `src/core.ts`, `src/lifecycle.ts`, `src/server.ts`, runtime | `AT-011`–`014`, `070`–`075` plus retry/idempotency evidence | NOT RUN |
| `NFR-COMP-001`, `NFR-COMP-002`, `NFR-COMP-003`, `NFR-COMP-004` | `scripts/runtime.sh`, `README.md` | separate native x86-64 Podman and real Docker records; cleanup evidence | NOT RUN |

### Normative unnumbered SRS clauses

These clauses contain additional `SHALL` obligations and must not disappear behind the numbered-ID matrix.

| SRS section | Acceptance focus | Candidate evidence | State |
|---|---|---|---|
| §2 product goals | All ten top-level product outcomes: headful durable workspaces, authenticated MCP/commands, concurrency, isolation, observation/takeover, private privileged services, and Docker/Podman support | Aggregate §16 evidence and signed §18 release index | NOT RUN |
| §7.2 viewer stack | Headful Chrome → X/window manager → VNC → trusted input gate → websockify/noVNC | `containers/browser/*`, `src/viewer.ts`, `public/*`; `AT-003`, `040`–`045` | NOT RUN |
| §7.3 MCP topology | Authenticated remote transport, per-agent official stdio subprocess, private CDP | `src/mcp.ts`; `AT-020`–`029`, `072`, `073` | NOT RUN |
| §7.4–§7.5 routing/grouping | Workspace-aware fail-closed auth; distinct containers, networks, identities, mounts, protected events; no namespace sharing | runtime inspection and adversarial connectivity/mount tests; `AT-002`, `022`, `031`, `045`, `055`, `073`, `074` | NOT RUN |
| §8 records | Required workspace, connection, ownership, and sanitized activity-event fields | SQLite schema/API/event inspection; no complete schema/API evidence recorded | NOT RUN |
| §9.1–§9.6 lifecycle | Exact states/activity semantics, locked startup/readiness, idle rules, bounded graceful shutdown/recovery, revoke-first deletion, erasure caveat | lifecycle/API/event/runtime/reboot evidence; `AT-002`, `004`, `010`–`014`, `070`–`075` | NOT RUN |
| §11.1 trust boundaries | Workspace is minimum trust boundary; no cross-workspace identities/profiles/volumes/networks/CDP; utility cannot reach privileged surfaces; CDP stays private | mount, identity, namespace, connectivity, and cross-workspace evidence; `AT-022`, `031`, `045`, `055`, `073` | NOT RUN |
| §12 UI | All 14 listed operator-console capabilities and visible policy/shared-workspace warnings | `public/*` plus browser walkthrough, authorization and accessibility evidence | NOT RUN |
| §13 interfaces | Lifecycle, MCP, command, file, event-resume, and viewer operations | authenticated external-client integration transcript; server path not observed | NOT RUN |
| §15.1 performance report | Measurement definitions and complete reference-host metadata | retained benchmark report for all five NFRs | NOT RUN |
| §15.2 resources | Configurable defaults; explicit event/diagnostic on limit | OCI configuration and forced-limit tests | NOT RUN |
| §15.5 diagnostics | Correlation IDs, component health separation, external version/image metadata, bounded structured logs, actionable secret-safe failures | API/UI/log inspection and injected failures | NOT RUN |
| §18 release criteria | All 12 release conditions, waiver records where permitted, and all non-waivable gates | signed release evidence index | NOT RUN |

## SRS §16 acceptance checklist

### §16.1 Build and startup

- [ ] `AT-001` Build Debian image; retain successful build log and resolved-version manifest. **NOT RUN** — entry point: `OCI=<runtime> ./scripts/runtime.sh build`.
- [ ] `AT-002` Start disposable workspace; prove `ready` and no published CDP/VNC/executor port. **NOT RUN**.
- [ ] `AT-003` Inspect identity, arguments, active sandbox and host prerequisites separately on documented Podman and real Docker configurations. **NOT RUN**.
- [ ] `AT-004` Start a second runtime on one profile; prove lock rejection. **NOT RUN**.
- [ ] `AT-005` Start five idle workspaces on the documented reference host; prove responsiveness and bounds. **NOT RUN** — the observed ~12 GiB development host is not sufficient to assert the stated 2–4 GiB-per-workspace capacity target without an approved documented workload/configuration.

### §16.2 Persistence

- [ ] `AT-010` Future-expiry cookie and file survive Chrome restart. **NOT RUN**.
- [ ] `AT-011` Profile and files survive runtime-container replacement. **NOT RUN**.
- [ ] `AT-012` Record and data survive an actual host reboot and restart. **NOT RUN** — container restart is not a substitute.
- [ ] `AT-013` Idle stop/start preserves durable state without asserting exact tab memory. **NOT RUN**.
- [ ] `AT-014` Deletion revokes credentials and removes selected durable data. **NOT RUN**.

### §16.3 MCP and page coordination

- [ ] `AT-020` Authorized external discovery matches the versioned map; injected unknown/new tool is denied. **NOT RUN**.
- [ ] `AT-021` Unauthenticated MCP fails before subprocess creation. **NOT RUN**.
- [ ] `AT-022` Direct host CDP access is unreachable. **NOT RUN**.
- [ ] `AT-023` Two trusted agents operate separate recorded tabs concurrently. **NOT RUN**.
- [ ] `AT-024` Popup detection and opener-based ownership inheritance work. **NOT RUN**.
- [ ] `AT-025` Unauthorized browser-global/dual-use operation is absent or rejected and audited. **NOT RUN**.
- [ ] `AT-026` Pre-expiry reconnect creates fresh MCP process and restores ownership. **NOT RUN**.
- [ ] `AT-027` Post-expiry reconnect does not silently restore ownership. **NOT RUN**.
- [ ] `AT-028` Reused/internal target identifier does not inherit stale ownership. **NOT RUN**.
- [ ] `AT-029` Lease acquire/renew/expire/revoke/contention/reconnect/takeover transitions never restore mutation implicitly. **NOT RUN**.

### §16.4 Terminal and files

- [ ] `AT-030` Normal command runs non-root in agent directory with bounded attributed output. **NOT RUN**.
- [ ] `AT-031` Utility escape/access matrix is denied while approved files remain usable. **NOT RUN**.
- [ ] `AT-032` Timed-out command terminates its entire process group and reports timeout. **NOT RUN**.
- [ ] `AT-033` PDF upload and browser selection work only from approved paths. **NOT RUN**.
- [ ] `AT-034` Traversal and symlink escapes are rejected. **NOT RUN**.
- [ ] `AT-035` Quota exhaustion is explicit and preserves committed files. **NOT RUN**.
- [ ] `AT-036` Concurrent commands remain attributable to initiating agents. **NOT RUN**.
- [ ] `AT-037` Editing `.bash_history` cannot alter the authoritative timeline. **NOT RUN**.

Native checks in `tests/files.test.ts` passed for traversal, symlink/hardlink and directory-swap defenses, quota accounting, atomicity, authorization/revocation, audit failure, transfer bounds/timeouts, and command pre-spawn behavior. The real-OCI command test was skipped, so these checks do not satisfy container-backed `AT-030`–`037`.

### §16.5 Viewer and takeover

- [ ] `AT-040` View-only video works while forged keyboard/mouse/clipboard—including fragmented RFB input—is denied server-side. **NOT RUN**.
- [ ] `AT-041` Authorized takeover pauses automation before granting one workspace-wide lease. **NOT RUN**.
- [ ] `AT-042` During-takeover and just-before-release mutations are rejected, never replayed, and require a new lease. **NOT RUN**.
- [ ] `AT-043` Operator tab switching does not permit agent mutation in any tab. **NOT RUN**.
- [ ] `AT-044` Disconnect expiry safely releases/escalates control and records the event. **NOT RUN**.
- [ ] `AT-045` Direct external VNC is unreachable. **NOT RUN**.

### §16.6 Network security

- [ ] `AT-050` Public HTTPS succeeds through controlled egress. **NOT RUN**.
- [ ] `AT-051` Chrome cannot reach loopback, host gateway, RFC1918, link-local, or metadata destinations by default. **NOT RUN**.
- [ ] `AT-052` Utility shell has the same denied-destination protection. **NOT RUN**.
- [ ] `AT-053` DNS rebinding to private space is denied. **NOT RUN**.
- [ ] `AT-054` Redirect to a denied destination is denied. **NOT RUN**.
- [ ] `AT-055` Cross-workspace private-service access is denied. **NOT RUN**.
- [ ] `AT-056` IPv6 enforces equivalent policy. **NOT RUN**.
- [ ] `AT-057` Direct/alternate DNS, UDP, QUIC, WebRTC, and raw sockets cannot bypass policy. **NOT RUN**.

### §16.7 Authorization and logging

- [ ] `AT-060` Invalid credentials are denied on new requests and lose authority on every open protocol within 5 seconds. **NOT RUN**.
- [ ] `AT-061` Viewer authority cannot call command or MCP mutation. **NOT RUN**.
- [ ] `AT-062` Agent status is visibly labeled agent-authored. **NOT RUN**.
- [ ] `AT-063` Logs contain no raw cookies, authorization headers, or access tokens. **NOT RUN**.
- [ ] `AT-064` Disabling screenshots prevents all new screenshot retention. **NOT RUN**.
- [ ] `AT-065` Valid cursor resumes missing events in order. **NOT RUN**.
- [ ] `AT-066` Expired cursor returns an explicit retention gap. **NOT RUN**.
- [ ] `AT-067` Session rotation, CSRF, login throttling, exact Host validation, and sibling-cookie isolation are enforced. **NOT RUN**.

### §16.8 Failure recovery

- [ ] `AT-070` Unexpected Chrome death triggers bounded recovery and preserves profile. **NOT RUN**.
- [ ] `AT-071` Repeated startup failure reaches `failed` without an infinite loop. **NOT RUN**.
- [ ] `AT-072` MCP subprocess death is session-scoped and does not expose CDP. **NOT RUN**.
- [ ] `AT-073` Sidecar loss fails public operations closed while private ports remain inaccessible. **NOT RUN**.
- [ ] `AT-074` Unavailable/full durable audit storage blocks new mutations, alerts, and only resumes after durable write success. **NOT RUN**.
- [ ] `AT-075` Interrupted profile flush reports recovery and preserves diagnostics at next start. **NOT RUN**.

## Release sign-off

- Source snapshot: working tree based on `7a2283a8d1477be973004a9724109148d279b45d` (dirty/untracked; not reproducible from commit alone)
- Development-check time: `2026-10-18T23:18:09Z`
- Reference host/environment artifact: _not recorded_
- Podman evidence bundle: _not recorded_
- Independent Docker evidence bundle: _not recorded_
- Section 16 result bundle: _not recorded_
- Waivers (non-waivable areas prohibited): _none recorded_
- Release authority and date: _not signed_

**Current conclusion:** Development checks are green except for one skipped real-OCI test, but SRS acceptance remains unexecuted and the working-v1 blockers above remain open. The product must not be described as SRS-compliant, acceptance-tested, or release-ready on the basis of this record.
