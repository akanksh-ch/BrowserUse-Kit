import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { RootlessPodmanControl, FIREWALL_PIPE_RELAY } from '../src/rootless-control.ts';

const inspection = () => ({ State: { Running: true, Pid: 1234 }, Config: { Labels: { 'browseruse.workspace': 'one' } },
  HostConfig: { Privileged: false, NetworkMode: 'buk-one-browser', PortBindings: {} },
  NetworkSettings: { Networks: { 'buk-one-browser': { IPAddress: '10.89.0.2' } } } });

test('rootless control uses owning user namespace and separate rootless bridge netns', async () => {
  const calls: [string, string[]][] = [];
  const c = inspection();
  const control = new RootlessPodmanControl(async (file, args) => {
    calls.push([file, args]);
    if (args[0] === 'info') return 'true\n';
    if (args[0] === 'inspect') return JSON.stringify([c]);
    return args.includes('iptables') ? '-P OUTPUT DROP\n' : 'probe-result';
  });
  assert.equal(await control.firewall('one', 'browser', 'iptables'), '-P OUTPUT DROP\n');
  assert.deepEqual(calls.at(-1), ['podman', ['unshare', 'python3', '-c', FIREWALL_PIPE_RELAY, 'nsenter', '-t', '1234', '-n', 'iptables', '-S', 'OUTPUT']]);
  assert.equal(await control.probe('one', address => ({ file: 'trusted-probe', args: [address, ';not-a-shell'] })), 'probe-result');
  assert.deepEqual(calls.at(-1), ['podman', ['unshare', '--rootless-netns', 'trusted-probe', '10.89.0.2', ';not-a-shell']]);
  c.HostConfig.PortBindings = { '9223/tcp': [] } as any;
  await assert.rejects(control.probe('one', () => ({ file: 'trusted', args: [] })), /Unsafe/);
});

test('namespace helper refuses unsafe identities, rootful fallback and malformed selection', async () => {
  let c = inspection(); let rootless = true; let commands = 0;
  const control = new RootlessPodmanControl(async (_file, args) => {
    if (args[0] === 'info') return String(rootless);
    if (args[0] === 'inspect') return JSON.stringify([c]);
    commands++; return '';
  });
  for (const mutate of [
    () => { c.Config.Labels['browseruse.workspace'] = 'other'; },
    () => { c.State.Running = false; },
    () => { c.State.Pid = 1; },
    () => { c.HostConfig.Privileged = true; },
    () => { c.HostConfig.NetworkMode = 'host'; },
    () => { (c.NetworkSettings.Networks as any).extra = { IPAddress: '10.1.0.1' }; },
  ]) {
    c = inspection(); mutate();
    await assert.rejects(control.firewall('one', 'browser', 'iptables'), /Unsafe/);
  }
  c = inspection(); rootless = false;
  await assert.rejects(control.firewall('one', 'browser', 'iptables'), /Rootless/);
  await assert.rejects(control.firewall('../escape', 'browser', 'iptables'), /Invalid/);
  await assert.rejects(control.firewall('one', 'browser', 'sh' as any), /Invalid/);
  assert.equal(commands, 0);
  rootless = true;
  await assert.rejects(control.firewall('one', 'browser', 'iptables'), /Firewall rules unavailable/);
});

test('anonymous-pipe firewall relay retains stdout, stderr and failure status', async () => {
  const execute = promisify(execFile);
  const ok = await execute('python3', ['-c', FIREWALL_PIPE_RELAY, 'python3', '-c', 'import sys;print("rules");sys.stderr.write("diagnostic\\n")']);
  assert.equal(ok.stdout, 'rules\n'); assert.equal(ok.stderr, 'diagnostic\n');
  await assert.rejects(execute('python3', ['-c', FIREWALL_PIPE_RELAY, 'python3', '-c', 'import sys;sys.stderr.write("denied");sys.exit(7)']), (error: any) => error.code === 7 && error.stderr === 'denied');
  await assert.rejects(execute('python3', ['-c', FIREWALL_PIPE_RELAY, 'python3', '-c', 'print("x"*262145)']), (error: any) => error.code === 125 && error.stdout === '');
});

