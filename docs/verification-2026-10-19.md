# Integration verification — 2026-10-19

## Baseline (efbadfb)

- `npm run check`: exit 0; TypeScript passed; Node tests 36 passed, 3 skipped, 0 failed; Python runtime-policy tests 5 passed.
- `npm audit --omit=dev`: exit 0, zero known vulnerabilities.
- `BUK_LIVE_MCP=1 BUK_LIVE_RFB=1 node_modules/.bin/tsx --test tests/gateway.test.ts`: exit 1; 9 passed, 1 failed. Official MCP/headful Chrome test passed and `chrome://sandbox` reported Namespace layer-1, PID/network namespaces and Seccomp-BPF active. Live RFB failed before startup: `spawn Xvfb ENOENT` (Xvfb and x11vnc absent on host). This is not container-runtime acceptance.
- Podman available at `/usr/bin/podman`; `podman info --format '{{.Host.Security.Rootless}}'` returned `true`.
- Environment: Linux x86-64, kernel `7.2.9-201.fc44.x86_64`; Node `v22.23.1`.

## Chrome DevTools MCP checks

A temporary administrator and SQLite database were created under `/tmp/buk-v1-review` (not product data). Gateway launched on loopback `http://127.0.0.1:3100`.

- Navigated to login through DevTools MCP.
- Filled administrator credentials and submitted; console opened successfully.
- Created `V1 browser verification`; workspace appeared as `created`, not falsely `ready`.
- Workspace detail displayed lifecycle actions, shared-profile warning, view-only desktop, takeover controls, timeline, commands, files, page ownership and screenshot navigation.
- Baseline full-page screenshot: `/tmp/buk-v1-review/baseline-desktop.png` (local temporary artifact, not committed).

These checks cover UI login and metadata creation only. They do not establish a working container viewer, egress policy, or full SRS acceptance. Integrated frontend and runtime checks are recorded separately when executed.
