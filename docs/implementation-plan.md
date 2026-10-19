# v1 implementation and verification plan

Baseline: SRS.md v0.1. User authorized autonomous implementation and parallel interactive workers; no approval pauses.

## Boundaries

The trusted Linux host orchestrates workspace OCI resources. Browser runtime, utility command runtime, and control service must have distinct identities and isolation. Workspace profile is never mounted into the utility. CDP/VNC/executor have no public listeners. All public mutations require scoped authorization and a durable audit write. Human control blocks agent mutation workspace-wide, revokes automation leases, and gates each RFB input event server-side. Page ownership is coordination, not isolation.

## Parallel ownership

1. Runtime: Debian Chrome/Xvfb/window manager/VNC images, isolated utility, controlled proxy and deployment scripts.
2. Core: SQLite records/audit, authentication, lifecycle and idle/recovery reconciliation.
3. Gateway: official stdio MCP transport, explicit tool permissions, leases, page ownership and trusted input gate.
4. Files: safe atomic quota-accounted transfers and bounded isolated utility commands.
5. UI: small static operator console with noVNC, timeline, files, commands and control state.
6. Server: authenticated HTTP routes, bootstrap, sessions/CSRF, API integration and websocket dispatch.
7. Integration: dependency lock, documentation, cross-module checks, runtime checks and acceptance evidence.

## Gates

- Native Node tests cover authorization, revocation, lease expiry/preemption, unknown tools, RFB input forgery/fragmentation, file traversal/symlinks/quota/atomicity, lifecycle serialization, command limits and audit failure.
- Typecheck every source and test. Run npm audit.
- Run HTTP integration tests including unknown Host, CSRF and unauthorized requests before subprocess creation.
- Build OCI images and test startup/sandbox/private ports/persistence where host permits; never substitute disabled sandbox or exposed CDP when failing.
- Trace SRS acceptance tests explicitly. Unit checks and fake runtimes do not establish container, reboot, Docker, performance or network acceptance.
- Release readiness requires all section 18 criteria. Incomplete environmental acceptance remains clearly documented rather than called passing.

## Observed development host

Native x86-64 Fedora Linux, kernel 7.2.9-201.fc44.x86_64; Node 22.23.1; npm 10.9.8; Podman 5.8.7. `docker` on this host is a Podman compatibility wrapper, not independent Docker Engine coverage. Host has approximately 12 GiB RAM, so five 2–4 GiB workspaces cannot honestly establish capacity on this host. Existing user images and containers must not be cleaned or altered.