test('live rootless service identity: private bridge HTTP/RFB-shaped probe and namespace firewall read', {
  skip: process.env.BUK_LIVE_ROOTLESS_CONTROL !== '1', timeout: 40_000,
}, async t => {
  const execute = promisify(execFile);
  const run = async (file: string, args: string[]) => String((await execute(file, args, { timeout: 10_000, maxBuffer: 256 * 1024, killSignal: 'SIGKILL' })).stdout);
  const workspace = `control-${randomUUID()}`, name = `buk-${workspace}-browser`;
  const image = process.env.BUK_CONTROL_TEST_IMAGE ?? 'browseruse-egress:local';
  const uid = process.getuid!();
  assert.notEqual(uid, 0, 'Run from the actual non-root service identity');
  assert.equal((await run('podman', ['info', '--format', '{{.Host.Security.Rootless}}'])).trim(), 'true');
  let network = false, container = false;
  try {
    await run('podman', ['network', 'create', '--internal', name]); network = true;
    const program = 'import socketserver,threading,http.server,time\nclass R(socketserver.BaseRequestHandler):\n def handle(self): self.request.sendall(b"RFB 003.008\\n")\nr=socketserver.TCPServer(("0.0.0.0",18889),R)\nthreading.Thread(target=r.serve_forever,daemon=True).start()\nhttp.server.HTTPServer(("0.0.0.0",18888),http.server.BaseHTTPRequestHandler).serve_forever()';
    await run('podman', ['run', '-d', '--name', name, '--label', `browseruse.workspace=${workspace}`, '--network', name,
      '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '1000:1000',
      '--memory', '128m', '--pids-limit', '32', '--cpus', '1', '--entrypoint', 'python3', image, '-u', '-c', program]); container = true;
    assert.equal((await run('podman', ['port', name])).trim(), '');
    const [inspected] = JSON.parse(await run('podman', ['inspect', name]));
    const pid = String(inspected.State.Pid);
    const address = inspected.NetworkSettings.Networks[name].IPAddress;
    try {
      await run('python3', ['-c', 'import socket,sys;socket.create_connection((sys.argv[1],18888),.5).close()', address]);
      t.diagnostic('Direct host route reachable on this configuration; no routing failure inferred.');
    } catch { t.diagnostic('Direct host TCP probe failed; rootless bridge probe below must succeed.'); }
    await assert.rejects(run('nsenter', ['-t', pid, '-n', 'iptables', '-S', 'OUTPUT']), /Operation not permitted/);
    // Mirror the runtime's policy in this fixture only, then verify actual readback.
    for (const family of ['iptables', 'ip6tables']) {
      const prefix = ['unshare', 'nsenter', '-t', pid, '-n', family];
      await run('podman', [...prefix, '-P', 'OUTPUT', 'DROP']);
      await run('podman', [...prefix, '-A', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
      await run('podman', [...prefix, '-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
    }
    const control = new RootlessPodmanControl(run);
    const probe = 'import socket,sys,time,http.client\nip=sys.argv[1]\nfor i in range(40):\n try:\n  c=http.client.HTTPConnection(ip,18888,timeout=1);c.request("GET","/");assert c.getresponse().status==501;c.close()\n  s=socket.create_connection((ip,18889),1);assert s.recv(12)==b"RFB 003.008\\n";s.close();print("private-control-ok");break\n except OSError:\n  if i==39: raise\n  time.sleep(.1)';
    assert.equal((await control.probe(workspace, address => ({ file: 'python3', args: ['-c', probe, address] }))).trim(), 'private-control-ok');
    for (const family of ['iptables', 'ip6tables'] as const) {
      const rules = await run('podman', ['unshare', 'nsenter', '-t', pid, '-n', family, '-S', 'OUTPUT']);
      if (!rules.trim()) t.diagnostic(`${family} direct capture is empty; validating anonymous-pipe relay instead.`);
      const actual = await control.firewall(workspace, 'browser', family);
      assert.match(actual, /-P OUTPUT DROP/);
      assert.match(actual, /--ctstate (ESTABLISHED,RELATED|RELATED,ESTABLISHED) -j ACCEPT/);
      assert.match(actual, /-o lo -j ACCEPT/);
    }
    assert.equal(process.getuid!(), uid, 'Host service identity must not change');
  } finally {
    try { if (container) await run('podman', ['rm', '-f', '-t', '0', name]); }
    finally { if (network) await run('podman', ['network', 'rm', name]); }
  }
});
