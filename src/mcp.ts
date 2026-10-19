import { randomUUID } from 'node:crypto';
import type { Audit, Principal } from './leases.ts';
import { LeaseManager } from './leases.ts';

export const MCP_VERSION = '0.12.1';
export const SHARED_PROFILE_WARNING = 'Agents share cookies, storage, service workers, downloads and authenticated sessions. Tabs are coordination, not security boundaries. Use separate workspaces for confidentiality.';
export const CAPABILITIES: Readonly<Record<string, { permission: string; mutation: boolean }>> = Object.freeze(Object.fromEntries([
  ...['list_pages', 'take_snapshot', 'take_screenshot', 'get_network_request', 'list_network_requests', 'get_console_message', 'list_console_messages', 'wait_for'].map(name => [name, { permission: 'automation', mutation: false }]),
  ...['click', 'drag', 'fill', 'fill_form', 'hover', 'press_key', 'navigate_page', 'new_page', 'close_page', 'select_page', 'handle_dialog', 'resize_page'].map(name => [name, { permission: 'automation', mutation: true }]),
  ['evaluate_script', { permission: 'script', mutation: true }], ['upload_file', { permission: 'files:upload', mutation: true }],
]));
/** Verify the server's initialize response, not a caller-supplied version assertion. */
export function validateMcpVersion(server: { name: string; version: string } | undefined) {
  if (!server || server.name !== 'chrome_devtools' || server.version !== MCP_VERSION) throw new Error('Upstream MCP identity/version mismatch');
}
export function validateCapabilityDiscovery(result: { tools: Array<{ name: string }> }) {
  const names = new Set(result.tools.map(t => t.name));
  if (names.size !== result.tools.length) throw new Error('Duplicate upstream tool');
  for (const name of Object.keys(CAPABILITIES)) if (!names.has(name)) throw new Error(`Required pinned MCP tool missing: ${name}`);
  // Extra tools remain unclassified and are filtered; never inherit upstream annotations.
}
export interface PageRecord { targetId: string; generation: string; browserId?: string; reconnectId?: string; connectionId?: string; expiresAt?: number; opener?: string }
/** Persist callback must atomically replace workspace ownership metadata before returning. */
export class PageOwnership {
  constructor(private audit: Audit, private load: (w: string) => PageRecord[], private save: (w: string, pages: PageRecord[]) => void, private now = () => Date.now()) {}
  pages(w: string) { return this.load(w).map(p => ({ ...p })); }
  opened(w: string, targetId: string, opener?: string, browserId?: string) { const pages = this.pages(w).filter(p => p.targetId !== targetId); const parent = pages.find(p => p.targetId === opener); const page: PageRecord = { targetId, generation: randomUUID(), browserId, opener, reconnectId: parent?.reconnectId, connectionId: parent?.connectionId, expiresAt: parent?.expiresAt }; this.audit(w, 'page.opened', 'browser', 'page ownership created'); this.save(w, [...pages, page]); }
  closed(w: string, target: string, generation: string) { this.audit(w, 'page.closed', 'browser', 'ownership invalidated'); this.save(w, this.pages(w).filter(p => p.targetId !== target || p.generation !== generation)); }
  claim(p: Principal, target: string) { const pages = this.pages(p.workspaceId); const page = pages.find(x => x.targetId === target); if (!page) throw new Error('Target lost'); if (page.reconnectId && page.reconnectId !== p.reconnectId && (!page.expiresAt || page.expiresAt > this.now())) { this.audit(p.workspaceId, 'page.conflict', p.connectionId, 'cross-owner claim'); throw new Error('Page owned by another agent'); } this.audit(p.workspaceId, 'page.claimed', p.connectionId, SHARED_PROFILE_WARNING); Object.assign(page, { reconnectId: p.reconnectId, connectionId: p.connectionId, expiresAt: undefined }); this.save(p.workspaceId, pages); }
  transfer(operator: Principal, target: string, owner?: Principal) { if (!operator.permissions.includes('takeover')) throw new Error('Permission denied'); if (owner && owner.workspaceId !== operator.workspaceId) throw new Error('Workspace mismatch'); const pages = this.pages(operator.workspaceId); const page = pages.find(p => p.targetId === target); if (!page) throw new Error('Target lost'); this.audit(operator.workspaceId, 'page.transferred', operator.connectionId, 'operator ownership change'); Object.assign(page, { reconnectId: owner?.reconnectId, connectionId: owner?.connectionId, expiresAt: undefined }); this.save(operator.workspaceId, pages); }
  disconnect(p: Principal, ttl = 60_000) { const pages = this.pages(p.workspaceId); for (const page of pages) if (page.connectionId === p.connectionId) { page.connectionId = undefined; page.expiresAt = this.now() + ttl; } this.audit(p.workspaceId, 'page.disconnected', p.connectionId, 'ownership reserved'); this.save(p.workspaceId, pages); }
  reconnect(p: Principal) { const pages = this.pages(p.workspaceId); for (const page of pages) if (page.reconnectId === p.reconnectId && page.expiresAt && page.expiresAt > this.now()) { page.connectionId = p.connectionId; page.expiresAt = undefined; } this.audit(p.workspaceId, 'page.reconnected', p.connectionId, SHARED_PROFILE_WARNING); this.save(p.workspaceId, pages); }
}
/** Protected control-sidecar CDP observer, never a public route. Metadata contains no URLs.
 * One observer per workspace. Persistence callbacks must serialize/commit synchronously.
 */
