# Development CI scope

`.github/workflows/check.yml` runs on PRs and pushes to `main` using GitHub's
Ubuntu 24.04 hosted runner, Node 22 and the distribution's Caddy/OpenSSL packages.
Permissions are read-only and the job has a 15-minute timeout.

It executes:

1. `npm ci`
2. `npm run check` (TypeScript, native Node tests, offline runtime policy tests)
3. `sh deploy/check.sh`
4. `python3 tests/deployment.test.py -v` (real isolated loopback TLS and synthetic upstream)

This deliberately does not launch OCI workspaces, require privileged containers,
assume Chrome/display availability, or claim Docker/Podman acceptance. Opt-in
real OCI, Chrome MCP and x11vnc tests remain skipped unless explicitly enabled
in a separately provisioned acceptance environment. Dependency-install failure
fails CI; Caddy/OpenSSL must be present for the live deployment checks.

## Local validation of this workflow addition

2026-10-19, `feat/v1-deploy` based on `5a32ab6`, native Linux x86-64,
Node v22.23.1, local Caddy v2.11.7:

- `npm ci`: passed; audit reported zero vulnerabilities.
- `npm run check`: passed TypeScript; Node tests 36 passed, 0 failed, 3 skipped;
  offline runtime Python tests 5 passed.
- `CADDY=/tmp/buk-caddy sh deploy/check.sh`: valid configuration.
- `CADDY=/tmp/buk-caddy python3 tests/deployment.test.py -v`: 2 passed, no skips.
- `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7 .github/workflows/check.yml`:
  exit 0, no diagnostics.

This local execution does not establish a successful hosted Ubuntu workflow run
or the Ubuntu package's behavior. Consult the PR checks for that result. The
production/SRS acceptance gaps in [deployment-review.md](deployment-review.md)
remain open; CI success is not release approval.
