import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

// Real CLI and SQLite, no mocked auth or HTTP composition. OCI acceptance is separate.
test('CLI bootstrap, real HTTP login/CSRF, durable workspace and noVNC assets', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'buk-cli-'));
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
  const password = randomBytes(24).toString('hex');
  const env = { ...process.env, BUK_DATABASE: join(root, 'control.sqlite'), BUK_ADMIN_PASSWORD: password, PORT: String(port), BUK_HOSTS: `127.0.0.1:${port}`, BUK_BIND: '127.0.0.1', OCI_RUNTIME: 'podman' };
  let output = '';
  const launch = (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => { output = (output + b).slice(-8192); }); child.stderr.on('data', b => { output = (output + b).slice(-8192); });
    return child;
  };
  let server: ReturnType<typeof launch> | undefined;
  try {
    const bootstrap = launch('bootstrap', 'admin');
    const [code] = await once(bootstrap, 'exit'); assert.equal(code, 0, output);
    server = launch(); const base = `http://127.0.0.1:${port}`;
    let health: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) assert.fail(`CLI exited: ${output}`);
      try { health = await fetch(base + '/health'); break; } catch { await new Promise(r => setTimeout(r, 25)); }
    }
    assert.equal(health?.status, 200, output);
    assert.equal((await fetch(base + '/api/workspaces')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }) });
    assert.equal(login.status, 200); const session = await login.json() as { csrf?: string; csrfToken?: string };
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const csrf = session.csrf ?? session.csrfToken; assert.ok(csrf);
    const create = (headers: Record<string, string>) => fetch(base + '/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, ...headers }, body: JSON.stringify({ name: 'CLI smoke' }) });
    assert.equal((await create({})).status, 403);
    const created = await create({ 'X-CSRF-Token': csrf }); assert.equal(created.status, 200, await created.clone().text());
    const workspace = await created.json() as { id: string }; assert.ok(workspace.id);
    const list = await fetch(base + '/api/workspaces', { headers: { Cookie: cookie } }); assert.equal(list.status, 200);
    assert.match(await list.text(), /CLI smoke/);
    const index = await fetch(base + '/'); assert.equal(index.status, 200); assert.match(await index.text(), /BrowserUse/);
    // This asset is necessary for an actual viewer; no browser image is required to serve it.
    const novnc = await fetch(base + '/novnc/core/rfb.js'); assert.equal(novnc.status, 200); assert.match(novnc.headers.get('content-type') ?? '', /javascript/);
  } finally {
    if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
    await rm(root, { recursive: true, force: true });
  }
});
