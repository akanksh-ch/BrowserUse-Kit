# BrowserUse-Kit

A self-hosted, persistent Linux desktop for AI agents. Each instance is a Debian + XFCE desktop in a container that you watch and control from a browser, SSH into, and hand to agents (Claude Code and others) over MCP.

- **Isolated.** Agents get their own desktop, browser, and shell instead of yours.
- **Persistent.** Chromium profile, logins, SSH keys, and shell history live on a volume and survive restarts.
- **Observable.** Open the desktop in a browser tab (noVNC), no VNC client needed.
- **Agent-ready.** Claude Code, tmux, Node, and two MCP servers are preinstalled.
- **Credentials stay out of prompts.** A self-hosted Vaultwarden vault and the Bitwarden extension handle sign-in.
- **Deliverables are easy to collect.** Anything an agent writes to `~/outputs` is downloadable from a web file browser.

```
                    ┌──────────────────────────── container: desktop ───────────────────────────┐
 browser :6080 ───▶ │ noVNC ─▶ Xtigervnc :1 ◀── XFCE4 ◀── Chromium (CDP :9222, Bitwarden ext.)  │
 ssh     :2222 ───▶ │ sshd ─▶ tmux ─▶ claude / other agents ─▶ MCP: chrome-devtools, desktop    │
                    └──────────────┬─────────────────────────────────────────────┬─────────────┘
                                   │ ~/outputs (volume)                          │ https://vault
 browser :8081 ───▶ files (dufs) ──┘          vault (Caddy, local CA) ─▶ vaultwarden
```

## Quick start

Requires Docker or Podman with Compose.

```sh
git clone https://github.com/akanksh-ch/BrowserUse-Kit.git
cd BrowserUse-Kit
PASSWORD='choose-a-password' docker compose up -d --build   # or: podman compose ...
```

| What | Where | Credentials |
| --- | --- | --- |
| Desktop in the browser | http://localhost:6080/vnc.html?autoconnect=true | `PASSWORD` |
| SSH | `ssh -p 2222 agent@localhost` | user `agent`, `PASSWORD` |
| Files (`~/outputs`) | http://localhost:8081 | user `admin`, `PASSWORD` |
| Vault web UI | http://localhost:8080 (loopback only) | your own account |

