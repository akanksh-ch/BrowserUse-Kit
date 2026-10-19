# Backend gap closure evidence

Read the complete approved `SRS.md` (sections 1–21). Existing branch commits to preserve/integrate:

- `ea8e91e` — CSRF enforcement and durable workspace token delegation.
- `6126a24` — workspace-authorized revocation and MCP session scoping.

## Token issuance (FR-AUTH-015)

Public delegation now has a durable subject-wide budget: 20 issues per 60-second window, followed by progressively delayed retry penalties (500 ms up to 60 seconds). Rotating a credential or constructing another Auth instance does not reset the subject budget. Denials emit minimal durable `auth.issue_limited` events; audit failure prevents issuance. Trusted internal `Auth.issue()` remains available for bootstrap/login and is not a public API.

**API contract:** both public token-issuance routes can return HTTP 429 with the existing generic `{error}` response. No request/response success shapes changed. Clients should show a retryable error rather than retrying in a tight loop.

Regression was observed failing before implementation (`Missing expected exception`); `npm run check` subsequently passed: TypeScript, 39 passing Node tests, 3 explicitly skipped runtime tests, and 5 Python runtime source checks. The skipped tests cover live OCI commands, live headful MCP, and live x11vnc. These source/unit checks are not proof of live runtime acceptance.

## Remaining integration blockers found (not claimed resolved)

- MCP browser upload is deliberately rejected in composition (`Upload mount routing unavailable`); capability uses `files:upload`, which is not issuable in `PERMISSIONS`. Fix permission and browser-visible mount routing together, with a live PDF test; do not bypass validation by forwarding host paths.
- Composition polls page targets rather than wiring the existing `connectPageOwnership()` observer, so popup/close/reused-target behavior needs live integration.
- Composition does not route MCP activity through lifecycle operation tracking; stop/idling versus in-flight MCP needs integration coverage.
- Event API returns cursor-paged records, but has no retention-gap protocol or streaming delivery.
- Optional screenshots are honestly reported disabled; profile export and browser-download attribution remain absent.

No container, frontend, or Codex CLI files changed. The untracked `node_modules` symlink was preserved.
