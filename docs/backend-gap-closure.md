# Backend gap closure evidence

Read the complete approved `SRS.md` (sections 1–21). Existing branch commits to preserve/integrate:

- `ea8e91e` — CSRF enforcement and durable workspace token delegation.
- `6126a24` — workspace-authorized revocation and MCP session scoping.

## Token issuance (FR-AUTH-015)

Public delegation now has a durable subject-wide budget: 20 issues per 60-second window, followed by progressively delayed retry penalties (500 ms up to 60 seconds). Rotating a credential or constructing another Auth instance does not reset the subject budget. Denials emit minimal durable `auth.issue_limited` events; audit failure prevents issuance. Trusted internal `Auth.issue()` remains available for bootstrap/login and is not a public API.

**API contract:** both public token-issuance routes can return HTTP 429 with the existing generic `{error}` response. No request/response success shapes changed. Clients should show a retryable error rather than retrying in a tight loop.

Regression was observed failing before implementation (`Missing expected exception`); `npm run check` subsequently passed: TypeScript, 39 passing Node tests, 3 explicitly skipped runtime tests, and 5 Python runtime source checks. The skipped tests cover live OCI commands, live headful MCP, and live x11vnc. These source/unit checks are not proof of live runtime acceptance.

## MCP lifecycle admission (FR-MCP-007, lifecycle §9.3–9.4)

Wired the existing lifecycle operation gate into every gateway tool call (including reads) and tool discovery. Requests hold activity until settlement and release on upstream errors. Once shutdown or reconciliation closes admission, no new upstream request dispatches. The gate does not claim an SDK abort proves browser-side quiescence; lifecycle shutdown waits for settlement or fails at its existing bounded drain deadline.

Regression was observed failing first (`active 0 !== 2`). Final `npm run check`: TypeScript passed, 40 Node tests passed / 3 live tests skipped, and 5 Python checks passed. No additional public API changes.

## Remaining integration blockers found (not claimed resolved)

- MCP browser upload is deliberately rejected in composition (`Upload mount routing unavailable`); capability uses `files:upload`, which is not issuable in `PERMISSIONS`. Fix permission and browser-visible mount routing together, with a live PDF test; do not bypass validation by forwarding host paths.
- Composition polls page targets rather than wiring the existing `connectPageOwnership()` observer, so popup/close/reused-target behavior needs live integration.
- Live stop/idling versus in-flight official MCP still needs runtime acceptance evidence, beyond the newly wired and regression-tested lifecycle gate.
- Event API returns cursor-paged records, but has no retention-gap protocol or streaming delivery.
- Optional screenshots are honestly reported disabled; profile export and browser-download attribution remain absent.

No container, frontend, or Codex CLI files changed. The untracked `node_modules` symlink was preserved.
