import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, link, rename, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileService } from '../src/files.js';
import { CommandService, validateUtilityIsolation } from '../src/commands.js';

const actor = { workspaceId: 'w1', agentId: 'a1', connectionId: 'c1' };
async function setup(t: any, overrides: any = {}) {
  const base = await mkdtemp(join(tmpdir(), 'buk-files-'));
  const root = join(base, 'files'); const staging = join(base, 'staging');
  await mkdir(root); await mkdir(staging, { mode: 0o700 }); await mkdir(join(root, 'common'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const events: any[] = [];
  const files = new FileService({ workspaceId: 'w1', root, staging,
    quotaBytes: 100, maxFileBytes: 50, maxTransferBytes: 50,
    authorize: async () => {}, validateLease: async () => {},
    audit: async (e: any) => { events.push(e); }, ...overrides });
  return { files, root, staging, base, events };
}
async function* data(s: string) { yield Buffer.from(s); }
async function consume(source: AsyncIterable<Uint8Array>) { const out = []; for await (const c of source) out.push(Buffer.from(c)); return Buffer.concat(out).toString(); }

test('atomic upload, bounded download, listing and idempotent deletion', async t => {
  const { files, events } = await setup(t);
  assert.equal((await files.upload(actor, 'common/a', data('hello'))).size, 5);
  assert.equal(await consume(files.download(actor, 'common/a')), 'hello');
  assert.equal((await files.list(actor, 'common'))[0].name, 'a');
  await files.delete(actor, 'common/a'); await files.delete(actor, 'common/a');
  assert.ok(events.some(e => e.type === 'file.upload.completed'));
});

test('rejects traversal, absolute paths, symlink parents/leaves and hardlinks', async t => {
  const { files, root, base } = await setup(t);
  await writeFile(join(base, 'secret'), 'secret');
  await symlink(base, join(root, 'common', 'escape'));
  await symlink(join(base, 'secret'), join(root, 'common', 'leaf'));
  await link(join(base, 'secret'), join(root, 'common', 'hard'));
  for (const path of ['../secret', '/etc/passwd', 'common/../secret', 'common/escape/secret', 'common/leaf', 'common/hard']) {
    await assert.rejects(consume(files.download(actor, path)));
  }
  await assert.rejects(files.upload(actor, 'common/escape/new', data('x')));
  await assert.rejects(files.upload(actor, 'common/leaf', data('x')));
  assert.equal(await readFile(join(base, 'secret'), 'utf8'), 'secret');
});

test('failed and oversized streams preserve old committed file and clean staging', async t => {
  const { files, root } = await setup(t);
  await files.upload(actor, 'common/a', data('old'));
  await assert.rejects(files.upload(actor, 'common/a', data('x'.repeat(51))));
  async function* broken() { yield Buffer.from('new'); throw new Error('disconnected'); }
  await assert.rejects(files.upload(actor, 'common/a', broken()));
  assert.equal(await readFile(join(root, 'common/a'), 'utf8'), 'old');
  assert.equal((await files.quota(actor)).usedBytes, 3);
});

test('quota accounts for old file plus temporary replacement and concurrent uploads', async t => {
  const { files } = await setup(t, { quotaBytes: 8 });
  await files.upload(actor, 'common/a', data('12345'));
  await assert.rejects(files.upload(actor, 'common/a', data('1234')), /quota/);
  const results = await Promise.allSettled([
    files.upload(actor, 'common/b', data('123')), files.upload(actor, 'common/c', data('123')),
  ]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
});

test('audit failure, missing lease, wrong workspace and read authorization fail closed', async t => {
  const { files, root } = await setup(t, { audit: async () => { throw new Error('audit unavailable'); } });
  await assert.rejects(files.upload(actor, 'common/a', data('x')), /audit/);
  await assert.rejects(readFile(join(root, 'common/a')));
  await assert.rejects(files.upload({ ...actor, workspaceId: 'other' }, 'common/a', data('x')));
  const denied = await setup(t, { validateLease: async () => { throw new Error('lease'); }, authorize: async () => {} });
  await assert.rejects(denied.files.upload(actor, 'common/a', data('x')), /lease/);
  const readDenied = await setup(t, { authorize: async () => { throw new Error('unauthorized'); } });
  await assert.rejects(consume(readDenied.files.download(actor, 'common/a')), /unauthorized/);
});

test('revocation during streaming aborts upload without replacement', async t => {
  let allowed = true;
  const { files, root } = await setup(t, { authorize: async () => { if (!allowed) throw new Error('revoked'); } });
  async function* revoked() { yield Buffer.from('x'); allowed = false; yield Buffer.from('y'); }
  await assert.rejects(files.upload(actor, 'common/a', revoked()), /revoked/);
  await assert.rejects(readFile(join(root, 'common/a')));
});

test('parent descriptor prevents a directory/symlink swap from redirecting commit', async t => {
  const { files, root, base } = await setup(t);
  const outside = join(base, 'outside'); await mkdir(outside);
  async function* swapped() {
    await rename(join(root, 'common'), join(root, 'old-common'));
    await symlink(outside, join(root, 'common'));
    yield Buffer.from('safe');
  }
  await files.upload(actor, 'common/a', swapped());
  assert.equal(await readFile(join(root, 'old-common/a'), 'utf8'), 'safe');
  assert.deepEqual(await readdir(outside), []);
});

test('stalled upload times out and removes staging data', async t => {
  const { files, staging } = await setup(t, { transferTimeoutMs: 30 });
  const stalled = { [Symbol.asyncIterator]() { return { next: () => new Promise<any>(() => {}) }; } };
  await assert.rejects(files.upload(actor, 'common/a', stalled), /timeout/);
  assert.deepEqual(await readdir(staging), []);
});

test('download size bound and authorization are rechecked between chunks', async t => {
  let authorized = true;
  const { files, root } = await setup(t, { authorize: async () => { if (!authorized) throw new Error('revoked'); } });
  await writeFile(join(root, 'common/large'), 'x'.repeat(51));
  await assert.rejects(consume(files.download(actor, 'common/large')), /size/);
  await files.upload(actor, 'common/a', data('abc'));
  const iterator = files.download(actor, 'common/a');
  assert.equal((await iterator.next()).value?.toString(), 'abc'); authorized = false;
  await assert.rejects(iterator.next(), /revoked/);
});

test('commands reject invalid identities, unauthorized requests and audit failure before spawning', async () => {
  const options = { workspaceId: 'w1', container: 'buk-utility-w1', runtime: 'docker' as const,
    authorize: async () => {}, validateLease: async () => {}, audit: async () => { throw new Error('audit'); } };
  const service = new CommandService(options);
  await assert.rejects(service.start(actor, { command: 'echo hi' }), /audit/);
  await assert.rejects(service.start({ ...actor, agentId: '../escape' }, { command: 'id' }));
  assert.throws(() => new CommandService({ ...options, container: '--privileged' }));
  assert.throws(() => new CommandService({ ...options, user: '0:0' }));
});

// Opt-in real OCI integration; uses only a disposable --rm container and tmpfs.
test('real OCI utility commands: non-root, bounded output, timeout, cancellation, revocation',
  { skip: !process.env.BUK_TEST_OCI, timeout: 60_000 }, async t => {
    const runtime = process.env.BUK_TEST_OCI as 'docker' | 'podman';
    assert.ok(['docker', 'podman'].includes(runtime));
    const workspaceId = `test-${randomUUID()}`;
    const actor = { workspaceId, agentId: 'a1', connectionId: 'c1' };
    const container = `buk-${workspaceId}-utility`; const volume = `buk-${workspaceId}-files`;
    const cli = (...args: string[]) => execFileSync(runtime, args, { encoding: 'utf8', timeout: 15_000 });
    cli('volume', 'create', volume);
    t.after(() => { try { cli('kill', container); } catch {} try { cli('rm', '-f', container); } catch {} cli('volume', 'rm', volume); });
    cli('run', '--rm', '-d', '--name', container, '--label', `browseruse.workspace=${workspaceId}`, '--network=none', '--read-only',
      '--cap-drop=all', '--security-opt=no-new-privileges', '--user=1000:1000',
      '--memory=128m', '--cpus=.25', '--pids-limit=64', '--tmpfs=/tmp:rw,nosuid,nodev,mode=1777',
      '-v', `${volume}:/workspace`, process.env.BUK_TEST_IMAGE ?? 'browseruse-utility:local',
      'sh', '-c', 'mkdir -p /workspace/agents/a1 /workspace/common; exec sleep infinity');
    let authorized = true; const events: any[] = [];
    const service = new CommandService({ workspaceId, container, runtime, maxOutputBytes: 32,
      timeoutMs: 8_000, authorize: async () => { if (!authorized) throw new Error('revoked'); },
      validateLease: async () => {}, audit: async e => { events.push(e); },
      sanitizeOutput: s => s.replace(/secret/g, '[redacted]') });
    const run = async (command: string, timeoutMs?: number) => {
      const { id } = await service.start(actor, { command, timeoutMs }); return service.wait(actor, id);
    };
    assert.match((await run('id -u')).output, /1000/);
    const oldSecret = process.env.BUK_COMMAND_SECRET;
    process.env.BUK_COMMAND_SECRET = 'must-not-enter-utility';
    try { assert.equal((await run('printf "%s" "${BUK_COMMAND_SECRET-unset}"')).output, 'unset'); }
    finally { if (oldSecret === undefined) delete process.env.BUK_COMMAND_SECRET; else process.env.BUK_COMMAND_SECRET = oldSecret; }
    const background = await run('sleep 20 & echo $! > /workspace/common/background.pid; exit 0');
    assert.equal(background.status, 'completed');
    assert.equal(cli('exec', container, 'sh', '-c',
      'p=$(cat /workspace/common/background.pid); if [ -f "/proc/$p/stat" ]; then read -r pid comm state rest < "/proc/$p/stat"; [ "$state" = Z ] || exit 1; fi; printf reaped'), 'reaped');
    const flooded = await run("printf secret; head -c 1024 /dev/zero");
    assert.ok(flooded.truncated); assert.ok(Buffer.byteLength(flooded.output) <= 32);
    assert.ok(!flooded.output.includes('secret'));
    const timed = await run('sleep 20 & wait', 100);
    assert.equal(timed.status, 'timed_out');
    const { id } = await service.start(actor, { command: 'sleep 20 & wait' });
    // Prove the process group exists before testing the cancellation path.
    for (let n = 0; n < 100; n++) {
      try { cli('exec', container, 'test', '-s', `/tmp/buk-command-${id}.pid`); break; }
      catch { if (n === 99) throw new Error('command group did not start'); }
    }
    await service.cancel(actor, id); assert.equal((await service.wait(actor, id)).status, 'cancelled');
    const rev = await service.start(actor, { command: 'sleep 20' });
    authorized = false;
    await assert.rejects(service.inspect(actor, rev.id), /revoked/);
    // The lease/auth watchdog cancels within five seconds, then observer authority can be restored.
    await new Promise(resolve => setTimeout(resolve, 4_000)); authorized = true;
    assert.equal((await service.wait(actor, rev.id)).status, 'cancelled');
    assert.ok(events.some(e => e.type === 'command.completed'));
    assert.ok(!JSON.stringify(events).includes('printf secret'));
  });


test('isolation helper denies browser networks, profile/socket mounts, secrets and unsafe network topology', () => {
  const c: any = { State: { Running: true }, Name: '/buk-w1-utility', Config: { User: '1000:1000', Env: ['PATH=/usr/bin'], Labels: { 'browseruse.workspace': 'w1' } },
    HostConfig: { NetworkMode: 'buk-w1-utility', PidMode: 'private', IpcMode: 'private', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true, Memory: 100, PidsLimit: 64, NanoCpus: 100, Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=128m' } },
    Mounts: [{ Type: 'volume', Name: 'buk-w1-files', Destination: '/workspace', RW: true }],
    NetworkSettings: { Networks: { 'buk-w1-utility': {} } } };
  const network: any = { Name: 'buk-w1-utility', Internal: true, Containers: { id: { Name: 'buk-w1-utility' }, proxy: { Name: 'buk-w1-egress' } } };
  const options = { workspaceId: 'w1', runtime: 'docker' as const, networkInspection: network };
  assert.doesNotThrow(() => validateUtilityIsolation(c, options));
  for (const change of [
    (x: any) => { x.HostConfig.NetworkMode = 'host'; },
    (x: any) => { x.NetworkSettings.Networks['buk-w1-browser'] = {}; },
    (x: any) => { x.Mounts.push({ Type: 'volume', Name: 'buk-w1-profile', Destination: '/profile' }); },
    (x: any) => { x.Mounts[0] = { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/workspace' }; },
    (x: any) => { x.Config.Env.push('CONTROL_TOKEN=secret'); },
    (x: any) => { x.HostConfig.Tmpfs['/workspace/profile'] = 'rw'; },
    (x: any) => { x.Config.User = '0:0'; },
    (x: any) => { x.Config.Labels['browseruse.workspace'] = 'other'; },
    (x: any) => { x.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    (x: any) => { x.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
  ]) { const bad = structuredClone(c); change(bad); assert.throws(() => validateUtilityIsolation(bad, options)); }
  assert.throws(() => validateUtilityIsolation(c, { ...options, networkInspection: { ...network, Internal: false } }));
  assert.throws(() => validateUtilityIsolation(c, { ...options, networkInspection: { ...network, Containers: { bad: { Name: 'buk-w1-browser' } } } }));
  assert.throws(() => validateUtilityIsolation(c, { workspaceId: 'w1', runtime: 'docker' }));
});
