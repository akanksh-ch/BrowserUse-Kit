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

## Protected browser upload routing (FR-BR-007, FR-FILE-008)

Composition now routes `upload_file` through `FileService.download()` (descriptor-safe roots, authorization rechecks, bounded regular-file reads) into a control-private mode-0700 temporary directory. OCI copy stages the complete snapshot into a browser-only mode-0700 `/tmp/buk-upload-<uuid>` directory, preserving the original filename. Chrome never receives a host path or mutable utility-volume path. Copies are removed after success, upstream failure, or post-staging credential denial; cleanup failures are audited and returned as failures. The existing lifecycle hold spans staging, browser dispatch, and cleanup.

**Contract addition:** `files:upload` is now issuable. Browser upload requires `automation` + `files:upload` + `files:read` and a live automation lease. `filePath` accepts workspace-relative paths (`input/paper.pdf`) or `/workspace/input/paper.pdf`; other absolute paths, traversal, symlinks, and hardlinks remain denied. HTTP file-upload permissions are unchanged.

A full-suite run exposed an existing delegated-expiry clock race. A deterministic advancing-clock regression reproduced it; `ac46aec` now clamps delegated credentials to the issuer's absolute expiry rather than a recomputed relative lifetime.

### Runnable evidence

- Upload-routing regression failed first with `Browser upload routing unavailable`; gateway cleanup regression failed first when the protected-path object reached upstream instead of its path.
- `PYTHONDONTWRITEBYTECODE=1 npm run check`: **PASS**, TypeScript, 46 passing Node tests, 5 explicitly skipped live tests, 5 Python checks.
- `npm audit`: **PASS**, zero vulnerabilities (including development dependencies).
- `BUK_LIVE_UPLOAD=1 OCI_RUNTIME=podman node_modules/.bin/tsx --test --test-name-pattern='live OCI copy' tests/uploads.test.ts`: **PASS**, actual runtime copy readable by browser UID 1000, private temporary copy removed afterward, no shared utility mount or published ports.
- `BUK_LIVE_UPLOAD=1 OCI_RUNTIME=podman node_modules/.bin/tsx --test --test-name-pattern='live sandboxed browser' tests/uploads.test.ts`: **FAIL / runtime blocker**, current `localhost/browseruse-browser:local` starts Xvfb/VNC but Chrome exits with `FATAL:content/browser/zygote_host/zygote_host_impl_linux.cc:251: Zygote process exited prematurely with exit code -1`. No CDP endpoint becomes available. The test uses isolated network-none, dropped capabilities, no-new-privileges, read-only root and private tmpfs; it does not add `--no-sandbox`, privileged mode, or seccomp-unconfined. Runtime owners must supply a supported sandbox-capable image/runtime configuration before full PDF selection can be proved. Test containers were explicitly removed, including failed-start diagnostics containers.

## Remaining integration blockers found (not claimed resolved)

- End-to-end official MCP PDF selection remains runtime-blocked as above; protected staging is implemented and live OCI-copy-tested, not a claim that AT-033 passes.
- Composition polls page targets rather than wiring the existing `connectPageOwnership()` observer, so popup/close/reused-target behavior needs live integration.
- Live stop/idling versus in-flight official MCP still needs runtime acceptance evidence, beyond the newly wired and regression-tested lifecycle gate.
- Event API returns cursor-paged records, but has no retention-gap protocol or streaming delivery.
- Optional screenshots are honestly reported disabled; profile export and browser-download attribution remain absent.

No container, frontend, or Codex CLI files changed. The untracked `node_modules` symlink was preserved.
