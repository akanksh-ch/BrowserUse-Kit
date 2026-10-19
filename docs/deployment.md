# Single-host TLS gateway reference

This reference uses host-native Caddy 2 in front of the built-in Node control
plane on **127.0.0.1:3000**. It does not deploy the workspace runtime: first
satisfy [the runtime prerequisites and isolation checks](../containers/README.md).
Do not substitute a public browser/CDP/VNC proxy. This is a reference, not proof
of production acceptance on your host.

## Configure and run

1. Install a maintained Caddy 2 distribution on the **same host** as Node.
   Choose your real DNS name in place of `buk.example.com` in both
   `deploy/Caddyfile` and `deploy/buk.env`. Point its A/AAAA records only at this
   host (remove AAAA if IPv6 is not served). This example uses standard port 443;
   there are exactly two accepted HTTP authorities: `buk.example.com` and
   `buk.example.com:443`. Neither `localhost` nor arbitrary subdomains are allowed.
2. Permit inbound TCP 80 and 443 to Caddy only. Port 80 is Caddy's automatic
   HTTPS redirect/ACME listener, never a plaintext app proxy. UDP 443 is optional
   for HTTP/3. Deny all other public ingress, including IPv6. Node, CDP (9222/9223),
   RFB/VNC (5900), websockify, egress proxy (3128), and runtime management must not
   be exposed by host firewall rules, NAT, container published ports, or tunnels.
   Caddy's admin endpoint defaults to loopback 2019; never expose it either.
3. From the repository root, install dependencies with `npm ci` and load the
   non-secret environment before bootstrapping or starting the built-in server:

   ```sh
   set -a
   . ./deploy/buk.env
   set +a
   unset BUK_COMPOSITION_MODULE
   # Supply BUK_ADMIN_PASSWORD securely for this one command; do not commit it.
   # With that variable exported:
   npm start -- bootstrap admin
   unset BUK_ADMIN_PASSWORD
   npm start
   ```

   Bootstrap is an initial setup step, not a step on every restart. Keep the same
   working directory and durable `BUK_DATABASE` across restarts; restrict access
   to its directory, backups, and all workspace/profile data. Run Node under a
   supervised account with only the runtime permissions the built-in composition
   actually needs. Never give Caddy the runtime socket or database credentials.
4. In a second terminal validate, then run Caddy using a privileged-port-capable
   service account (normally your distribution's Caddy service):

   ```sh
   sh deploy/check.sh
   caddy run --config "$PWD/deploy/Caddyfile" --adapter caddyfile
   ```

   For a packaged service, install this file as its configured Caddyfile and
   validate/reload via that service instead. Preserve Caddy's writable certificate
   storage across restarts. Real public DNS and ACME reachability are required;
   do not bypass TLS verification if certificate issuance fails.

## Why the built-in server works behind TLS

`src/server.ts` deliberately disables Express `trust proxy`. Startup refuses
non-loopback HTTP binds. `BUK_HOSTS` is a **literal comma-separated** allowlist
matched against the incoming Host header. Caddy preserves the original Host;
rewriting it to localhost or a fixed accepted value would defeat that boundary.
The explicit gateway Host guard also rejects unexpected authority values.

`BUK_SECURE=1` (exactly `1`, not `true`) independently selects Secure on login
and logout cookies, and HTTPS for the viewer's same-origin check. Cookies remain
HttpOnly, SameSite=Strict, Path=/, with no Domain attribute. This does not depend
on `X-Forwarded-Proto`; do not enable proxy trust as a workaround. Keep
`BUK_COMPOSITION_MODULE` unset: a custom composition bypasses these environment
options and must supply its own reviewed `hosts` and `secure: true` options.
The current server can support this TLS arrangement without source changes.

Caddy proxies the entire origin without path stripping, auth replacement,
response buffering, or short stream deadlines. `flush_interval -1` flushes
streaming responses immediately. MCP is **Streamable HTTP** at
`https://buk.example.com/api/workspaces/WORKSPACE/mcp` (POST/GET/DELETE, including
SSE responses), not a WebSocket endpoint. Preserve Authorization,
Mcp-Session-Id, MCP-Protocol-Version and normal response headers; Caddy's default
proxy does so. Supply a workspace-scoped bearer credential using the MCP client's
secret configuration, not a URL query. There is no extra public MCP listener.
The viewer bootstrap returns a same-origin path and the browser upgrades it to
`wss://buk.example.com/api/workspaces/WORKSPACE/viewer/ws`; Caddy natively handles
WebSocket upgrades, while Node authenticates and gates viewer input.

## Validate before opening access

`sh deploy/check.sh` uses the actual Caddy parser and module provisioning; set
`CADDY=/path/to/caddy` if needed. It does not start listeners or obtain a real
certificate. After startup:

```sh
# Run locally: Host is deliberately the public authority, not localhost.
curl --fail -H 'Host: buk.example.com' http://127.0.0.1:3000/health
curl -i -H 'Host: attacker.invalid' http://127.0.0.1:3000/health # 421
# Run from another host, without -k:
curl --fail https://buk.example.com/health
curl -I http://buk.example.com/health # HTTPS redirect, no app response
```

Also verify the following on the actual host and archive evidence:

- `ss -lntup` shows Node only on 127.0.0.1:3000; inspect container port mappings
  and test external IPv4/IPv6 reachability to confirm no raw services are public.
- Real login over HTTPS sets `buk_session` with Secure, HttpOnly, SameSite=Strict;
  authenticated cookie mutations still require the returned CSRF token. Never
  send the login/password over the loopback HTTP diagnostic from another host.
- Connect an authenticated MCP client, initialize a session, list/call tools,
  receive streaming responses, and terminate the session. Verify revocation and
  workspace scope are enforced; a successful `/health` is not MCP acceptance.
- Connect the browser viewer over WSS, confirm view-only behavior and authorized
  takeover/release, and confirm revocation disconnects/denies further use.
- With a trusted certificate, `curl -i https://buk.example.com/health -H
  'Host: attacker.invalid'` must not reach the app successfully (421 or gateway
  rejection). Never loosen either allowlist to make a failing smoke test pass.

Limitations: with proxy trust disabled, login rate-limiting sees Caddy's loopback
socket address, not individual client IPs. This safely shares the throttle but
permits a client to exhaust the shared login budget; do not claim per-client
rate limiting. A gateway reload can disconnect long-lived streams: clients must
reconnect/reinitialize. This reference adds no HA, cross-host plaintext hop,
automated OS hardening, or deployment acceptance beyond the checks actually run.