export async function connectPageOwnership(options: { workspaceId: string; browserUrl: string; ownership: PageOwnership; validate: (p: Principal) => void }) {
  const { WebSocket } = await import('ws');
  const endpoint = new URL(options.browserUrl);
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid private browser URL');
  const response = await fetch(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) throw new Error('Private CDP discovery failed');
  const info = await response.json() as { webSocketDebuggerUrl: string };
  const debuggerUrl = new URL(info.webSocketDebuggerUrl);
  // Never follow a debugger URL onto another host/port supplied by an upstream response.
  if (debuggerUrl.protocol !== 'ws:' || debuggerUrl.host !== endpoint.host || !debuggerUrl.pathname.startsWith('/devtools/browser/')) throw new Error('CDP debugger endpoint mismatch');
  const browserId = debuggerUrl.pathname;
  const socket = new WebSocket(debuggerUrl);
  let serial = 0; let failure: Error | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: Error) => { failure = error; for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  const ensure = (target: { targetId: string; type: string; openerId?: string }) => {
    if (target.type !== 'page') return;
    const existing = options.ownership.pages(options.workspaceId).find(p => p.targetId === target.targetId);
    if (!existing || existing.browserId !== browserId) options.ownership.opened(options.workspaceId, target.targetId, target.openerId, browserId);
  };
  socket.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.id) { const request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); if (message.error) request.reject(new Error('CDP request failed')); else request.resolve(message.result); } }
      else if (message.method === 'Target.targetCreated') ensure(message.params.targetInfo);
      else if (message.method === 'Target.targetDestroyed') { const page = options.ownership.pages(options.workspaceId).find(p => p.targetId === message.params.targetId && p.browserId === browserId); if (page) options.ownership.closed(options.workspaceId, page.targetId, page.generation); }
    } catch { fail(new Error('Page ownership observer failed')); socket.close(); }
  });
  socket.on('error', () => fail(new Error('Private CDP observer unavailable')));
  socket.on('close', () => fail(new Error('Private CDP observer closed')));
  const request = (method: string, params: Record<string, unknown> = {}): Promise<any> => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP ownership request timeout')); }, 5000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }), error => { if (error) fail(new Error('CDP observer send failed')); });
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); socket.once('close', () => reject(new Error('CDP observer closed before opening'))); });
    await request('Target.setDiscoverTargets', { discover: true });
    const snapshot = await request('Target.getTargets');
    const targets = snapshot.targetInfos as Array<{ targetId: string; type: string; openerId?: string }>;
    for (const target of targets) ensure(target);
    for (const page of options.ownership.pages(options.workspaceId)) if (!targets.some(t => t.type === 'page' && t.targetId === page.targetId)) options.ownership.closed(options.workspaceId, page.targetId, page.generation);
  } catch (error) { socket.close(); throw error; }
  return {
    async assign(p: Principal) {
      if (failure) throw failure;
      options.validate(p); if (p.workspaceId !== options.workspaceId) throw new Error('Workspace mismatch');
      options.ownership.reconnect(p);
      const owned = options.ownership.pages(p.workspaceId).find(page => page.connectionId === p.connectionId);
      if (owned) return owned;
      const target = await request('Target.createTarget', { url: 'about:blank' });
      options.validate(p); ensure({ targetId: target.targetId, type: 'page' });
      options.ownership.claim(p, target.targetId);
      return options.ownership.pages(p.workspaceId).find(page => page.targetId === target.targetId)!;
    },
    disconnect(p: Principal) { options.validate(p); if (p.workspaceId !== options.workspaceId) throw new Error('Workspace mismatch'); options.ownership.disconnect(p); },
    close() { fail(new Error('Page observer stopped')); socket.close(); },
  };
}
export interface Upstream { listTools(): Promise<{ tools: Array<{ name: string; [key: string]: unknown }> }>; callTool(args: { name: string; arguments: Record<string, unknown> }, ...rest: any[]): Promise<any>; close(): Promise<void> }
export interface GatewayOptions { principal: Principal; leases: LeaseManager; audit: Audit; validate: (p: Principal) => void; upstream: Upstream; validateUpload: (p: Principal, path: string) => Promise<string>; }
export class McpGateway {
  constructor(private options: GatewayOptions) {}
  private capability(name: string) { const o = this.options; o.validate(o.principal); const c = CAPABILITIES[name]; if (!Object.hasOwn(CAPABILITIES, name) || !c || !o.principal.permissions.includes(c.permission)) { o.audit(o.principal.workspaceId, 'mcp.denied', o.principal.connectionId, 'unclassified or unauthorized tool'); throw new Error('Tool denied'); } return c; }
  async listTools() { this.options.validate(this.options.principal); const result = await this.options.upstream.listTools(); return { tools: result.tools.filter(t => Object.hasOwn(CAPABILITIES, t.name) && this.options.principal.permissions.includes(CAPABILITIES[t.name]!.permission)) }; }
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const o = this.options; const c = this.capability(name); const controller = new AbortController(); let settled!: () => void; const done = new Promise<void>(resolve => { settled = resolve; });
    const end = c.mutation ? o.leases.beginMutation(o.principal, async () => {
      // SDK cancellation acknowledges local cancellation, not completion of browser-side effects.
      // Never grant human input on that acknowledgement alone. Operator can retry once settled.
      controller.abort(); await done; throw new Error('Browser mutation cancellation cannot prove quiescence; retry takeover');
    }) : () => {};
    try {
      o.audit(o.principal.workspaceId, 'mcp.started', o.principal.connectionId, name);
      const safe = { ...args };
      if (name === 'upload_file') { if (typeof safe.filePath !== 'string') throw new Error('filePath required'); safe.filePath = await o.validateUpload(o.principal, safe.filePath); }
      // MCP screenshot tool may otherwise write arbitrary paths inside the control sidecar.
      if (Object.hasOwn(safe, 'filePath') && name !== 'upload_file') throw new Error('Artifact path is not permitted');
      this.capability(name); if (c.mutation) o.leases.assertAutomation(o.principal); if (controller.signal.aborted) throw new Error('Preempted');
      const result = await o.upstream.callTool({ name, arguments: safe }, undefined, { signal: controller.signal });
      o.validate(o.principal); o.audit(o.principal.workspaceId, 'mcp.completed', o.principal.connectionId, name); return result;
    } catch (error) { o.audit(o.principal.workspaceId, 'mcp.failed', o.principal.connectionId, name); throw error; }
    finally { end(); settled(); }
  }
  close() { return this.options.upstream.close(); }
}
/** No npx/latest resolution at runtime. Executable must come from the locked release image. */
export async function connectChromeMcp(options: { executable: string; version: string; browserUrl: string }) {
  if (options.version !== MCP_VERSION) throw new Error('Unsupported MCP capability-map version');
  const url = new URL(options.browserUrl); if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid private CDP URL');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({ command: options.executable, args: [`--browserUrl=${url.origin}`], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' }, stderr: 'ignore' });
  const client = new Client({ name: 'browseruse-kit', version: '1.0.0' });
  try { await client.connect(transport); validateMcpVersion(client.getServerVersion()); validateCapabilityDiscovery(await client.listTools()); return client; } catch (e) { await transport.close(); throw e; }
}
/** One helper instance per authenticated HTTP session, never share between principals.
 * Integrator authenticates EVERY POST/GET/DELETE before calling transport.handleRequest,
 * validates Host/Origin/CSRF, and closes transport + gateway within 5s of revocation.
 */
export async function createStreamableMcp(gateway: McpGateway) {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name: 'browseruse-kit', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: SHARED_PROFILE_WARNING });
  server.setRequestHandler(ListToolsRequestSchema, () => gateway.listTools());
  server.setRequestHandler(CallToolRequestSchema, request => gateway.callTool(request.params.name, request.params.arguments));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await server.connect(transport);
  return { transport, server, close: async () => { await server.close(); await gateway.close(); } };
}
