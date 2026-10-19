# BrowserUse Kit

Durable headful Chrome workspaces for trusted external agents and human operators on one Linux x86-64 host. Product requirements: [`SRS.md`](SRS.md). Implementation and validation: [`docs/implementation-plan.md`](docs/implementation-plan.md), [`docs/acceptance.md`](docs/acceptance.md).

## Trust model

**A workspace—not a tab—is the browser security boundary.** Agents sharing a profile share cookies, authenticated sites, browser storage and approved files. Use separate workspaces when agents must not share secrets. Page ownership only coordinates trusted agents.

Chrome runs non-root with its sandbox enabled in a dedicated Debian runtime. Commands run in a separate utility container without profile, display, CDP, VNC, host sockets or control credentials. Raw internal services must never be exposed publicly. Use TLS for all non-loopback access; do not put credentials in query strings.

The host administrator and OCI runtime are trusted. This is not a hostile multi-tenant SaaS sandbox. Retaining a profile volume retains sensitive cookies and browser state. Screenshots and command output can contain secrets; automated redaction is not a confidentiality guarantee.

## Development

Requires Node.js 22.13+ and npm; OCI workloads require native Linux x86-64 with Docker or Podman and working user-namespace Chrome sandbox prerequisites.

```sh
npm ci
npm run check
npm audit
```

Bootstrap an administrator once, then start the loopback gateway:

```sh
read -rsp 'Administrator password: ' BUK_ADMIN_PASSWORD; echo
export BUK_ADMIN_PASSWORD
npm run bootstrap -- admin
unset BUK_ADMIN_PASSWORD
npm start
```

Open `http://127.0.0.1:3000` and sign in. `BUK_DATABASE` selects the durable SQLite file (default `data/control.sqlite`); `PORT` and `BUK_HOSTS` must agree when changing the listening port. The server refuses direct non-loopback HTTP. See [`containers/README.md`](containers/README.md) for OCI setup and its explicit host prerequisites and remaining deployment limitations. UI login and workspace metadata creation do not establish that a browser runtime is ready.

Do not use `--no-sandbox` as a workaround for unsupported host settings.

## Operational constraints

- Profile and workspace files survive runtime replacement only while their persistent storage survives.
- Back up stopped profiles and workspace files using authorized administrator procedures. Live profile copies can be inconsistent.
- Tab restoration is best effort; unsaved forms and arbitrary page memory are not durable.
- Secure erasure and recovery from host storage loss are the administrator's responsibility.
- A workspace normally targets 2 CPUs, 2–4 GiB RAM and 10 GiB storage. Provision capacity for concurrent workspaces.
- Existing user images, volumes and containers must never be broadly pruned by project scripts.

## Release status

Implementation is under active verification. Passing unit tests is not equivalent to passing the full SRS acceptance suite. See the acceptance record for exact evidence and unexecuted gates; do not deploy outside loopback until TLS, private-service isolation, sandboxing, controlled egress and server-side input gating have been validated on the target runtime.
