import test from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager, type Principal } from '../src/leases.ts';
import { McpGateway, PageOwnership, validateMcpVersion, validateCapabilityDiscovery, CAPABILITIES, MCP_VERSION } from '../src/mcp.ts';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RfbInputGate } from '../src/viewer.ts';
const principal = (id = 'agent'): Principal => ({ workspaceId: 'w', subject: id, connectionId: id, reconnectId: id, permissions: ['automation', 'takeover', 'files:upload'] });

test('leases expire, human preempts, fresh automation required; audit fails closed', async () => {
  let time = 0; let fail = false; const leases = new LeaseManager(() => { if (fail) throw Error('disk full'); }, () => {}, () => time);
  const p = principal(); leases.acquireAutomation(p); leases.assertAutomation(p);
  time = 60_001; assert.throws(() => leases.assertAutomation(p)); leases.acquireAutomation(p);
  const human = await leases.acquireHuman(principal('operator')); assert.throws(() => leases.assertAutomation(p));
  assert.throws(() => leases.acquireAutomation(p)); leases.release(principal('operator')); assert.throws(() => leases.assertAutomation(p));
  fail = true; assert.throws(() => leases.acquireAutomation(p)); fail = false; assert.throws(() => leases.assertAutomation(p));
  assert.ok(human.id);
});

test('takeover cancels active mutation before granting input', async () => {
  const leases = new LeaseManager(() => {}, () => {}); const p = principal(); leases.acquireAutomation(p);
  let cancelled = false; leases.beginMutation(p, async () => { cancelled = true; });
  await leases.acquireHuman(principal('operator')); assert.equal(cancelled, true); leases.assertHuman(principal('operator'));
});

test('RFB fragmented/coalesced messages never replay denied input; every event revalidated', () => {
  let allowed = false; let valid = true; const sent: Buffer[] = []; let checks = 0;
  const gate = new RfbInputGate(principal(), () => { if (!valid) throw Error('revoked'); }, () => { checks++; if (!allowed) throw Error('no lease'); }, b => sent.push(b));
  const handshake = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);
  for (const b of handshake) gate.push(Buffer.from([b]));
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]); const pointer = Buffer.from([5, 0, 0, 1, 0, 2]);
  gate.push(key.subarray(0, 3)); gate.push(Buffer.concat([key.subarray(3), pointer])); assert.equal(checks, 2); assert.equal(sent.length, 3);
  allowed = true; gate.push(key); assert.equal(sent.length, 4); valid = false; assert.throws(() => gate.push(pointer)); assert.equal(sent.length, 4);
});

test('RFB rejects unknown messages and oversized clipboard', () => {
  const make = () => new RfbInputGate(principal(), () => {}, () => {}, () => {}, true);
  assert.throws(() => make().push(Buffer.from([255])));
  assert.throws(() => make().push(Buffer.from([6, 0, 0, 0, 255, 255, 255, 255])));
});

test('MCP unknown/script tools denied; leases and approved upload required; audit failure prevents dispatch', async () => {
  let calls = 0; let auditFailed = false;
  const audit = () => { if (auditFailed) throw Error('disk'); };
  const leases = new LeaseManager(audit, () => {}); const p = principal();
  const gateway = new McpGateway({ principal: p, leases, audit, validate: () => {}, validateUpload: async (_, path) => { if (path !== '/workspace/input/a') throw Error('path denied'); return path; }, upstream: { listTools: async () => ({ tools: ['click', 'evaluate_script', 'future', 'list_pages'].map(name => ({ name })) }), callTool: async () => { calls++; return { content: [] }; }, close: async () => {} } });
  assert.deepEqual((await gateway.listTools()).tools.map(t => t.name), ['click', 'list_pages']);
  await assert.rejects(gateway.callTool('future')); await assert.rejects(gateway.callTool('evaluate_script')); await assert.rejects(gateway.callTool('click'));
  leases.acquireAutomation(p); await assert.rejects(gateway.callTool('upload_file', { filePath: '/etc/passwd' })); await assert.rejects(gateway.callTool('take_screenshot', { filePath: '/tmp/x' }));
  await gateway.callTool('click'); assert.equal(calls, 1); auditFailed = true; await assert.rejects(gateway.callTool('click')); assert.equal(calls, 1);
});