All ports bind to `127.0.0.1` by default. See [Hosting](#hosting) to expose them.

> **Podman users:** image names in `docker-compose.yml` are fully qualified because Podman refuses short names without a TTY.

## Using it

### Run an agent

```sh
ssh -p 2222 agent@localhost
tmux new -s work
claude            # log in once; the login persists on the volume
```

`DISPLAY=:1` is set in every shell, so GUI programs started from SSH or tmux appear on the desktop you see in the browser.

### MCP servers

Both servers are registered for Claude Code in `/etc/claude-code/managed-mcp.json`.

| Server | What it controls | Notes |
| --- | --- | --- |
| `chrome-devtools` | The visible Chromium, over CDP on `127.0.0.1:9222` | Navigate, click, snapshot, console, network. Best choice for anything in the browser. |
| `desktop` | The whole desktop | `screenshot`, `click`, `type_text`, `key`, `list_windows`, `focus_window`, `launch`, `a11y_tree`, `a11y_click` |

For native GTK and Qt apps, prefer `a11y_tree` and `a11y_click` (they address elements by name through AT-SPI). Fall back to `screenshot` plus `click` for anything without accessibility support. Other MCP clients can run the same commands: `chrome-devtools-mcp --browserUrl http://127.0.0.1:9222` and `/opt/venv/bin/python /opt/desktop-mcp/server.py` (with `DISPLAY=:1` and `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-session`).

### Sign-in with the vault

1. In the desktop's Chromium, open `https://vault` and create an account, or use the extension's **Create account**. The extension is preconfigured for it. Bitwarden clients refuse plain HTTP, so a Caddy container terminates TLS with its own local CA, and the entrypoint adds that CA to Chromium's trust store.
2. Set `VAULT_SIGNUPS=false` and run `docker compose up -d` again so nobody else can register.
3. Unlock the vault yourself in the desktop. The master password never goes through the agent.
4. Tell the agent to log in. Autofill is driven from the extension (toolbar icon, or *Autofill on page load* in its settings).

The extension's server URL is stored in the Chromium profile. If you change it after first use, reset the profile (`rm -rf ~/.chromium-profile` inside the container, then restart Chromium).

This reduces how often secrets pass through prompts and logs. It is not a hard boundary: an agent with desktop access can see anything visible on screen while the vault is unlocked, so lock the vault when you are not supervising.

### Collect results

Tell agents to write deliverables to `~/outputs`. Browse, download, and upload from http://localhost:8081.

## Hosting

### On a server

```sh
BIND=0.0.0.0 PASSWORD='long-random-password' VAULT_SIGNUPS=false docker compose up -d
```

Do not publish the raw ports on the internet. Put the web services behind a TLS reverse proxy that adds its own authentication, and restrict SSH.

- **VNC passwords are truncated to 8 characters by the protocol.** Treat the noVNC password as weak and add proxy-level auth (basic auth, OIDC, or a VPN such as Tailscale or WireGuard).
- **SSH:** copy your public key into `/home/agent/.ssh/authorized_keys` on the volume, then restrict access with a firewall or a VPN.
- **The Chromium debug port (9222) is not published.** Keep it that way: CDP has no authentication.
- **Vaultwarden** is only published on `127.0.0.1:8080`, and the desktop reaches it over `https://vault` inside the compose network. To use it from your own browser on another machine, publish your own TLS proxy for it.

Example Caddy config (Caddy handles WebSocket upgrades and certificates automatically):

```caddyfile
desktop.example.com {
    basicauth { you <bcrypt-hash> }
    reverse_proxy 127.0.0.1:6080
}
files.example.com {
    reverse_proxy 127.0.0.1:8081
}
```

### Prebuilt image

CI publishes `ghcr.io/akanksh-ch/browseruse-kit` on every push to `main` and every `v*` tag. Pull instead of building:

```sh
docker compose pull && docker compose up -d
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PASSWORD` | `agent` | Password for SSH, noVNC, and the file browser. **Change it.** |
| `BIND` | `127.0.0.1` | Host address the published ports bind to. |
| `VAULT_SIGNUPS` | `true` | Allow new Vaultwarden accounts. |
| `RESOLUTION` | `1440x900` | Desktop size (set in `docker-compose.yml`). |

Volumes: `home` (`/home/agent`), `outputs` (`~/outputs`), `vault` (Vaultwarden data). Remove them with `docker compose down -v` only if you want to lose all state.

## Development

```sh
docker compose up -d --build        # rebuild after editing the Dockerfile or rootfs/
docker compose exec desktop supervisorctl status
```

- `Dockerfile`: image definition. `rootfs/` is copied over `/`.
- `rootfs/etc/supervisor/conf.d/desktop.conf`: process list (sshd, dbus, Xtigervnc, XFCE, noVNC, Chromium).
- `rootfs/opt/desktop-mcp/server.py`: the `desktop` MCP server.
- `rootfs/etc/chromium/policies/managed/vault.json`: force-installs the Bitwarden extension and points it at Vaultwarden.
- `.github/workflows/image.yml`: builds on pull requests and publishes to GHCR from `main` and tags.

## Known limitations

- The XFCE panel's inner buttons have no accessible names, so use coordinates for those.
- Chromium is driven through CDP, not AT-SPI.
- The desktop can repaint several seconds late under software rendering. When driving it, wait before taking a screenshot after an action.
- Wayland-native apps are not supported inside the container, which runs an X11 desktop. Use `ssh -X` from an X11 or XWayland host to forward individual X11 apps to your own display.
