// Synthetic protocol fixture for the live smoke harness, NOT browser/SRS proof.
// Run: CADDY=/path/to/caddy node --import tsx tests/deployment-fixture.ts
import { createServer } from 'node:http';
import { createServer as reserve } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'buk-deploy-fixture-'));
const agent = randomUUID(), viewer = randomUUID();
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();
const backend = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${agent}`) { res.writeHead(req.headers.authorization ? 403 : 401).end(); return; }
    let session = sessions.get(String(req.headers['mcp-session-id'] ?? ''));
    if (!session) {
      const server = new McpServer({ name: 'synthetic-deployment-fixture', version: '1' });
      server.registerTool('list_pages', { description: 'Synthetic empty page list', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: '[]' }] }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
      await server.connect(transport); session = { server, transport };
    }
    let body: unknown;
    if (req.method === 'POST') { let text = ''; for await (const chunk of req) text += chunk; body = JSON.parse(text); }
    await session.transport.handleRequest(req, res, body);
    if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
});
const wss = new WebSocketServer({ noServer: true });
backend.on('upgrade', (req, socket, head) => {
  if (req.headers.authorization !== `Bearer ${viewer}`) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  wss.handleUpgrade(req, socket, head, ws => { ws.send(Buffer.from('RFB 003.008\n')); });
});
backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
const backendPort = (backend.address() as { port: number }).port;
const reservation = reserve(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = (reservation.address() as { port: number }).port;
await new Promise<void>(r => reservation.close(() => r()));
let caddy: ReturnType<typeof spawn> | undefined;
try {
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  let config = await readFile('deploy/Caddyfile', 'utf8');
  config = config.replaceAll('buk.example.com', '127.0.0.1').replaceAll(':443', `:${port}`)
    .replace('127.0.0.1:3000', `127.0.0.1:${backendPort}`)
    .replace('https:// {', `https://:${port} {\n bind 127.0.0.1\n tls ${cert} ${key}`)
    .replace('127.0.0.1 {', `https://127.0.0.1:${port} {\n bind 127.0.0.1\n tls ${cert} ${key}`);
  const file = join(directory, 'Caddyfile');
  await writeFile(file, '{\n admin off\n auto_https off\n}\n' + config);
  caddy = spawn(process.env.CADDY ?? 'caddy', ['run', '--config', file, '--adapter', 'caddyfile'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; caddy.stderr!.on('data', data => { logs = (logs + data).slice(-8192); });
  for (let i = 0; ; i++) {
    if (caddy.exitCode !== null || i > 100) throw Error(`Fixture gateway startup failed: ${logs}`);
    try { const socket = await import('node:net').then(n => n.connect(port, '127.0.0.1')); await once(socket, 'connect'); socket.destroy(); break; }
    catch { await new Promise(r => setTimeout(r, 25)); }
  }
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', resolve('tests/deployment-live.test.ts')], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: cert, BUK_DEPLOY_LIVE: '1', BUK_DEPLOY_URL: `https://127.0.0.1:${port}`, BUK_DEPLOY_WORKSPACE: 'fixture', BUK_DEPLOY_AGENT_TOKEN: agent, BUK_DEPLOY_VIEW_TOKEN: viewer }, stdio: 'inherit', timeout: 60_000, killSignal: 'SIGKILL',
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw Error('Synthetic gateway harness failed');
  console.log('Synthetic MCP/SSE and RFB-banner WSS fixture passed; NOT live Chrome/VNC/auth acceptance.');
} finally {
  if (caddy && caddy.exitCode === null) { caddy.kill(); await once(caddy, 'exit'); }
  for (const ws of wss.clients) ws.terminate(); wss.close();
  for (const session of sessions.values()) await session.server.close();
  backend.closeAllConnections(); await new Promise<void>(r => backend.close(() => r()));
  await rm(directory, { recursive: true, force: true });
}
