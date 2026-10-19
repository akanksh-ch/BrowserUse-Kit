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
