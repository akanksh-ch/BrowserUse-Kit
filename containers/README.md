# OCI runtime foundation

Read alongside `SRS.md`. These files provide the runtime substrate, not the public control plane or a release acceptance claim.

## Build and run

Native Linux x86-64, rootful Docker or Podman, Python 3, iproute2, util-linux, iptables and ip6tables are required on the host. Docker/Podman networks must support internal networks. Use `sudo -E` if needed.

```sh
export OCI=docker # or podman
export CHROME_VERSION='<exact available Google Chrome Debian version>'
# Resolve deliberately, e.g. from Google's stable Debian Packages index.
bash scripts/runtime.sh build
sudo env OCI="$OCI" bash scripts/runtime.sh start demo
sudo env OCI="$OCI" bash scripts/runtime.sh inspect demo
sudo env OCI="$OCI" bash scripts/runtime.sh stop demo
# Destructive; control plane must revoke credentials and audit deletion FIRST:
sudo env OCI="$OCI" bash scripts/runtime.sh delete demo
python3 scripts/test-runtime.py
```

Restart means stop then start; volumes remain. Starts do not adopt arbitrary pre-existing containers. Do not use `docker start` after stopping: recreate through the script so namespace firewall rules are reapplied. Host reboot recovery must likewise recreate containers, not automatically restart them.

## Lifecycle adapter

`scripts/workspace.sh` implements the `src/lifecycle.ts` protocol: start, stop, delete, health; accepts `OCI_RUNTIME`, `PROFILE_VOLUME` and `FILES_VOLUME`. Health deliberately fails unless `BROWSERUSE_CONTROL_HEALTHCHECK` names a trusted executable that checks MCP, input gate, durable audit, file storage and network policy for the supplied workspace ID. It never claims full readiness from Chrome health alone. Runtime CLI also offers build and inspect.

## Control-plane contract

* Browser `buk-ID-browser`: private HTTP CDP on 9223; private RFB on 5900. No public port mappings exist. Attach only the trusted per-workspace control sidecar to `buk-ID-browser`. Never attach utility to this network.
* Utility `buk-ID-utility`: no listener; trusted host lifecycle broker uses OCI exec as UID 1000. Do not mount the OCI socket into any workspace container. Control plane implements bounded commands, process-group cancellation, leases and audit; this script is not a command API.
* Named volumes `buk-ID-profile` and `buk-ID-files`. Profile mounted only in browser, files at `/workspace` in browser and utility. Control may mount files but never profile. Audit storage must remain outside both containers.
* Browser waits for `/tmp/network-ready`; supervisor installs namespace IPv4/IPv6 OUTPUT default-deny rules before releasing it. Only loopback, established replies and its proxy TCP 3128 are allowed. Utility gets equivalent rules. Proxy resolves and validates all answers, connects by numeric address, denies non-global addresses and host interface addresses. Set `DENY_CIDRS` for additional control-plane addresses, public host NAT addresses and administrative destinations not present on local interfaces. Recreate deployment when host addresses change.
* Readiness requires browser container health **plus** control-plane MCP, gate, utility, storage and policy checks. Browser-only health does not mean workspace `ready`.
* noVNC assets are installed at `/usr/share/novnc`; websockify is installed but deliberately not launched. Control must provide authenticated HTTPS/WSS and parse/gate **every RFB client input message** by current credential and human lease. Never point public websockify straight at port 5900, even in client view-only mode. Clipboard is disabled in this foundation.
* Isolated per-agent MCP stdio processes belong in control, not browser. Record their exact package version and validated capability-map version alongside runtime manifests.

## Sandbox and limits

Chrome runs UID 1000 with only `CAP_SYS_CHROOT`, which its sandbox requires, plus no-new-privileges and no sandbox bypass; all other capabilities are dropped. User-namespace creation must be supported by kernel sysctls and the runtime's maintained seccomp profile. On hosts whose default profile blocks `unshare -Ur`, startup fails intentionally. An administrator must supply a reviewed Chrome-compatible runtime profile before this host can be supported; never use seccomp-unconfined or disable Chrome sandboxing as a workaround. This deployment does not claim acceptance on an untested kernel/runtime combination.

Browser entrypoint takes an advisory exclusive lock on the persistent profile and retains it until Chrome exits. Shutdown sends TERM and waits for Chrome before releasing the lock; forced kills remain crash recovery, not guaranteed clean profile flush. Chrome is configured for a dedicated profile, disabled sync/extensions/clipboard, and workspace downloads.

CPU, RAM, PID and tmpfs limits are enforced. **Persistent filesystem quota is not implemented by this script**: use a quota-enforced volume backend (project quota or bounded filesystem) before enabling agent commands/downloads. API-only upload accounting cannot constrain shell writes. Do not label deployment production-ready without that backend and acceptance tests.

## Version provenance and verification

Chrome requires an explicit package version. Build emits exact image inspection JSON and package inventory under `containers/manifests/`. Debian base tag and Debian dependency resolution are intentionally not claimed reproducible: promote release builds by digest and archive their manifest/images; replace the base tag with an approved digest for reproducible releases. noVNC/websockify/X/VNC versions are captured by dpkg. Never promote mutable `:local` tags as release identities.

Offline tests validate address policy, mixed DNS denial, denied ports and basic deployment invariants. Actual image builds, sandbox diagnostics, real egress bypass attempts (including host gateways and IPv6), profile persistence and viewer forged-input tests must run on the reference Docker **and** Podman hosts. The public control plane owns token revocation, server-side input gating and audit fail-closed tests; these files alone do not implement them.
