# Development verification evidence

These results are scoped observations, not SRS release certification. Commands ran on the Fedora/Podman host described in implementation-plan.md.

## First integration pass

- `npm run typecheck`: initially failed because gateway imported `.ts` while TypeScript did not allow those extensions. Set `allowImportingTsExtensions: true` under `noEmit`; rerun passed.
- `npm test`: 27 tests, 26 passed, 1 skipped (opt-in real OCI command integration). No failures. Tests include real SQLite plus injected runtime/MCP transports; they do not establish full runtime acceptance.
- `python3 scripts/test-runtime.py`: five checks passed. These are offline policy/deployment invariant checks, not proof against real container egress bypass.
- `npm audit`: zero reported vulnerabilities at install and subsequent verification.
- `node --check public/app.js`: passed syntax check.
- Minimal `podman run --rm --network none --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 debian:stable-slim ...`: non-root execution succeeded without host runtime sockets. This is not Chrome sandbox acceptance.

## Real CLI smoke

Added `tests/cli.test.ts`. `npx tsx --test tests/cli.test.ts` passed: real CLI bootstrap in a disposable SQLite directory, real HTTP server startup, health, unauthenticated denial, cookie login, CSRF denial, authenticated workspace creation/listing, operator HTML and correctly served noVNC JavaScript. Test cleans up its child process and temporary storage. It does not start a browser workspace.

## Subsequent integration in progress

A full `npm run check` currently encounters the commands worker's new test import of `validateUtilityIsolation` before that export has landed. This is an integration blocker until a fresh full check passes; do not cite the earlier passing typecheck as current full-tree proof.

Runtime control-plane routing, true readiness, filesystem quota enforcement, live sandbox, private-service reachability, input-gate interoperability and Docker-specific acceptance remain release gates. The host's `docker` executable is a Podman wrapper. Rootful firewall enforcement must not be silently replaced with proxy environment variables alone.
