# Implementation contracts

Single-host v1, TypeScript ESM Node 22+, SQLite via node:sqlite, native node:test. HTTP via express and ws; official MCP SDK subprocess transport. All agents read SRS.md. No security downgrade or claims of unexecuted acceptance.

File ownership: core agent src/core.ts src/auth.ts src/lifecycle.ts tests/core.test.ts; gateway agent src/mcp.ts src/leases.ts src/viewer.ts tests/gateway.test.ts; files agent src/files.ts src/commands.ts tests/files.test.ts; UI agent public/*; runtime agent containers/* scripts/*; integrator src/server.ts package.json tsconfig.json README.md.

Shared API contract: each module exports classes/functions (report actual exports to integrator). Core supplies durable Store with db, audit(workspaceId,type,sourceId,summary), workspace lookup; auth bearer credentials hashed in SQLite, workspace permissions. Modules may take injected callbacks instead of importing unfinished modules. HTTP API /api/workspaces and /api/workspaces/:id/{start,stop,restart,events,files,commands,leases/automation,leases/human,pages}; MCP /api/workspaces/:id/mcp; viewer /api/workspaces/:id/viewer. Authentication via HttpOnly cookie login or Authorization Bearer; UI uses cookies and X-CSRF-Token.

Aim for fully working tested modules; integrator handles adaptation. Command/files browser mutation must require auth, audit and leases. Runtime and utility CLI cannot have published raw ports. Default loopback control HTTP only; remote requires TLS reverse proxy and exact Host allowlist.