test('MCP upload uses protected path and cleans up after success, upstream failure and revalidation denial',async()=>{
 const p=principal();const leases=new LeaseManager(()=>{},()=>{});leases.acquireAutomation(p);let valid=true,fail=false,cleanups=0,calls=0;
 const gateway=new McpGateway({principal:p,leases,audit:()=>{},validate:()=>{if(!valid)throw Error('revoked');},
  validateUpload:async()=>({path:'/tmp/browser-only/paper.pdf',cleanup:async()=>{cleanups++;}}),
  upstream:{listTools:async()=>({tools:[]}),close:async()=>{},callTool:async(args)=>{calls++;assert.equal(args.arguments.filePath,'/tmp/browser-only/paper.pdf');assert.equal(cleanups,calls-1);if(fail)throw Error('target lost');return {content:[]};}}});
 await gateway.callTool('upload_file',{filePath:'input/paper.pdf'});assert.equal(cleanups,1);
 fail=true;await assert.rejects(gateway.callTool('upload_file',{filePath:'input/paper.pdf'}),/target lost/);assert.equal(cleanups,2);
 const revoked=new McpGateway({principal:p,leases,audit:()=>{},validate:()=>{if(!valid)throw Error('revoked');},validateUpload:async()=>{valid=false;return {path:'/tmp/protected',cleanup:async()=>{cleanups++;}};},upstream:{listTools:async()=>({tools:[]}),close:async()=>{},callTool:async()=>{throw Error('must not dispatch');}}});
 await assert.rejects(revoked.callTool('upload_file',{filePath:'input/a'}),/revoked/);assert.equal(cleanups,3);assert.equal(calls,2);
});

test('MCP upload cleanup failure is audited and still releases lifecycle admission',async()=>{
 const p=principal();const leases=new LeaseManager(()=>{},()=>{});leases.acquireAutomation(p);const events:string[]=[];let released=false;
 const gateway=new McpGateway({principal:p,leases,audit:(_w,type)=>{events.push(type);},validate:()=>{},beginOperation:()=>()=>{released=true;},
  validateUpload:async()=>({path:'/tmp/protected',cleanup:async()=>{throw Error('cleanup unavailable');}}),upstream:{listTools:async()=>({tools:[]}),callTool:async()=>({content:[]}),close:async()=>{}}});
 await assert.rejects(gateway.callTool('upload_file',{filePath:'input/a'}),/cleanup unavailable/);assert.ok(released);assert.ok(events.includes('mcp.upload.cleanup_failed'));
});

test('MCP lifecycle admission holds read calls and discovery until settlement and rejects before dispatch', async () => {
  const p=principal();const leases=new LeaseManager(()=>{},()=>{});let active=0,admit=true,calls=0;
  let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
  const gateway=new McpGateway({principal:p,leases,audit:()=>{},validate:()=>{},validateUpload:async(_,path)=>path,
    beginOperation:()=>{if(!admit)throw Error('stopping');active++;return ()=>{active--;};},
    upstream:{listTools:async()=>{calls++;await wait;return {tools:[]};},callTool:async()=>{calls++;await wait;throw Error('upstream failed');},close:async()=>{}}});
  const discovery=gateway.listTools();const call=gateway.callTool('list_pages');const failed=assert.rejects(call,/upstream failed/);
  assert.equal(active,2);release();await discovery;await failed;assert.equal(active,0);
  admit=false;await assert.rejects(gateway.listTools(),/stopping/);await assert.rejects(gateway.callTool('list_pages'),/stopping/);assert.equal(calls,2);
});

