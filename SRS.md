# BrowserUse Kit Software Requirements Specification

**Version:** 0.1 Draft<br>
**Date:** 2026-10-18
**Status:** Approved design baseline for v1 planning

## 1. Purpose

BrowserUse Kit provides durable, containerized browser workspaces that external AI agents can use through Chrome DevTools MCP and a non-root terminal interface. Human operators can observe browser activity, inspect an activity timeline, and temporarily take control through a web-based remote desktop.

The first release targets a single Linux host operated by one administrator. It supports several concurrent workspaces while preserving a path toward team and hosted deployments.

This document defines product behavior, trust boundaries, functional requirements, quality requirements, use cases, acceptance tests, and edge cases. It does not prescribe a detailed implementation plan.

## 2. Product goals

BrowserUse Kit shall:

1. Run headful Google Chrome in disposable Debian-based container runtimes.
2. Preserve each workspace's Chrome profile and files across Chrome restarts, container replacement, and host reboot when the underlying volumes survive.
3. Let external AI agents access page-oriented Chrome DevTools MCP capabilities through an authenticated remote endpoint.
4. Let external AI agents manipulate local workspace files through an authenticated, non-root command interface.
5. Allow several trusted agents to work concurrently in separate tabs within one workspace.
6. Isolate different workspaces by runtime, profile, storage, credentials, and network policy.
7. Let a human observe the browser, activity log, screenshots, and terminal activity.
8. Let a human acquire exclusive workspace control and later return control to agents.
9. Keep raw Chrome DevTools Protocol (CDP), VNC, and runtime command services off public interfaces.
10. Support Docker-compatible and Podman-compatible OCI runtimes on a native Linux x86-64 host.

## 3. Non-goals for v1

The following are explicitly outside the first release:

- Security isolation between agents sharing the same workspace or Chrome profile.
- A claim that one tab is a browser security boundary.
- Multi-host scheduling, clustering, autoscaling, or Kubernetes orchestration.
- Public, hostile multi-tenant SaaS operation.
- Billing, metering for invoicing, or organization management.
- Hosting or orchestrating arbitrary AI model runtimes.
- Capturing hidden model reasoning or chain of thought.
- Reliably capturing stdout from agents that run outside BrowserUse Kit.
- Exact restoration of in-memory JavaScript state, unsaved forms, scroll positions, or all open tabs after shutdown.
- General-purpose remote Linux desktops or arbitrary GUI application hosting.
- Audio, microphone forwarding, or viewer-based file transfer.
- Browser extension installation and Chrome account synchronization by default.
- A complete security sandbox implemented by MCP tool filtering.
- Transparent migration of a live workspace between hosts.
- Backup or recovery after loss of the host's persistent storage.
- ARM64, macOS, or Windows as acceptance-tested v1 hosts.

## 4. Definitions

### 4.1 Workspace

A durable logical object representing one browser trust boundary. A workspace owns:

- one Chrome user-data profile;
- one runtime lifecycle;
- working files and downloads;
- agent/tab ownership metadata;
- access policy and network policy;
- audit events and optional screenshots;
- activity and retention settings.

A workspace is not synonymous with a running container. Its runtime may be stopped and recreated while its durable data remains.

### 4.2 Browser runtime container

The container that runs headful Chrome, the virtual display, window manager, and VNC server. It does not run an agent-accessible shell.

### 4.3 Utility container

A separate, unprivileged container that executes agent commands. It mounts only approved workspace-file paths, uses controlled egress, and has no access to the Chrome profile, CDP network, X display socket, VNC socket, control credentials, or browser runtime process namespace.

### 4.4 Control sidecar

A protected per-workspace service that terminates authenticated control connections, runs or supervises Chrome DevTools MCP subprocesses, applies permissions and leases, brokers commands to the utility container, gates remote-desktop input, and emits audit events.

### 4.5 Agent

An AI-driven client external to BrowserUse Kit. An agent connects through authenticated MCP, command, file, and optional status-event interfaces. BrowserUse Kit does not host the agent's model or main process.

### 4.6 Operator

A human authorized to view or control a workspace.

### 4.7 Page ownership

Coordination metadata associating a browser target or tab with an agent connection. Page ownership reduces accidental interference but is not a security boundary.

### 4.8 Automation lease

A renewable, time-bounded authorization allowing one agent connection to issue mutating page actions or terminal commands. Several trusted agents may hold automation leases concurrently. A human-control lease preempts all automation leases in the workspace.

### 4.9 Human-control lease

A workspace-wide, exclusive lease that pauses mutating agent actions while an operator controls the remote desktop.

### 4.10 Page-oriented capability

An MCP operation classified in a versioned, explicit allowlist as suitable for ordinary page inspection or interaction. Tool names or versions not classified by the allowlist are denied by default. Some page tools, especially script evaluation, are dual-use and require separately configurable permission.

## 5. Stakeholders and actors

| Actor | Responsibilities |
|---|---|
| Local administrator | Installs the system, creates users and roles, configures storage/network policy, updates images, and diagnoses failures. |
| Workspace owner | Creates, starts, stops, exports, and deletes authorized workspaces. |
| Agent | Uses page-oriented MCP tools, terminal commands, and workspace files to complete browser tasks. |
| Operator | Observes activity and optionally takes exclusive interactive control. |
| Read-only viewer | Views the desktop and sanitized activity without mutating the workspace. |
| BrowserUse Kit control plane | Authenticates clients, routes connections, enforces policy, manages lifecycle, and records events. |

## 6. Assumptions and constraints

1. v1 runs on a native Linux x86-64 host with an OCI runtime compatible with Docker or Podman.
2. The supported deployment envelope is one administrator and approximately three to five concurrent workspaces on a suitably sized host.
3. Agents sharing a workspace are equally trusted with that workspace's authenticated browser session, cookies, storage, and files.
4. Agents requiring confidentiality or security isolation from one another must use different workspaces.
5. The underlying host and persistent-volume implementation are trusted.
6. The host provides sufficient CPU, RAM, disk, and kernel features for Chrome's sandbox.
7. TLS is available for non-loopback access.
8. External agents can use the platform's remote MCP transport and can call HTTP APIs or an equivalent client connector.
9. Website behavior, anti-bot controls, CAPTCHAs, and third-party availability are outside BrowserUse Kit's control.

## 7. System architecture

### 7.1 Logical architecture

```text
External AI agent
  |-- authenticated remote MCP
  |-- authenticated command API
  |-- authenticated file API
  `-- optional structured status events
                    |
                    v
          Public TLS gateway
       workspace-scoped routing
                    |
                    v
+----------------------------------------------------------------+
| Workspace                                                      |
|                                                                |
|  +------------------+       private browser network            |
|  | Control sidecar  |<-----------------------------------+     |
|  | - token checks   |           CDP / gated VNC          |     |
|  | - MCP transport  |                                    |     |
|  | - leases/input   |                                    |     |
|  | - audit/events   |                                    |     |
|  +--------+---------+                                    |     |
|           | command protocol                             |     |
|  +--------v---------+   no browser/display network  +----v--+  |
|  | Utility container|                            | Browser |  |
|  | non-root commands|                            | runtime |  |
|  +------------------+                            +--------+  |
|                                                                |
| profile volume | workspace-files volume | protected event data |
+----------------------------------------------------------------+
                    |
                    v
       controlled outbound network proxy
