import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';

// Opt-in against an already provisioned deployment, not a synthetic upstream.
// Never create/delete/start workspaces or send browser/desktop input here.
function configuration(env: NodeJS.ProcessEnv) {
  assert.ok(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS certificate verification must remain enabled');
  let origin: URL;
  try { origin = new URL(env.BUK_DEPLOY_URL ?? ''); } catch { throw Error('Valid deployment HTTPS origin required'); }
  assert.equal(origin.protocol, 'https:', 'HTTPS required');
  assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/', 'Origin only; no URL credentials, path or query');
  assert.match(env.BUK_DEPLOY_WORKSPACE ?? '', /^[a-zA-Z0-9-]+$/, 'Workspace identifier required');
  assert.ok(env.BUK_DEPLOY_AGENT_TOKEN && env.BUK_DEPLOY_VIEW_TOKEN, 'Separate scoped credentials required');
  assert.ok(env.BUK_DEPLOY_AGENT_TOKEN !== env.BUK_DEPLOY_VIEW_TOKEN, 'Use distinct automation and view-only credentials');
  return { origin, workspace: env.BUK_DEPLOY_WORKSPACE!, agent: env.BUK_DEPLOY_AGENT_TOKEN!, viewer: env.BUK_DEPLOY_VIEW_TOKEN! };
}

test('deployment smoke configuration rejects insecure URLs and credential leakage', () => {
  const valid = { BUK_DEPLOY_URL: 'https://buk.example.com', BUK_DEPLOY_WORKSPACE: 'smoke-1', BUK_DEPLOY_AGENT_TOKEN: 'synthetic-agent', BUK_DEPLOY_VIEW_TOKEN: 'synthetic-view' };
  assert.equal(configuration(valid).origin.origin, 'https://buk.example.com');
  for (const url of ['http://buk.example.com', 'https://user:secret@buk.example.com', 'https://buk.example.com/?token=secret', 'https://buk.example.com/path', 'https://buk.example.com/#secret']) {
    assert.throws(() => configuration({ ...valid, BUK_DEPLOY_URL: url }));
  }
  assert.throws(() => configuration({ ...valid, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
  assert.throws(() => configuration({ ...valid, BUK_DEPLOY_WORKSPACE: '../other' }));
  assert.throws(() => configuration({ ...valid, BUK_DEPLOY_VIEW_TOKEN: valid.BUK_DEPLOY_AGENT_TOKEN }));
});

test('opt-in deployed HTTPS MCP/SSE session and authenticated WSS RFB banner', {
  skip: process.env.BUK_DEPLOY_LIVE !== '1', timeout: 45_000,
}, async () => {
  const config = configuration(process.env);
  const endpoint = new URL(`/api/workspaces/${config.workspace}/mcp`, config.origin);
  let sseResponses = 0;
  // Never print response bodies, tool results, credentials or raw SDK errors.
  const request: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) sseResponses++;
    return response;
  };
  const post = (token?: string) => request(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'deployment-negative-smoke', version: '1' } } }),
  });
  for (const token of [undefined, config.viewer]) {
    const denied = await post(token);
    await denied.body?.cancel();
    assert.ok([401, 403].includes(denied.status), 'Unauthenticated/view-only MCP initialization must be denied');
  }
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${config.agent}` } }, fetch: request,
  });
  const client = new Client({ name: 'deployment-live-smoke', version: '1' });
  let initialized = false;
  try {
    await client.connect(transport); initialized = true;
    assert.ok(transport.sessionId, 'Stateful MCP session identifier required');
    const discovery = await client.listTools();
    assert.ok(discovery.tools.some(tool => tool.name === 'list_pages'), 'Read-only page discovery required');
    const pages = await client.callTool({ name: 'list_pages', arguments: {} });
    assert.ok(!pages.isError, 'Read-only page listing failed');
    assert.ok(sseResponses > 0, 'No real MCP SSE response observed');

    const viewer = new URL(`/api/workspaces/${config.workspace}/viewer/ws`, config.origin);
    viewer.protocol = 'wss:';
    const connectViewer = (token?: string, denied = false) => new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(viewer, { headers: { Origin: config.origin.origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, handshakeTimeout: 5000, maxPayload: 65536 });
      const timer = setTimeout(() => finish(Error('Viewer banner/denial deadline exceeded')), 8000);
      let finished = false;
      let banner = Buffer.alloc(0);
      const finish = (error?: Error) => {
        if (finished) return; finished = true; clearTimeout(timer); socket.terminate();
        error ? reject(error) : resolve();
      };
      socket.on('unexpected-response', (_req, response) => {
        response.resume();
        if (denied && [401, 403].includes(response.statusCode ?? 0)) finish();
        else finish(Error('Viewer upgrade unexpectedly rejected'));
      });
      socket.on('open', () => { if (denied) finish(Error('Unauthenticated viewer accepted')); });
      socket.on('message', (data, binary) => {
        if (!binary) return finish(Error('Expected binary RFB stream'));
        banner = Buffer.concat([banner, Buffer.from(data as Buffer)]);
        if (banner.length >= 12) {
          if (/^RFB 003\.(003|007|008)\n$/.test(banner.subarray(0, 12).toString())) finish();
          else finish(Error('Invalid RFB banner'));
        }
      });
      socket.on('error', () => finish(Error('Viewer connection failed')));
      socket.on('close', () => { if (!finished) finish(Error('Viewer closed before proof')); });
    });
    await connectViewer(undefined, true);
    await connectViewer(config.viewer);
  } catch {
    // SDK diagnostics may include page content; retain only a sanitized failure.
    assert.fail('Live deployment smoke failed (credentials/page data intentionally omitted); inspect protected deployment diagnostics');
  } finally {
    try { if (initialized) await transport.terminateSession(); } finally { await client.close(); }
  }
});