test('ownership durable reconnect, expiry, conflicts and generation protect reused targets', () => {
  let data: any[] = []; let time = 0;
  const pages = new PageOwnership(() => {}, () => structuredClone(data), (_, rows) => { data = structuredClone(rows); }, () => time);
  const p = principal(); pages.opened('w', 'tab'); pages.claim(p, 'tab'); const old = pages.pages('w')[0]!.generation;
  pages.disconnect(p); pages.reconnect({ ...p, connectionId: 'new' }); assert.equal(pages.pages('w')[0]!.connectionId, 'new');
  assert.throws(() => pages.claim(principal('other'), 'tab'));
  pages.opened('w', 'popup', 'tab'); assert.equal(pages.pages('w')[1]!.reconnectId, p.reconnectId);
  pages.disconnect({ ...p, connectionId: 'new' }); time = 61_000; pages.claim(principal('other'), 'tab');
  pages.opened('w', 'tab'); pages.closed('w', 'tab', old); assert.ok(pages.pages('w').find(p => p.targetId === 'tab'));
});

test('validate actual MCP identity and complete pinned capability discovery', () => {
  validateMcpVersion({ name: 'chrome_devtools', version: MCP_VERSION });
  assert.throws(() => validateMcpVersion({ name: 'chrome_devtools', version: '99.0.0' }));
  assert.throws(() => validateMcpVersion(undefined));
  const tools = Object.keys(CAPABILITIES).map(name => ({ name }));
  validateCapabilityDiscovery({ tools: [...tools, { name: 'unknown_future_tool' }] });
  assert.throws(() => validateCapabilityDiscovery({ tools: tools.slice(1) }));
  assert.throws(() => validateCapabilityDiscovery({ tools: [...tools, tools[0]!] }));
});

test('MCP abort acknowledgement alone cannot grant human control', async () => {
  const p = principal(); const leases = new LeaseManager(() => {}, () => {}); leases.acquireAutomation(p);
  let started!: () => void; const ready = new Promise<void>(r => { started = r; });
  const gateway = new McpGateway({ principal: p, leases, audit: () => {}, validate: () => {}, validateUpload: async (_, path) => path,
    upstream: { listTools: async () => ({ tools: [] }), close: async () => {}, callTool: async (_args, _schema, options) => new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }); started(); }) } });
  const call = gateway.callTool('click'); const rejected = assert.rejects(call); await ready;
  await assert.rejects(leases.acquireHuman(principal('operator')), /quiescence/); await rejected;
  assert.throws(() => leases.assertHuman(principal('operator'))); assert.throws(() => leases.assertAutomation(p));
});