```

### 7.2 Viewer stack

The v1 reference viewer stack shall be:

```text
Headful Chrome
  -> virtual X display
  -> lightweight window manager
  -> VNC server
  -> trusted server-side input gate
  -> websockify
  -> noVNC client over authenticated HTTPS/WSS
```

Chrome shall not use headless mode for operator-visible sessions. Headless operation may be evaluated later for workspaces that explicitly do not require viewing or takeover.

### 7.3 MCP topology

The official Chrome DevTools MCP package uses stdio. BrowserUse Kit shall add a remote authenticated transport without exposing raw CDP:

```text
External MCP client
  <-> authenticated remote MCP transport
  <-> control sidecar
  <-> per-agent official Chrome DevTools MCP subprocess over stdio
  <-> private CDP
  <-> Chrome
```

The recommended remote MCP transport for v1 is MCP Streamable HTTP, subject to compatibility with supported agent clients.

### 7.4 Public routing

The preferred deployment exposes one workspace-scoped origin per workspace:

```text
https://<workspace-id>.<base-domain>/
```

That origin may provide authenticated viewer, MCP, event, file, command, and lifecycle routes. Internal CDP, VNC, command-executor, and supervisor ports shall not be published.

### 7.5 Container grouping

A logical workspace shall use:

- one browser runtime container;
- one isolated utility container for agent commands;
- one control sidecar;
- a browser-private network reachable by only the runtime and control sidecar;
- a separately controlled utility egress network that cannot reach browser-private services;
- one profile volume mounted only by the browser runtime;
- one workspace-files volume mounted only at approved paths by the browser runtime, utility container, and control sidecar;
- protected event storage unavailable to the runtime and utility identities.

A central gateway may perform TLS termination and route requests, but authorization shall remain workspace-aware and fail closed. The utility container shall not share the browser runtime's network, PID, IPC, or display namespaces.

## 8. Data model

### 8.1 Workspace record

At minimum, a workspace record shall contain:

- immutable workspace identifier;
- human-readable name;
- owner identifier;
- creation and update timestamps;
- desired and observed lifecycle state;
- profile and file volume identifiers;
- browser/runtime image identifier;
- resolved Chrome and MCP versions;
- network-policy identifier;
- resource limits;
- inactivity timeout and keep-alive state;
- retention setting;
- active human-control lease, if any;
- active agent connections and leases;
- failure status and last diagnostic reason.

### 8.2 Agent connection record

At minimum:

- connection identifier;
- authenticated subject;
- workspace identifier;
- permissions;
- connection and expiry timestamps;
- owned page identifiers;
- lease state;
- last activity time;
- disconnect reason.

### 8.3 Page ownership record

At minimum:

- browser target identifier;
- owning agent connection or durable reconnect identity;
- opener target, when known;
- creation time;
- ownership state: `owned`, `unowned`, or `operator-controlled`;
- last known URL, sanitized according to logging policy.

### 8.4 Activity event

At minimum:

- event identifier;
- workspace identifier;
- timestamp;
- source type: `agent`, `operator`, `browser`, `command`, or `system`;
- source identifier;
- event type;
- sanitized summary;
- status and duration where applicable;
- links to permitted artifacts such as screenshots;
- correlation identifier for related actions.

Raw cookies, bearer tokens, authorization headers, secret values, and hidden model reasoning shall not be intentional activity-event fields.

## 9. Workspace lifecycle

### 9.1 States

Lifecycle and activity shall be represented as orthogonal fields. The lifecycle state shall be one of:

- `created`: durable record and storage exist; runtime has not started;
- `starting`: runtime and control services are being prepared;
- `ready`: browser, viewer, MCP, command, and input-gate health checks pass;
- `stopping`: graceful shutdown is in progress;
- `stopped`: runtime is absent; durable data remains;
- `recovering`: bounded automatic recovery is in progress;
- `failed`: operator action is required;
- `deleting`: access is revoked and resources are being removed;
- `deleted`: resources are no longer available.

A `ready` workspace shall separately report activity as `active` or `idle`. An open but inactive MCP or event connection does not by itself prevent idling; a request, command, transfer, human-control lease, configured viewer keep-alive, or renewable task keep-alive does.

### 9.2 Startup

The system shall:

1. Acquire an exclusive profile-runtime lock.
2. Refuse to start a second Chrome process against the same profile.
3. Create or attach only the workspace's assigned volumes and private network.
4. Start Chrome as a non-root browser user with a non-default `--user-data-dir`.
5. Start CDP only on a private interface or shared network namespace.
6. Start the viewer and utility container without publishing their raw ports.
7. Verify that the utility container cannot reach CDP, VNC, the X socket, the Chrome profile, or control credentials.
8. Start the trusted viewer input gate in deny-input mode.
9. Run readiness checks before reporting `ready`.
10. Record the actual Chrome, MCP, image, configuration, and locked build-manifest versions.

### 9.3 Inactivity

A workspace is inactive only when all of the following are true:

- no mutating or read-only MCP request is in progress;
- no terminal command is running;
- no file transfer is active;
- no human-control lease is active;
- no connected viewer is configured to keep the workspace alive;
- no renewable task keep-alive lease is active.

Webpage background network traffic shall not count as workspace activity.

The default inactivity timeout should be 60 minutes and shall be administrator-configurable or disableable.

### 9.4 Shutdown

Before stopping a runtime, the system shall:

1. Warn connected clients and emit a shutdown-pending event.
2. Stop accepting new mutating operations.
3. Allow bounded completion or cancellation of active operations.
4. Request graceful Chrome shutdown.
5. Flush event and file metadata.
6. Stop runtime services.
7. Release the profile lock only after Chrome exits.

The system shall preserve the profile and files. It shall promise only best-effort restoration of tabs and no restoration of arbitrary in-memory page state.

### 9.5 Recovery

The system shall attempt bounded automatic recovery after an unexpected Chrome or runtime failure. The default policy should allow no more than three attempts in ten minutes. Repeated failure shall transition the workspace to `failed`, preserve diagnostics, and stop retrying.

### 9.6 Deletion

Deletion shall:

- revoke workspace credentials and leases first;
- disconnect agents and viewers;
- stop the runtime;
- remove profile and file volumes selected for deletion;
- remove retained logs and screenshots according to policy;
- leave an administrative deletion audit record that contains no deleted workspace secrets.

The documentation shall state that secure physical erasure depends on the host filesystem and storage backend.

## 10. Functional requirements

Requirement keywords **SHALL**, **SHOULD**, and **MAY** are normative.

### 10.1 Workspace management

- **FR-WS-001:** An authorized owner SHALL be able to create, list, inspect, start, stop, and delete workspaces.
- **FR-WS-002:** Every workspace SHALL have a unique immutable identifier and one dedicated Chrome profile.
- **FR-WS-003:** Workspace data SHALL survive runtime-container replacement when its volumes survive.
- **FR-WS-004:** Workspace data SHALL survive host reboot when the container runtime and volumes survive.
- **FR-WS-005:** v1 SHALL retain workspaces until explicit deletion; automatic expiration is not part of v1.
- **FR-WS-006:** The system SHALL expose desired state separately from observed runtime state.
- **FR-WS-007:** Concurrent lifecycle requests SHALL be serialized or rejected with a conflict response.
- **FR-WS-008:** Only one Chrome process SHALL use a workspace profile at a time.
- **FR-WS-009:** An owner SHOULD be able to export workspace files and documented profile backup artifacts before deletion.

### 10.2 Browser runtime

- **FR-BR-001:** v1 SHALL run the stable Google Chrome Linux build in headful mode on a virtual display.
- **FR-BR-002:** Chrome SHALL run as a dedicated non-root user with Chrome's sandbox enabled.
- **FR-BR-003:** The runtime SHALL use a non-default, workspace-specific Chrome user-data directory.
- **FR-BR-004:** Chrome account sync SHALL be disabled by default.
- **FR-BR-005:** Extension installation SHALL be disabled by default.
- **FR-BR-006:** Downloads SHALL be directed to the workspace download directory.
- **FR-BR-007:** Upload operations SHALL accept files only from authorized workspace paths.
- **FR-BR-008:** Popups and newly opened pages SHALL be detected and assigned ownership metadata.
- **FR-BR-009:** Browser-global administrative operations SHALL require an explicit `browser:admin` permission and SHALL be audited.
- **FR-BR-010:** Ordinary agents SHALL receive only the configured page-oriented MCP capability set.
- **FR-BR-011:** Clipboard access SHALL require permission and SHOULD be disabled by default.
- **FR-BR-012:** Browser policy SHALL be administrator-configurable without modifying the durable profile by hand.

### 10.3 MCP access

- **FR-MCP-001:** An external agent SHALL be able to establish an authenticated remote MCP session scoped to one workspace.
- **FR-MCP-002:** The public endpoint SHALL NOT expose raw CDP.
- **FR-MCP-003:** The control sidecar SHALL connect to Chrome over a private network path.
- **FR-MCP-004:** The control sidecar SHALL run or supervise a distinct stdio Chrome DevTools MCP process for each active agent MCP session unless a tested multiplexing design provides equivalent state separation.
- **FR-MCP-005:** The gateway SHALL expose only tools present in a versioned, explicit capability allowlist to ordinary agents.
- **FR-MCP-006:** Tool discovery and tool calls SHALL be filtered according to the caller's permissions; unknown, renamed, newly introduced, and unclassified upstream tools SHALL be denied by default.
- **FR-MCP-007:** MCP calls SHALL fail closed when token validation, workspace routing, capability classification, policy lookup, durable audit availability, or lease validation fails.
- **FR-MCP-008:** Agent reconnection SHALL use a durable reconnect identity and a new short-lived credential.
- **FR-MCP-009:** Tool-call metadata and outcome SHALL produce sanitized activity events.
- **FR-MCP-010:** MCP results containing page content SHALL not be retained by default beyond operationally necessary buffers.
- **FR-MCP-011:** The system SHALL clearly document that tool filtering and page ownership are coordination guardrails, not hostile isolation inside a shared profile.
- **FR-MCP-012:** Dual-use tools, including arbitrary page-script evaluation, SHALL be separately classified and disabled unless the caller has the corresponding permission.
- **FR-MCP-013:** Capability mappings SHALL identify the exact supported MCP package version and SHALL be revalidated before a new package version is released.
- **FR-MCP-014:** An agent SHALL acquire an automation lease before its first mutating MCP call or terminal command.
- **FR-MCP-015:** Automation leases SHALL be scoped to workspace and agent connection, renewable, revocable, and expire after a configurable default of 60 seconds without renewal.
- **FR-MCP-016:** Several trusted agents MAY hold concurrent automation leases; a pending or active human-control lease SHALL prevent new automation leases and preempt existing leases.
- **FR-MCP-017:** Lease acquisition, renewal, revocation, expiry, and contention SHALL emit mandatory audit events.
- **FR-MCP-018:** Reconnection SHALL not restore mutation rights until authentication and automation-lease acquisition both succeed.

### 10.4 Concurrent agents and page ownership

- **FR-PG-001:** A workspace MAY host multiple concurrent, mutually trusted agents.
- **FR-PG-002:** Each newly connected agent SHALL receive or claim an initial page.
- **FR-PG-003:** Pages and popups created by an agent SHOULD inherit that agent's ownership.
- **FR-PG-004:** Ownership SHOULD survive temporary disconnect until a configurable reconnect lease expires.
- **FR-PG-005:** The UI and event stream SHALL identify the recorded owner of each page.
- **FR-PG-006:** v1 MAY treat page ownership as advisory and SHALL audit apparent cross-owner selection or mutation when detectable.
- **FR-PG-007:** Agents SHALL be warned that cookies, local storage, service workers, downloads, permissions, and authenticated sessions are shared throughout a workspace.
- **FR-PG-008:** Agents needing confidentiality from one another SHALL use separate workspaces.
- **FR-PG-009:** An authorized operator SHALL be able to transfer or clear page ownership.
- **FR-PG-010:** A closed or crashed page SHALL invalidate its ownership record without reassigning a reused target identifier incorrectly.

### 10.5 Terminal and commands

- **FR-CMD-001:** An authorized external agent SHALL be able to execute non-root commands in its workspace through an authenticated command interface.
- **FR-CMD-002:** Agent commands SHALL run as an unprivileged user in the dedicated utility container, distinct from browser-runtime and control-sidecar identities.
- **FR-CMD-003:** The command environment SHALL NOT expose sudo, the host container-runtime socket, host root mounts, control-plane credentials, unrestricted Linux capabilities, the Chrome profile, CDP, VNC, X/display sockets, or browser/control process namespaces.
- **FR-CMD-004:** Commands SHALL have administrator-configurable CPU, memory, process-count, output-size, and duration limits.
- **FR-CMD-005:** The command interface SHALL support cancellation and SHALL terminate abandoned process groups after a bounded grace period.
- **FR-CMD-006:** Each agent SHOULD receive `/workspace/agents/<agent-id>` as its default working directory.
- **FR-CMD-007:** Shared files MAY be placed under `/workspace/common`.
- **FR-CMD-008:** Inputs, outputs, and browser downloads SHALL be represented under `/workspace/input`, `/workspace/output`, and `/workspace/downloads`.
- **FR-CMD-009:** The Chrome profile SHALL not be exposed as an ordinary writable agent working directory.
- **FR-CMD-010:** Command, working directory, start time, duration, exit status, and bounded sanitized output SHALL be recorded as activity events.
- **FR-CMD-011:** Editable shell history SHALL NOT be used as the authoritative audit log.
- **FR-CMD-012:** Concurrent commands SHALL be associated with their initiating agent.
- **FR-CMD-013:** The command service SHALL be private; agents SHALL reach it only through the authenticated control plane.

### 10.6 File management

- **FR-FILE-001:** Authorized clients SHALL be able to list, upload, download, and delete files within permitted workspace paths.
- **FR-FILE-002:** File APIs SHALL reject path traversal, unauthorized symlink traversal, device files, and paths outside allowed roots.
- **FR-FILE-003:** Upload size, workspace quota, and per-file limits SHALL be configurable.
- **FR-FILE-004:** Uploads and replacements SHALL write to quota-accounted temporary files and commit by atomic rename within the same filesystem; interrupted operations SHALL leave either the prior complete file or the new complete file, never a partial replacement.
- **FR-FILE-005:** Browser downloads SHALL be attributed to an initiating agent/page when detectable.
- **FR-FILE-006:** Optional host bind mounts SHALL require explicit trusted-administrator configuration and SHALL not be selected through an unprivileged API.
- **FR-FILE-007:** On quota or storage failure, file mutation SHALL fail explicitly, preserve the last committed file and metadata state, and remove or quarantine incomplete temporary data; deletion SHALL be idempotent.
- **FR-FILE-008:** Files supplied to MCP upload tools SHALL be constrained to approved workspace roots.

### 10.7 Human viewing and takeover

- **FR-VIEW-001:** An authorized viewer SHALL be able to see the headful Chrome desktop through noVNC in a web browser.
- **FR-VIEW-002:** Viewer access SHALL use authenticated HTTPS/WSS through the public gateway.
- **FR-VIEW-003:** Raw VNC SHALL not be publicly exposed.
- **FR-VIEW-004:** View-only and interactive-control permissions SHALL be distinct and enforced by a trusted server-side input gate; a noVNC client-side setting alone SHALL NOT be treated as authorization.
- **FR-VIEW-005:** An authorized operator SHALL be able to request a human-control lease.
- **FR-VIEW-006:** A human-control lease SHALL cover the entire workspace, regardless of the currently visible tab.
- **FR-VIEW-007:** Before granting human control, the system SHALL reject new mutating MCP calls and terminal commands, allow an in-flight mutation at most 10 seconds to finish, then cancel it or fail the takeover; mutating requests SHALL not be queued for replay.
- **FR-VIEW-008:** Passive event delivery and observation MAY continue during human control.
- **FR-VIEW-009:** Agents SHALL not resume mutation until the human-control lease is explicitly released, revoked, or expires; they must then reacquire an automation lease.
- **FR-VIEW-013:** The server-side input gate SHALL validate authentication, interactive permission, and the active human-control lease before forwarding every keyboard, mouse, or clipboard input event, and SHALL fail closed immediately when validation is unavailable.
- **FR-VIEW-014:** A human-control lease SHALL default to 30 seconds, require renewal while active, and stop accepting input within 5 seconds of expiry, revocation, or credential invalidation.
- **FR-VIEW-010:** Takeover, release, expiry, and emergency cancellation SHALL be audited.
- **FR-VIEW-011:** The operator UI SHOULD provide a terminal-style popup or panel showing authoritative command events and live bounded output.
- **FR-VIEW-012:** Interactive operator shell execution, if enabled, SHALL require a separate permission.

### 10.8 Activity, status, and screenshots

- **FR-EVT-001:** The UI SHALL present a chronological activity timeline containing system lifecycle, MCP, command, browser, agent-status, and operator events.
- **FR-EVT-002:** External agents MAY post authenticated structured status events.
- **FR-EVT-003:** Supported status types SHOULD include `task_started`, `status`, `decision`, `waiting_for_human`, `task_completed`, and `task_failed`.
- **FR-EVT-004:** Structured agent events SHALL be labeled as agent-authored claims, not independently verified facts.
- **FR-EVT-005:** BrowserUse Kit SHALL NOT claim to capture an external agent's stdout unless that agent explicitly forwards it.
- **FR-EVT-006:** BrowserUse Kit SHALL NOT request, infer, or store hidden chain-of-thought reasoning.
- **FR-EVT-007:** The system SHOULD support screenshots before and after mutating browser actions when enabled.
- **FR-EVT-008:** Optional content capture—including screenshots, page text, raw MCP arguments/results, and extended command output—SHALL be disableable per workspace.
- **FR-EVT-009:** Optional content retention and screenshot retention SHALL be configurable; mandatory minimal security audit metadata SHALL remain enabled.
- **FR-EVT-010:** Activity-stream clients SHALL be able to resume from a last-seen event identifier or receive an explicit gap indication.

### 10.9 Authentication and authorization

- **FR-AUTH-001:** Non-loopback public access SHALL require TLS.
- **FR-AUTH-002:** v1 SHALL support local administrator bootstrap through a one-time CLI workflow.
- **FR-AUTH-003:** v1 SHALL support administrator login through the web UI after bootstrap.
- **FR-AUTH-004:** Passwords SHALL be stored only as suitable salted password hashes.
- **FR-AUTH-005:** Access credentials SHALL be short-lived and scoped by subject, audience, workspace, permissions, expiry, and unique token identifier.
- **FR-AUTH-006:** Credentials SHALL be revocable.
- **FR-AUTH-007:** Administrators SHALL be able to define roles from available permissions.
- **FR-AUTH-008:** Initial permissions SHALL distinguish at least viewing, automation, file access, shell access, takeover, browser administration, and workspace management.
- **FR-AUTH-009:** Authorization SHALL be checked at every public operation, not only at initial connection.
- **FR-AUTH-010:** Viewer authentication SHALL not grant MCP, shell, or file mutation implicitly.
- **FR-AUTH-011:** Expired or revoked credentials SHALL stop new requests immediately and terminate or disable open MCP, event, command, and viewer sessions within 5 seconds.
- **FR-AUTH-012:** Secrets SHALL not be placed in URLs where they can leak through browser history or referrer data.
- **FR-AUTH-013:** Administrator web sessions SHALL use Secure, HttpOnly, host-only cookies with an explicit SameSite policy, rotate identifiers after authentication or privilege change, and enforce inactivity and absolute expiry.
- **FR-AUTH-014:** State-changing browser requests SHALL use CSRF protection in addition to SameSite cookies.
- **FR-AUTH-015:** Login and token-issuance endpoints SHALL implement rate limits, progressive delay, and security audit events without revealing whether an account exists.
- **FR-AUTH-016:** The gateway SHALL validate the exact `Host` value against configured DNS-safe workspace identifiers and SHALL reject unknown or ambiguous hosts.
- **FR-AUTH-017:** Parent-domain authentication cookies SHALL NOT be shared across workspace subdomains.

### 10.10 Network policy

- **FR-NET-001:** Chrome in the browser runtime and commands in the utility container SHALL use a controlled outbound proxy or equivalent policy enforcement point.
- **FR-NET-002:** Browser-runtime and utility-container networks SHALL be prevented from bypassing the policy enforcement point through direct egress.
- **FR-NET-003:** The default policy SHALL allow public Internet destinations while denying loopback, private, link-local, host, control-plane, and cloud metadata destinations.
- **FR-NET-004:** The policy SHALL cover IPv4 and IPv6.
- **FR-NET-005:** Destination checks SHALL account for redirects and DNS rebinding.
- **FR-NET-006:** Administrators MAY define stricter domain allowlists or explicitly permit selected private destinations for trusted workspaces.
- **FR-NET-007:** Policy denials SHALL produce actionable, sanitized errors and audit events.
- **FR-NET-008:** The runtime SHALL not be able to access another workspace's private network.
- **FR-NET-009:** The control sidecar SHALL expose only the minimum required private services to its browser runtime and SHALL expose none to the utility network unless explicitly required by the command protocol.
- **FR-NET-010:** v1 SHALL proxy or explicitly permit HTTP, HTTPS, and WebSocket traffic; direct DNS, UDP, QUIC, WebRTC, raw sockets, and unsupported schemes SHALL be denied by default.
- **FR-NET-011:** DNS resolution SHALL occur through the policy enforcement point, and container firewall rules SHALL block alternate resolvers and direct egress.
- **FR-NET-012:** Enabling a denied protocol SHALL require an explicit administrator policy and equivalent destination validation.

### 10.11 Version and image management

- **FR-VER-001:** v1 MAY resolve current upstream Chrome and MCP versions during a release image build.
- **FR-VER-002:** Every built image SHALL record the resolved Debian base, Chrome, Chrome DevTools MCP, noVNC, VNC server, and gateway versions.
- **FR-VER-003:** A published image SHALL be immutable and identifiable by content digest.
- **FR-VER-004:** Existing running workspaces SHALL not be silently mutated when a newer upstream package appears.
- **FR-VER-005:** Every release image SHALL pass browser startup, MCP connection, viewer, profile persistence, and file workflow tests before being marked supported.
- **FR-VER-006:** Version incompatibility SHALL produce a diagnostic failure rather than exposing raw CDP as a workaround.
- **FR-VER-007:** Every release SHALL retain a machine-readable build manifest and artifact references sufficient to retrieve or rebuild the exact supported image, even when upstream versions were initially resolved as `latest`.

## 11. Security requirements

### 11.1 Trust boundaries

1. The workspace is the minimum browser/profile trust boundary.
2. Tabs are coordination units, not security boundaries.
3. All agents sharing a workspace can potentially access the workspace's authenticated sites and browser state.
4. Different workspaces shall not share profiles, volumes, runtime identities, private networks, or CDP endpoints.
5. The agent-accessible utility container is untrusted relative to the browser runtime, control sidecar, and host.
6. The utility container shall have no path to CDP, VNC, the X display, the Chrome profile, control credentials, or browser/control process namespaces.
7. CDP is a privileged administrative interface and shall remain private.

### 11.2 Container hardening

- **SEC-CTR-001:** Runtime and control processes SHALL run as non-root users.
- **SEC-CTR-002:** Chrome's sandbox SHALL remain enabled; `--no-sandbox` SHALL not be used in supported deployments.
- **SEC-CTR-003:** Containers SHALL drop unnecessary Linux capabilities and set `no-new-privileges` where supported.
- **SEC-CTR-004:** Containers SHALL use a maintained seccomp policy compatible with Chrome's sandbox.
- **SEC-CTR-005:** Root filesystems SHOULD be read-only except for explicitly mounted writable paths.
- **SEC-CTR-006:** Containers SHALL have CPU, memory, process, and storage limits.
- **SEC-CTR-007:** No workspace container SHALL receive the Docker or Podman socket.
- **SEC-CTR-008:** No workspace container SHALL receive unrestricted host filesystem mounts.
- **SEC-CTR-009:** Rootless container execution SHOULD be supported and recommended, but it is not a v1 hard requirement.
- **SEC-CTR-010:** Inter-workspace communication SHALL be denied by default.
- **SEC-CTR-011:** Supported Chrome sandboxing SHALL use the documented Linux user-namespace sandbox or setuid sandbox configuration; release documentation SHALL state required kernel sysctls, seccomp allowances, mount permissions, and Docker/Podman runtime options.
- **SEC-CTR-012:** Startup SHALL fail rather than silently adding `--no-sandbox` when host prerequisites are missing.

### 11.3 Browser profile protection

- **SEC-PROF-001:** The Chrome profile SHALL use restrictive filesystem ownership and permissions.
- **SEC-PROF-002:** A profile SHALL never be attached read/write to two Chrome processes simultaneously.
- **SEC-PROF-003:** BrowserUse Kit SHALL never point agent-controlled Chrome at the host user's normal Chrome profile.
- **SEC-PROF-004:** Cookies, browser storage, downloaded files, and profile backups SHALL be treated as secrets.
- **SEC-PROF-005:** Profile export SHALL require explicit authorization and warning.

### 11.4 Logging and redaction

- **SEC-LOG-001:** Authentication credentials, raw cookies, authorization headers, and secret-injection values SHALL not be intentionally logged.
- **SEC-LOG-002:** Configured sensitive request headers SHALL be redacted before retention.
- **SEC-LOG-003:** Command output and MCP argument logging SHALL be bounded and sanitizable.
- **SEC-LOG-004:** Operators SHALL be warned that screenshots and page text can contain secrets that automated redaction cannot reliably remove.
- **SEC-LOG-005:** Optional content capture and screenshots SHALL be disableable per workspace; disabling them SHALL NOT disable minimal security audit metadata.
- **SEC-LOG-006:** Audit events SHALL be protected from modification by browser-runtime and utility identities.
- **SEC-LOG-007:** Minimal non-disableable audit metadata SHALL include authentication outcomes, permission denials, lease changes, mutating MCP tool name and status, command identity and status, network-policy denials, takeover input state, lifecycle changes, and deletion events; it SHALL exclude secret values and raw page content.
- **SEC-LOG-008:** If durable audit storage is unavailable, new mutating MCP calls, commands, file mutations, lease changes, and lifecycle mutations SHALL fail closed. Existing view-only sessions and health/status reads MAY continue. The system SHALL alert the operator and resume mutation only after durable audit writes succeed.

## 12. User interface requirements

The v1 web UI shall provide:

1. Workspace list with status, owner, activity, and resource summary.
2. Create, start, stop, restart, and delete operations subject to permission.
3. noVNC browser/desktop viewer.
4. Clear view-only versus interactive-control state.
5. Human-control request, grant, release, and emergency-stop controls.
6. Activity timeline with filters for agent, MCP, command, browser, operator, and system events.
7. Agent/page ownership display.
8. Screenshot thumbnails and detail view when capture is enabled.
9. Terminal-style command-history popup with live bounded output.
10. File browser for permitted workspace directories.
11. Credential/session management appropriate to local v1.
12. Clear warnings when a workspace is shared by multiple agents.
13. Failure diagnostics and bounded recovery status.
14. Visible indication of logging, screenshot, clipboard, and network policy.

The UI need not provide billing, analytics dashboards, organization management, or multi-host scheduling in v1.

## 13. External interfaces

Exact paths are implementation decisions, but v1 shall expose equivalent capabilities.

### 13.1 Workspace lifecycle interface

Operations:

- create workspace;
- inspect workspace;
- list authorized workspaces;
- start, stop, restart, and delete workspace;
- renew or release keep-alive;
- inspect health and failure diagnostics.

### 13.2 MCP interface

- authenticated remote MCP session;
- workspace-scoped tool discovery;
- page-oriented tool invocation;
- acquire, renew, inspect, and release an automation lease;
- lease- and takeover-aware errors;
- connection resume or clean reconnect semantics without implicit mutation rights.

### 13.3 Command interface

- start command;
- stream bounded stdout/stderr;
- inspect status;
- cancel command;
- retrieve retained sanitized result.

### 13.4 File interface

- list directory;
- upload file;
- download file;
- delete file;
- inspect quota and metadata.

### 13.5 Event interface

- consume ordered activity events;
- resume from cursor;
- post authenticated structured agent-status events;
- indicate retention gaps.

### 13.6 Viewer interface

- authenticated noVNC bootstrap;
- view-only session;
- interactive session when a human-control lease is held;
- explicit lease state and expiration.

## 14. Primary use cases

### UC-01: Create and start a workspace

**Actor:** Workspace owner<br>
**Preconditions:** Owner is authenticated and has quota.
**Flow:**

1. Owner supplies a name and optional policy overrides.
2. System creates workspace metadata and durable volumes.
3. System starts the control sidecar, browser runtime, and isolated utility container.
4. Chrome starts against the dedicated profile.
5. Viewer, MCP, command, and policy checks pass.
6. Workspace becomes `ready`.

**Success:** The owner receives workspace metadata and scoped connection options.<br>
**Failure:** The system reports a diagnostic state and does not claim readiness.

### UC-02: External agent connects and browses

**Actor:** Agent<br>
**Preconditions:** Workspace is ready; agent has an unexpired automation credential.
**Flow:**

1. Agent opens a remote MCP session.
2. Sidecar validates workspace and permissions.
3. Sidecar starts a per-session stdio MCP subprocess.
4. Agent acquires a renewable automation lease.
5. Agent receives explicitly allowlisted page-oriented tools and an assigned page.
6. Agent navigates and interacts with the page.
7. System records mandatory audit metadata and optional content/screenshots.

**Success:** Agent completes page actions without direct CDP access.

### UC-03: Trusted agents use separate tabs concurrently

**Actors:** Two or more agents<br>
**Preconditions:** All agents are trusted with the shared profile.
**Flow:**

1. Each agent authenticates separately.
2. Each receives an initial page and ownership metadata.
3. Agents act concurrently on their recorded pages.
4. Popups inherit ownership where detectable.
5. Cross-owner interactions generate warnings or audit events when detectable.

**Success:** Agents make progress concurrently.<br>
**Caveat:** Shared cookies, storage, browser process, and files remain visible within the trust boundary.

### UC-04: Agent prepares and uploads a PDF

**Actor:** Agent<br>
**Preconditions:** Agent has shell and file permissions.
**Flow:**

1. Agent uploads or obtains source material in its workspace directory.
2. Agent invokes a non-root command to create or transform a PDF.
3. Command output appears in the activity timeline.
4. Agent uses a page-oriented browser upload tool with the resulting approved path.
5. System records file and browser action metadata.

**Success:** The browser uploads the generated PDF without exposing arbitrary host paths.

### UC-05: Human observes an agent

**Actor:** Viewer/operator

**Flow:**

1. Human opens the workspace UI.
2. Human watches the noVNC stream in view-only mode.
3. Human reviews MCP activity, agent statuses, screenshots, and command history.
4. Agent continues operating uninterrupted.

### UC-06: Human takes control

**Actor:** Operator<br>
**Preconditions:** Operator has takeover permission.
**Flow:**

1. Operator requests control.
2. System blocks new mutating MCP calls and terminal commands.
3. In-flight actions settle or are cancelled according to policy.
4. System grants a workspace-wide human-control lease.
5. Operator uses keyboard and mouse through noVNC.
6. Operator releases control.
7. System records the intervention and resumes eligible agents.

### UC-07: Agent reconnects

**Actor:** Agent

**Flow:**

1. Agent connection drops.
2. Owned pages remain reserved until reconnect lease expiry.
3. Agent obtains a fresh short-lived credential.
4. Agent reconnects with its durable reconnect identity.
5. Sidecar restores ownership metadata and starts a fresh MCP subprocess.

### UC-08: Idle workspace stops and restarts

**Actors:** System, agent

**Flow:**

1. Workspace has no qualifying activity for the configured timeout.
2. System warns clients and gracefully stops Chrome/runtime.
3. Volumes remain.
4. A later agent request starts the workspace.
5. Chrome reuses the profile and attempts normal session restoration.

**Success:** Cookies, supported browser storage, and files remain; exact page memory is not guaranteed.

### UC-09: Delete a workspace

**Actor:** Workspace owner

**Flow:**

1. Owner requests deletion and confirms destructive impact.
2. System revokes credentials and disconnects clients.
3. Runtime stops.
4. Selected profile, file, screenshot, and activity data are removed.
5. System retains a minimal administrative deletion event.

## 15. Non-functional requirements

### 15.1 Performance

On a documented reference host, v1 should meet these acceptance targets:

- **NFR-PERF-001:** A cold workspace becomes ready within 30 seconds under normal local conditions.
- **NFR-PERF-002:** Viewer interaction latency remains below 300 ms on a local-area network, excluding client rendering anomalies.
- **NFR-PERF-003:** MCP gateway dispatch overhead remains below 1 second at the 95th percentile, excluding browser/page work and network destination latency.
- **NFR-PERF-004:** Five concurrent idle workspaces do not cause host instability on the documented reference host.
- **NFR-PERF-005:** Activity events become visible in the UI within 2 seconds under normal load.

The release test report shall identify host CPU, memory, storage, kernel, container runtime, client/browser versions, network topology, workspace/page workload, warm-up, sample count, percentile method, and measurement endpoints. Startup shall be measured from accepted start request to `ready`; viewer latency from input-gate receipt to visible frame; MCP overhead from gateway receipt to MCP-subprocess dispatch. These are acceptance targets, not public availability or latency SLAs.

### 15.2 Resource management

Default limits should be administrator-configurable and initially target:

- 2 CPU cores per active workspace;
- 2–4 GiB memory per active workspace;
- 10 GiB workspace storage;
- 1920x1080 maximum display resolution;
- bounded process count;
- bounded command duration and output;
- one Chrome window with multiple tabs.

Exceeding a resource limit shall produce an explicit event and diagnostic outcome rather than silently affecting other workspaces.

### 15.3 Reliability

- **NFR-REL-001:** Control-sidecar failure SHALL not expose browser-runtime or utility-private services.
- **NFR-REL-002:** Runtime failure SHALL not delete durable volumes.
- **NFR-REL-003:** Audit events acknowledged as durable SHALL survive runtime restart.
- **NFR-REL-004:** Recovery loops SHALL be bounded.
- **NFR-REL-005:** Operations SHALL be idempotent where clients are expected to retry them.

### 15.4 Compatibility

- **NFR-COMP-001:** v1 acceptance testing SHALL cover native Linux x86-64.
- **NFR-COMP-002:** v1 SHALL support at least one documented current Podman version and one Docker-compatible runtime configuration.
- **NFR-COMP-003:** Container build and test commands used during development SHOULD use `--rm` where applicable to avoid accumulating stopped containers.
- **NFR-COMP-004:** Persistent test volumes SHALL use unique names and explicit cleanup procedures.

### 15.5 Maintainability and diagnostics

- Every workspace and request shall have correlation identifiers.
- Health checks shall distinguish gateway, sidecar, MCP, CDP, Chrome, display, VNC, command, storage, and proxy failures.
- Version and image metadata shall be available without entering the runtime container.
- Logs shall be structured where practical and bounded by rotation/retention policy.
- Failure messages shall suggest an operator action without revealing secrets.

## 16. Acceptance test suite

### 16.1 Build and startup

| ID | Test | Expected result |
|---|---|---|
| AT-001 | Build the Debian-based image using the documented OCI runtime. | Build succeeds and records all resolved component versions. |
| AT-002 | Start a workspace with disposable test containers using `--rm` where applicable. | Workspace reaches `ready`; no raw CDP, VNC, or command port is published. |
| AT-003 | In each documented Docker and Podman configuration, inspect Chrome's identity, arguments, sandbox diagnostics, and required kernel/runtime settings. | Chrome is non-root, the documented user-namespace or setuid sandbox is active, no `--no-sandbox` fallback occurs, and `--user-data-dir` is non-default and workspace-specific. |
| AT-004 | Attempt to start a second runtime against the same profile. | Start is rejected because the profile lock is held. |
| AT-005 | Start five idle workspaces on the reference host. | Host remains responsive and resource use remains within documented bounds. |

### 16.2 Persistence

| ID | Test | Expected result |
|---|---|---|
| AT-010 | Set a persistent website cookie with a future expiry, create a file, and restart Chrome. | Persistent cookie/profile state and file persist; no claim is made for a non-persistent session cookie. |
| AT-011 | Replace the runtime container while retaining volumes. | Workspace restarts with the same profile and files. |
| AT-012 | Reboot the host with durable volumes configured. | Workspace record and data remain; runtime can restart. |
| AT-013 | Stop after inactivity and start later. | Durable state persists; tab restoration is attempted but not asserted as exact. |
| AT-014 | Delete a workspace. | Credentials are revoked and selected durable data becomes unavailable. |

### 16.3 MCP and page coordination

| ID | Test | Expected result |
|---|---|---|
| AT-020 | Connect an authorized external MCP client and compare discovery with the versioned capability map. | Client receives only explicitly allowlisted tools; an injected unknown or newly introduced tool is denied by default. |
| AT-021 | Attempt unauthenticated remote MCP access. | Request fails without starting an MCP subprocess. |
| AT-022 | Attempt direct host access to CDP. | No public CDP endpoint is reachable. |
| AT-023 | Connect two trusted agents and assign separate tabs. | Both can operate concurrently and ownership appears in the UI. |
| AT-024 | Agent opens a popup. | Popup is detected and inherits ownership when opener data is available. |
| AT-025 | Agent invokes a browser-global or separately classified dual-use operation without permission. | Operation is absent or rejected and a mandatory audit event is emitted. |
| AT-029 | Acquire, renew, expire, revoke, and contend automation leases, including reconnect and human takeover. | State transitions follow the lease rules; mutation never resumes implicitly. |
| AT-026 | Agent disconnects and reconnects before lease expiry. | Fresh MCP process is created and page ownership is restored. |
| AT-027 | Agent reconnects after ownership expiry. | Old ownership is not silently granted. |
| AT-028 | Browser target closes and a new target receives a reused/internal identifier. | Ownership is not incorrectly inherited. |

### 16.4 Terminal and files

| ID | Test | Expected result |
|---|---|---|
| AT-030 | Run a normal command in an agent directory. | Command succeeds as non-root and emits bounded activity/output. |
| AT-031 | From the utility container attempt `sudo`, host-root/container-socket access, CDP/VNC/X access, profile reads, process-namespace access, and control credential reads. | Every path is unavailable or denied while approved workspace files remain usable. |
| AT-032 | Run a command past its timeout. | Entire process group is terminated and timeout is reported. |
| AT-033 | Upload a PDF and select it in a browser file input. | Upload succeeds only from an approved workspace path. |
| AT-034 | Attempt `../` path traversal or symlink escape through file APIs. | Operation is rejected. |
| AT-035 | Exhaust workspace quota during upload/download. | Operation fails explicitly; completed existing files remain consistent. |
| AT-036 | Two agents run commands concurrently. | Commands remain attributable to their initiating agents. |
| AT-037 | Agent edits `.bash_history`. | Authoritative command timeline remains unchanged. |

### 16.5 Viewer and takeover

| ID | Test | Expected result |
|---|---|---|
| AT-040 | Open viewer with view-only permission and send forged keyboard, mouse, and clipboard events outside the noVNC UI. | Video is visible; the server-side input gate denies every input event. |
| AT-041 | Request takeover with appropriate permission. | Workspace-wide control lease is granted after automation pauses. |
| AT-042 | Agent attempts mutation during takeover and submits requests just before release. | Mutations are rejected, never queued, and require a new automation lease after release. |
| AT-043 | Operator switches tabs during takeover. | No agent mutates any tab until workspace control is released. |
| AT-044 | Control lease expires after operator disconnect. | Lease is safely released or escalated per policy and event is recorded. |
| AT-045 | Attempt direct VNC connection from outside the private network. | Connection is unreachable. |

### 16.6 Network security

| ID | Test | Expected result |
|---|---|---|
| AT-050 | Browse a normal public HTTPS site. | Request succeeds through the controlled egress path. |
| AT-051 | Access `127.0.0.1`, host gateway, RFC1918, link-local, or metadata IP from Chrome. | Request is denied unless explicitly authorized. |
| AT-052 | Access the same denied destinations from shell tools. | Request is also denied. |
| AT-053 | Public hostname resolves to a private address after initial validation. | Rebinding attempt is denied. |
| AT-054 | Public URL redirects to a denied address. | Redirect destination is denied. |
| AT-055 | One workspace attempts to reach another workspace's private service. | Connection is denied. |
| AT-056 | Repeat destination tests over IPv6. | Equivalent policy is enforced. |
| AT-057 | Attempt direct DNS, alternate DNS, UDP, QUIC, WebRTC, and raw-socket egress from browser and utility containers. | Traffic is denied by default and cannot bypass the policy enforcement point. |

### 16.7 Authorization and logging

| ID | Test | Expected result |
|---|---|---|
| AT-060 | Use expired, revoked, wrong-audience, or wrong-workspace credentials across new and open HTTP, MCP, event, command, and viewer sessions. | New requests are denied immediately and open sessions lose authority within 5 seconds. |
| AT-061 | Viewer token calls command or MCP mutation endpoint. | Authorization is denied. |
| AT-062 | Submit agent status event. | Event appears labeled as agent-authored. |
| AT-063 | Inspect logs after authenticated browsing. | Raw cookies, authorization headers, and access tokens are absent. |
| AT-064 | Disable screenshots for a workspace. | No new screenshots are retained. |
| AT-065 | Resume event stream from a valid cursor. | Missing events are delivered in order. |
| AT-066 | Resume from an expired cursor. | Client receives an explicit retention-gap response. |
| AT-067 | Exercise administrator login, privilege change, cross-site state-changing requests, repeated failed logins, unknown Host values, and sibling-workspace cookies. | Session rotates appropriately; CSRF, throttling, exact-host checks, and cookie isolation are enforced. |

### 16.8 Failure recovery

| ID | Test | Expected result |
|---|---|---|
| AT-070 | Kill Chrome unexpectedly. | Recovery is attempted within configured bounds; profile remains. |
| AT-071 | Force repeated Chrome startup failure. | Workspace becomes `failed` without an infinite restart loop. |
| AT-072 | Kill an MCP subprocess. | Only that agent session fails or reconnects; raw CDP remains private. |
| AT-073 | Stop the control sidecar. | Public operations fail closed; browser-runtime and utility-private ports remain inaccessible. |
| AT-074 | Make durable audit storage unavailable or full. | New mutations fail closed, view-only/status reads may continue, the operator is alerted, and mutation resumes only after a durable audit write succeeds. |
| AT-075 | Interrupt shutdown during profile flush. | Next startup reports recovery status and preserves diagnostics. |

## 17. Edge cases and required behavior

### 17.1 Browser and profile

- Profile lock remains after an unclean exit: detect stale ownership safely; do not delete a live lock blindly.
- Chrome reports profile corruption: preserve a diagnostic copy or recovery metadata before repair attempts.
- Chrome upgrade changes profile format: prevent silent downgrade to an incompatible browser.
- Chrome remote-debugging endpoint is not ready when MCP starts: retry with bounded backoff and readiness timeout.
- Chrome 136+ ignores debugging on the default profile: always use the dedicated non-default user-data directory.
- Browser opens internal pages or extension targets: do not accidentally assign unsupported targets as normal agent pages.
- Page crashes while an MCP call is active: return a target-lost error and emit an event.
- Popup opens without a detectable opener: mark it unowned for explicit claim.
- Site opens many popups: enforce configurable page limits.
- Download filename collision: use deterministic collision handling without overwriting silently.
- Chrome requests OS keyring integration: use a documented container-compatible configuration without leaking host credentials.

### 17.2 Concurrent agents

- Two agents navigate the same tab despite advisory ownership: record the conflict when detectable; do not claim isolation.
- One agent clears shared cookies: require browser-admin permission where the operation is mediated, while documenting that shared-profile trust remains necessary.
- Two agents write the same shared file: avoid partial writes in platform APIs; application-level semantic conflicts remain possible.
- One agent closes another agent's popup: emit a cross-owner warning when detectable.
- Reconnecting agent and new claimant race for an unowned page: serialize ownership changes.
- Agent credential expires mid-call: define whether the in-flight call completes or is cancelled; no subsequent call may proceed.
- Agent opens an authenticated origin already used by another agent: both are explicitly within the same trust boundary.

### 17.3 Human control

- Takeover requested during a long MCP action: wait at most 10 seconds; if cancellation cannot complete, fail takeover clearly without forwarding input.
- Takeover requested during a non-cancellable file upload: allow at most 10 seconds for an atomic commit or abort; otherwise fail takeover clearly.
- Operator disconnects while holding control: the 30-second renewable lease expires, and the input gate stops forwarding input within 5 seconds of expiry.
- Two operators request control: grant at most one interactive lease; others remain viewers.
- Operator clipboard contains secrets: require explicit clipboard permission and warn before transfer.
- noVNC reconnects after token revocation: revalidate authorization rather than trusting the old browser session indefinitely.

### 17.4 Commands and files

- Command forks background children: track and terminate the associated process group at cancellation or workspace stop.
- Command floods stdout/stderr: truncate or spool within quota without exhausting sidecar memory.
- Command creates a Unix socket, FIFO, device-like entry, or symlink: file APIs handle each safely and do not follow unauthorized paths.
- Uploaded archive expands beyond quota: extraction command is constrained by workspace limits; platform does not assume compressed size is safe.
- Malicious PDF or downloaded executable: treat files as untrusted; do not execute automatically.
- File is deleted while Chrome uploads it: report a deterministic upload failure.
- Browser download remains active at idle timeout: delay shutdown until bounded completion or explicit cancellation.
- Disk becomes read-only or full: stop accepting writes and preserve actionable diagnostics.

### 17.5 Network

- URL embeds alternate numeric IP notation: normalize before policy evaluation.
- DNS returns mixed public/private addresses: deny unsafe destinations and pin or revalidate according to proxy policy.
- HTTP redirect chain changes scheme or port: re-evaluate every destination.
- WebSocket, WebRTC, FTP-like, QUIC, and raw socket behavior: explicitly allow, proxy, or deny each protocol; do not assume HTTP rules cover them.
- Shell starts its own proxy or tunnel: direct egress rules prevent bypass.
- Public site legitimately requires a private callback: administrator must explicitly authorize it.
- Container DNS is unavailable: surface a network diagnostic distinct from policy denial.

### 17.6 Lifecycle and operations

- Start and delete arrive concurrently: deletion wins only after authorization and state serialization; no orphan runtime remains.
- Host reboots during startup or deletion: reconciliation resumes toward desired state.
- Container runtime reports a stale container: reconcile by labels and workspace identity, not name alone.
- TLS certificate expires: reject insecure downgrade and expose an administrator diagnostic.
- System clock changes: token expiry uses secure wall-clock validation; durations and leases should use monotonic clocks where possible.
- New image is incompatible with an old profile: fail safely and retain the old data/image reference for operator recovery.
- Event retention removes records while a viewer is disconnected: return a gap marker on resume.
- Screenshot capture fails: browser automation continues unless policy explicitly requires screenshot evidence.

## 18. Release acceptance criteria

v1 is ready for release only when:

1. Every v1 `SHALL` requirement has implementation and test traceability.
2. Every acceptance test in Section 16 passes on the documented Linux x86-64 reference host. A temporary waiver requires named release-authority approval, written risk and compensating controls, an expiry date, and a tracking issue. Tests covering raw CDP/VNC/command exposure, non-root sandboxing, utility isolation, authentication/authorization, server-side input gating, audit fail-closed behavior, or network-policy bypass are non-waivable.
3. No public listener exposes raw CDP, raw VNC, or the utility command executor.
4. Chrome runs non-root with its sandbox enabled.
5. Profile and file persistence pass Chrome restart, container replacement, and host reboot tests.
6. An external agent can use remote MCP and terminal/file workflows without entering the host container runtime manually.
7. Multiple trusted agents can operate recorded tabs concurrently, with the shared-profile warning visible.
8. Human view-only access and workspace-wide takeover work as specified.
9. Browser and shell network paths both enforce the default egress policy.
10. Credential revocation, workspace deletion, crash-loop bounds, and log redaction tests pass.
11. Actual component versions and image digest are visible in diagnostics.
12. Documentation explains the trust model, resource requirements, backup limitations, and non-goals.

## 19. Future considerations

These items are candidates for later requirements, not v1 commitments:

- ARM64 using Chromium or architecture-specific Chrome builds.
- OIDC/OAuth identity providers.
- Multi-host scheduling and durable external databases.
- Kubernetes deployment.
- Tenant quotas, billing, and organization management.
- Neko/WebRTC or KasmVNC viewer alternatives.
- Audio and microphone forwarding.
- Stronger agent isolation using separate profiles or browser processes.
- Encrypted profile backups and cross-host restore.
- Policy-driven secret injection.
- Exact dependency pinning and automated compatibility promotion channels.
- Optional ephemeral workspaces with automatic retention expiry.
- Browser-context-based density optimization after profiling and security review.

## 20. Design risks

| Risk | Impact | v1 mitigation |
|---|---|---|
| Shared-profile agents interfere with one another | Incorrect actions or data exposure within workspace | Treat all agents in a workspace as equally trusted; use ownership metadata; require separate workspaces for isolation. |
| Remote MCP gateway differs from official stdio deployment | Compatibility and maintenance burden | Keep official MCP subprocess unchanged behind a narrow transport adapter; run compatibility tests. |
| Latest dependencies change behavior | Non-reproducible or broken builds | Retain the exact build manifest and artifact references, record the digest, test every release image, and never mutate existing images. |
| Agent shell attacks browser/control services | Browser or control compromise | Run commands in a separately networked utility container with only approved file mounts and controlled egress. |
| CDP exposure compromises browser data | Full workspace compromise | Private network only; no public CDP; authenticated MCP gateway. |
| Screenshots/logs contain secrets | Sensitive-data retention | Configurable capture, redaction, warnings, restricted permissions, retention controls. |
| Network policy bypass through terminal | Host/internal-network access | Controlled proxy plus blocked direct egress for browser and shell. |
| Idle shutdown loses live page state | Interrupted tasks | Keep-alive leases, warnings, graceful shutdown, honest best-effort restoration guarantee. |
| noVNC interaction is less fluid than WebRTC | Reduced operator experience | Accept for v1 simplicity; measure latency; keep viewer boundary replaceable internally. |

## 21. Source references

Primary technical references informing this specification:

1. Chrome Headless mode: <https://developer.chrome.com/docs/automation-and-testing/headless>
2. Chrome remote-debugging changes: <https://developer.chrome.com/blog/remote-debugging-port>
3. Chrome DevTools Protocol: <https://chromedevtools.github.io/devtools-protocol/>
4. Chrome DevTools MCP: <https://github.com/ChromeDevTools/chrome-devtools-mcp>
5. Chrome DevTools MCP configuration: <https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md>
6. Chrome DevTools MCP advanced usage: <https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md>
7. Chrome DevTools MCP troubleshooting: <https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md>
8. noVNC: <https://github.com/novnc/noVNC>
9. websockify: <https://github.com/novnc/websockify>
10. Neko reference architecture: <https://github.com/m1k1o/neko>
