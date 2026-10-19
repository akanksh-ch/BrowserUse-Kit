# Operator UI verification

## Scope

Operate-mode refinement of the existing React/shadcn Button/Tailwind console. Preserve cookie/CSRF API integration and server-side authorization; no backend or container changes. Desktop uses two equal grid columns; narrow screens stack them. No speculative dashboard, fake telemetry, or simulated runtime readiness.

## Executed evidence

- `npm run typecheck`: passed.
- `npm test`: 40 tests, 37 passed, 3 live-runtime tests skipped, 0 failed.
- `npm run build`: passed; checked-in public assets regenerated.
- Impeccable detector on frontend shell, controller, and stylesheet returned `[]`.
- Chrome DevTools against the real local Node/SQLite service with a disposable `/tmp` database: CLI bootstrap, administrator login, cookie session restoration, create/select workspace, authoritative created/stopped state, command-history empty state, credentials dialog opening and Escape dismissal.
- Viewer/control actions remain disabled for a workspace not reported ready.
- Inspected full-page desktop and 390px mobile screenshots. Mobile measured `innerWidth=390`, document width `390`; no document-level horizontal overflow. Workspace panel navigation scrolls locally.
- Mobile Lighthouse snapshot: Accessibility 100, Best Practices 100, Agentic Browsing 100. SEO 75: no meta description (private operator console; not addressed).
- Added controller regression coverage for observed/desired state, readiness-gated actions, system-source lifecycle events, and unknown timestamps.

## Review and integration

- Independent review found two P2 issues: expired credentials labeled active and stale sidebar lifecycle after polling. Both were fixed; expiry regression assertions added. Polling updates the existing sidebar detail node without replacing its focused button.
- Merged `origin/main` including deployment PR #1 before final typecheck, native tests, and build.
- Deployment checks: `python3 tests/deployment.test.py -v` passed the defaults test; live TLS test skipped because Caddy was unavailable. An initial unittest-discovery invocation matched no tests; the direct invocation above is authoritative.

## Hosted CI and production serving follow-up

- Hosted workflow now runs `npm run build` after `npm run check`; check already typechecks both TypeScript projects. Deployment fixture/TLS steps are unchanged.
- Re-ran `npm run check` (native suite plus five offline runtime checks) and production build successfully.
- Fetched production HTML through the real backend on loopback, then fetched its JS/CSS references and the dynamically referenced controller chunk. All three current hashed assets returned 200 with matching content types; no stale asset reference observed.
- Runtime-contract inspection found release failures could leave the client viewer interactive until renewal failed. Release now disables local pointer/keyboard input before the network request; a regression test forces HTTP 503 and checks view-only remains enforced. Server input gating remains authoritative.
- 403/409/5xx UI errors now include permission/session, contention, or runtime-diagnostic recovery guidance respectively. This does not turn failures into readiness.

## Remaining acceptance gates

The three skipped tests require real OCI utility execution, headful Chrome/MCP, and live x11vnc/input gating. This UI pass does not establish those acceptance conditions. Live viewer frames, takeover/release/renewal, emergency cancellation, browser upload/download, image readiness, persistence across container replacement/reboot, and network isolation require the runtime owner's integrated verification.

Resource usage, resolved versions/image digest, and per-workspace capture/network-policy values are not exposed by the present workspace record. The console must not invent them. Existing explanatory security copy is not a live health attestation. Full SRS release acceptance remains broader than this UI refinement.

## Historical integration smoke (before this refinement)

The following records an earlier implementation; API limitations described here may have since changed. Current evidence and gates are above.

# Operator UI integration smoke

Tested against the real `src/server.ts`, Node 22, Chromium browser tools, isolated SQLite `/tmp/buk-ui-check.sqlite`, loopback port 3001. No source-server changes made for this task.

## Setup

```sh
BUK_DATABASE=/tmp/buk-ui-check.sqlite BUK_ADMIN_PASSWORD='<temporary strong password>' npm run bootstrap -- admin
PORT=3001 BUK_HOSTS=localhost:3001,127.0.0.1:3001 BUK_DATABASE=/tmp/buk-ui-check.sqlite npm start
```

Do not reuse smoke credentials for production. This setup deliberately has no configured runtime, protected files mount, or noVNC static vendor installation.

## Observed browser checks

- Login form with username/password: success, session cookie accepted, CSRF returned as `csrf`.
- Workspace creation: success; sidebar shows `created`; selected workspace displays name, owner, shared-profile warning, and creation timeline event.
- Reload: `/api/session` returns 200 and restores console without signing in again.
- Commands tab and submitting `printf ui-smoke`: automation lease acquired; command fails closed without configured runtime/isolation attestation; visible error status, run button re-enabled. No command execution success claimed.
- Files tab: sends GET `/files?path=common`; 503 with unconfigured protected mount is presented visibly. No file persistence success claimed.
- Human takeover: POST `/leases/human` returns 200; UI shows human control; automatic PUT renewal with returned lease `id` returns 200.
- Explicit invalid human lease ID via browser fetch is rejected (current server returns 500); no client input authority is inferred from this failure.
- Release button sends DELETE `/leases/human`.
- Browser console: only HTTP resource errors from deliberately unavailable services and invalid renewal, no JavaScript exceptions observed.

## Corrected API bindings

- Session restoration uses `/api/session`; both login `csrf` and `csrfToken` are understood.
- Lease renew uses PUT on the lease collection with JSON `{id}`; release uses DELETE.
- Command cancellation uses DELETE `/commands/:id`.
- File upload sends raw Blob bytes with `application/octet-stream`; file mutations acquire automation lease; quota uses separate `/quota` route.
- Viewer bootstrap GET `/viewer` supplies `/viewer/ws`; noVNC imports `/novnc/core/rfb.js`. Viewer bootstrap rejects cross-origin URLs.
- Tokens issue through global `/api/tokens` with workspaceId; revoke through `/api/tokens/:id`. Listing is explicitly page-session-only because server has no token-list route. UI describes server-fixed 15-minute lifetime and signed-in token subject.
- Ownership PUT uses `/pages/:id`; default backend currently returns unavailable for updates.
- Emergency action releases own lease then requests workspace stop; does not pretend an unimplemented emergency-stop endpoint exists.
- Screenshots are fetched from `/screenshots`; current backend returns an empty list.

## Not verified

Live noVNC rendering/input, actual ready-runtime commands, file upload/download persistence, ownership transfer, and screenshot artifacts require configured runtime/backend services. No v1 release acceptance assertion is made.