test('live official MCP initialize + headful Chrome over private pipe, sandbox enabled', { skip: process.env.BUK_LIVE_MCP !== '1', timeout: 45000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const profile = await mkdtemp(join(tmpdir(), 'buk-mcp-test-'));
  const transport = new StdioClientTransport({ command: resolve('node_modules/.bin/chrome-devtools-mcp'), args: [`--userDataDir=${profile}`, `--executablePath=${process.env.BUK_CHROME ?? '/usr/bin/google-chrome'}`], env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.env.HOME ?? tmpdir(), DISPLAY: process.env.DISPLAY ?? ':0', XAUTHORITY: process.env.XAUTHORITY ?? '' }, stderr: 'pipe' });
  const client = new Client({ name: 'gateway-test', version: '1' });
  try {
    await client.connect(transport); validateMcpVersion(client.getServerVersion()); validateCapabilityDiscovery(await client.listTools());
    const pages = await client.callTool({ name: 'list_pages', arguments: {} }); assert.ok(!pages.isError, JSON.stringify(pages));
    const navigated = await client.callTool({ name: 'navigate_page', arguments: { url: 'chrome://sandbox' } }); assert.ok(!navigated.isError, JSON.stringify(navigated));
    const diagnostic = await client.callTool({ name: 'evaluate_script', arguments: { function: '() => document.body.innerText' } });
    assert.ok(!diagnostic.isError, JSON.stringify(diagnostic));
    const text = JSON.stringify(diagnostic.content); t.diagnostic(text);
    assert.match(text, /adequately sandboxed|SUID Sandbox.*Yes|Namespace Sandbox.*Yes/i);
    const version = await client.callTool({ name: 'navigate_page', arguments: { url: 'chrome://version' } }); assert.ok(!version.isError);
    const args = await client.callTool({ name: 'evaluate_script', arguments: { function: '() => document.getElementById("command_line").innerText' } });
    const command = JSON.stringify(args.content); assert.doesNotMatch(command, /--no-sandbox/); assert.match(command, /--remote-debugging-pipe/); assert.match(command, /--user-data-dir/);
  } finally { await client.close(); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('live x11vnc RFB 3.8 handshake, framebuffer and server-side mouse lease gating', { skip: process.env.BUK_LIVE_RFB !== '1', timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buk-rfb-test-'));
  const display = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '640x480x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  let vnc: ReturnType<typeof spawn> | undefined; let socket: ReturnType<typeof connect> | undefined;
  try {
    const displayPipe = display.stdio[3]!;
    const [line] = await once(displayPipe, 'data'); const env = { ...process.env, DISPLAY: `:${String(line).trim()}` };
    const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = (reservation.address() as { port: number }).port; await new Promise<void>(r => reservation.close(() => r()));
    vnc = spawn('x11vnc', ['-display', env.DISPLAY, '-localhost', '-rfbport', String(port), '-forever', '-shared', '-nopw', '-noxdamage', '-noclipboard'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await Promise.race([new Promise<void>(r => { let output = ''; vnc!.stdout!.on('data', b => { output += b; if (output.includes('PORT=')) r(); }); }), once(vnc, 'exit').then(() => { throw Error('x11vnc exited before readiness'); })]);
    socket = connect({ host: '127.0.0.1', port }); await once(socket, 'connect');
    let buffer = Buffer.alloc(0); let notify: (() => void) | undefined;
    socket.on('data', b => { buffer = Buffer.concat([buffer, b]); notify?.(); });
    const read = async (size: number) => { while (buffer.length < size) await new Promise<void>(r => { notify = r; }); const data = buffer.subarray(0, size); buffer = buffer.subarray(size); return data; };
    let now = 0; const leases = new LeaseManager(() => {}, () => {}, () => now); const p = principal('operator'); let valid = true;
    const gate = new RfbInputGate(p, () => { if (!valid) throw Error('credential revoked'); }, who => leases.assertHuman(who), b => { socket!.write(b); });
    assert.equal((await read(12)).toString(), 'RFB 003.008\n');
    for (const byte of Buffer.from('RFB 003.008\n')) gate.push(Buffer.from([byte]));
    const count = (await read(1))[0]!; assert.ok((await read(count)).includes(1)); gate.push(Buffer.from([1])); assert.equal((await read(4)).readUInt32BE(), 0);
    gate.push(Buffer.from([1])); const init = await read(24); assert.equal(init.readUInt16BE(), 640); await read(init.readUInt32BE(20));
    // A framebuffer request provides a protocol barrier after earlier input on this socket.
    const barrier = async () => { gate.push(Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1])); assert.equal((await read(4))[0], 0); const rectangle = await read(12); assert.equal(rectangle.readInt32BE(8), 0); await read(rectangle.readUInt16BE(4) * rectangle.readUInt16BE(6) * 4); };
    const pointer = (x: number, y: number) => Buffer.from([5, 0, x >> 8, x & 255, y >> 8, y & 255]);
    await leases.acquireHuman(p); const move = pointer(100, 100); gate.push(move.subarray(0, 2)); gate.push(move.subarray(2)); await barrier();
    const position = () => execFileSync('xdotool', ['getmouselocation', '--shell'], { env }).toString(); assert.match(position(), /X=100\nY=100/);
    now = 30001; gate.push(pointer(200, 200)); await barrier(); assert.match(position(), /X=100\nY=100/);
    await leases.acquireHuman(p); await barrier(); assert.match(position(), /X=100\nY=100/); // denied input not replayed
    valid = false; assert.throws(() => gate.push(pointer(250, 250))); assert.match(position(), /X=100\nY=100/);
  } finally {
    socket?.destroy(); if (vnc && vnc.exitCode === null) { vnc.kill(); await once(vnc, 'exit'); }
    if (display.exitCode === null) { display.kill(); await once(display, 'exit'); } await rm(directory, { recursive: true, force: true });
  }
});
