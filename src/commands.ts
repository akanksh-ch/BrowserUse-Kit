import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { FileActor, OperationEvent, SecurityHooks } from './files.ts';

export interface CommandServiceOptions extends SecurityHooks {
  workspaceId: string; runtime: 'docker' | 'podman'; container: string;
  user?: string; timeoutMs?: number; maxOutputBytes?: number; maxConcurrent?: number;
  maxHistory?: number;
  /** Optional additional administrator policy; built-in isolation validation always runs.
   * Never import a verifier from an untrusted environment or request. */
  validateIsolation?: (inspection: Record<string, any>) => void | Promise<void>;
  sanitizeOutput?: (text: string) => string;
  /** Credential-free internal policy proxy; direct networking must still be blocked. */
  egressProxy?: string;
}
export interface CommandRequest { command: string; cwd?: string; timeoutMs?: number }
export interface CommandResult {
  id: string; workspaceId: string; agentId: string; connectionId: string; cwd: string;
  commandHash: string; startedAt: string; durationMs: number; status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  exitCode: number | null; output: string; truncated: boolean;
}
interface Running { result: CommandResult; done: Promise<CommandResult>; stopping: boolean; stop?: Promise<void> }
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const cleanEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  // Rootless Podman uses these non-secret, host-only locator variables.
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}) };

export interface UtilityIsolationOptions {
  workspaceId: string; runtime: 'docker' | 'podman'; user?: string;
  /** Trusted OCI network-inspect output, required unless the container uses network=none. */
  networkInspection?: Record<string, any>;
}

/** Validate the reference deployment, not a client-supplied attestation. Network inspect
 * establishes the private bridge boundary; host firewall/proxy behavior and filesystem
 * quotas still need deployment acceptance tests, not claims inferred from JSON. */
export function validateUtilityIsolation(c: Record<string, any>, options: UtilityIsolationOptions): void {
  const w = options.workspaceId;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(w)) throw new Error('invalid workspace identity');
  const prefix = `buk-${w}`; const h = c?.HostConfig;
  if (!c?.State?.Running || !h || c.Name?.replace(/^\//, '') !== `${prefix}-utility` || c.Config?.Labels?.['browseruse.workspace'] !== w) throw new Error('utility workspace identity mismatch');
  if (c.Config.User !== (options.user ?? '1000:1000')) throw new Error('utility identity mismatch');
  if (h.Privileged || !['', 'private'].includes(h.PidMode ?? '') || !['', 'private', 'shareable'].includes(h.IpcMode ?? '') || h.UsernsMode === 'host' || h.UTSMode === 'host' || h.CgroupnsMode === 'host') throw new Error('unsafe utility namespaces');
  const capsDropped = h.CapDrop?.some((s: string) => s.toUpperCase() === 'ALL') ||
    (options.runtime === 'podman' && Object.hasOwn(c, 'EffectiveCaps') && Object.hasOwn(c, 'BoundingCaps') && !c.EffectiveCaps?.length && !c.BoundingCaps?.length);
  if (h.CapAdd?.length || !capsDropped || !h.ReadonlyRootfs || !h.SecurityOpt?.some((s: string) => /^no-new-privileges([=:]true)?$/.test(s)) ||
      h.SecurityOpt.some((s: string) => /unconfined|label=disable|label:disable/i.test(s))) throw new Error('utility hardening missing');
  if (!(h.Memory > 0) || !(h.PidsLimit > 0) || !(h.NanoCpus > 0 || h.CpuQuota > 0)) throw new Error('utility resource limits missing');
  if (h.PublishAllPorts || Object.keys(h.PortBindings ?? {}).length || Object.values(c.NetworkSettings?.Ports ?? {}).some(v => v != null)) throw new Error('utility ports must not be published');
  if (h.Devices?.length || h.DeviceRequests?.length || h.DeviceCgroupRules?.length || h.VolumesFrom?.length || c.Config.Secrets?.length || c.Secrets?.length || h.GroupAdd?.some((g: string) => g === '0' || g === 'root')) throw new Error('utility host access forbidden');
  if (!Array.isArray(c.Mounts) || c.Mounts.length !== 1 || c.Mounts[0].Type !== 'volume' || c.Mounts[0].Name !== `${prefix}-files` || c.Mounts[0].Destination !== '/workspace' || c.Mounts[0].RW !== true) throw new Error('only assigned workspace-files volume may be mounted');
  if (h.Binds?.length && (h.Binds.length !== 1 || !new RegExp(`^${prefix}-files:/workspace(?::(?:rw|z|Z|rprivate|rbind|nosuid|nodev)(?:,(?:rw|z|Z|rprivate|rbind|nosuid|nodev))*)?$`).test(h.Binds[0]))) throw new Error('unapproved bind configuration');
  for (const [path, flags] of Object.entries(h.Tmpfs ?? {})) {
    if (path !== '/tmp' || typeof flags !== 'string' || !flags.split(',').includes('nosuid') || !flags.split(',').includes('nodev')) throw new Error('unapproved utility tmpfs');
  }
  if (!h.Tmpfs?.['/tmp']) throw new Error('utility private tmpfs required');
  const allowedEnv = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);
  for (const env of c.Config.Env ?? []) {
    const split = env.indexOf('='); const key = env.slice(0, split); const value = env.slice(split + 1);
    if (key === 'container' && value === 'podman' && options.runtime === 'podman') continue;
    if (key === 'HOSTNAME' && value === c.Config.Hostname) continue;
    if (split < 1 || !allowedEnv.has(key)) throw new Error('unapproved utility environment');
    if (/proxy/i.test(key)) {
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.hostname !== 'egress' || url.port !== '3128' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('utility proxy mismatch');
    }
  }
  const networks = Object.keys(c.NetworkSettings?.Networks ?? {});
  if (h.NetworkMode === 'none') {
    if (networks.some(n => n !== 'none')) throw new Error('unexpected utility network');
    return;
  }
  if (networks.length !== 1 || networks[0] !== `${prefix}-utility` || ![`${prefix}-utility`, c.NetworkSettings.Networks[networks[0]].NetworkID].includes(h.NetworkMode)) throw new Error('utility must use only its private network');
  const network = options.networkInspection;
  if (!network || (network.Name ?? network.name) !== `${prefix}-utility` || (network.Internal ?? network.internal) !== true) throw new Error('verified internal utility network required');
  const members = network.Containers ?? network.containers;
  if (!members || !Object.values(members).some((m: any) => (m.Name ?? m.name) === `${prefix}-utility`) ||
      Object.values(members).some((m: any) => ![`${prefix}-utility`, `${prefix}-egress`].includes(m.Name ?? m.name))) throw new Error('unexpected private-network member');
}

/** Exec only in a pre-provisioned dedicated utility container; never a local shell. */
export class CommandService {
  private options: CommandServiceOptions;
  private commands = new Map<string, Running>();
  private starting = 0;
  constructor(options: CommandServiceOptions) {
    if (!identifier.test(options.container) || !['docker', 'podman'].includes(options.runtime)) throw new Error('invalid utility container/runtime');
    const user = options.user ?? '1000:1000';
    if (!/^[1-9][0-9]*:[1-9][0-9]*$/.test(user)) throw new Error('numeric non-root user and group required');
    if (options.egressProxy) {
      const proxy = new URL(options.egressProxy);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash) throw new Error('invalid credential-free policy proxy');
    }
    this.options = { user, timeoutMs: 60_000, maxOutputBytes: 64 * 1024, maxConcurrent: 4, maxHistory: 100, ...options };
    for (const key of ['timeoutMs', 'maxOutputBytes', 'maxConcurrent', 'maxHistory'] as const)
      if (!Number.isSafeInteger(this.options[key]) || this.options[key]! <= 0) throw new Error(`invalid ${key}`);
  }
  private async check(actor: FileActor, mutation = true) {
    if (actor.workspaceId !== this.options.workspaceId || !identifier.test(actor.agentId) || !identifier.test(actor.connectionId)) throw new Error('invalid command identity/workspace');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        await this.options.authorize(actor, mutation ? 'shell:execute' : 'shell:read');
        if (mutation) await this.options.validateLease(actor);
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('command authorization unavailable')), 1500); })]);
    } finally { clearTimeout(timer); }
  }
  private audit(actor: FileActor, type: string, id: string, summary: string, extra: Partial<OperationEvent> = {}) {
    return this.options.audit({ workspaceId: this.options.workspaceId, sourceId: actor.agentId, type, correlationId: id, summary, ...extra });
  }
  private async runtime(args: string[], maxBytes = 256 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.runtime, args, { env: cleanEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
      let bytes = 0; const chunks: Buffer[] = []; let failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); reject(new Error('container runtime request timed out')); }, 10_000);
      child.stdout.on('data', (c: Buffer) => { bytes += c.length; if (bytes > maxBytes) { failed = true; child.kill('SIGKILL'); reject(new Error('container runtime response limit')); } else chunks.push(c); });
      // Runtime errors can echo command arguments. Do not retain them.
      child.stderr.resume(); child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); if (!failed) code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error('container runtime operation failed')); });
    });
  }
  private async isolation() {
    const items = JSON.parse(await this.runtime(['inspect', this.options.container]));
    const c = items[0];
    const name = `buk-${this.options.workspaceId}-utility`;
    const networkInspection = c?.HostConfig?.NetworkMode === 'none' ? undefined : JSON.parse(await this.runtime(['network', 'inspect', name]))[0];
    validateUtilityIsolation(c, { workspaceId: this.options.workspaceId, runtime: this.options.runtime, user: this.options.user, networkInspection });
    // Optional additional administrator policy may only tighten the built-in verifier.
    await this.options.validateIsolation?.(c);
  }
  private own(actor: FileActor, id: string) {
    const c = this.commands.get(id);
    if (!c || c.result.agentId !== actor.agentId || c.result.connectionId !== actor.connectionId) throw new Error('command not found');
    return c;
  }
  async start(actor: FileActor, request: CommandRequest): Promise<{ id: string }> {
    await this.check(actor);
    if (!request.command || request.command.length > 32_768 || request.command.includes('\0')) throw new Error('invalid command');
    const cwd = request.cwd ?? `/workspace/agents/${actor.agentId}`;
    if (!/^\/workspace\/(agents|common|input|output|downloads)(\/[^\0\\]*)?$/.test(cwd) ||
        cwd.slice(1).split('/').some(p => !p || p === '.' || p === '..')) throw new Error('invalid working directory');
    const timeout = request.timeoutMs ?? this.options.timeoutMs!;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > this.options.timeoutMs!) throw new Error('command duration limit');
    if (this.starting + this.stoppers.size >= this.options.maxConcurrent!) throw new Error('command concurrency limit');
    this.starting++;
    try {
      const id = randomUUID(); const hash = createHash('sha256').update(request.command).digest('hex');
      await this.audit(actor, 'command.starting', id, `Command ${hash}; cwd=${cwd}`);
      await this.isolation(); await this.check(actor);
      // setsid creates a per-command session/process group. GNU timeout and our cancellation
      // both terminate the group. The pid record is inside utility tmpfs, never host /tmp.
      const pidfile = `/tmp/buk-command-${id}.pid`;
      const wrapper = 'umask 077; echo $$ > "$1"; shift; exec timeout --signal=TERM --kill-after=2s "$1" /bin/sh -c "$2"';
      const args = ['exec', '--user', this.options.user!, '--workdir', cwd, this.options.container,
        '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/nonexistent', 'LANG=C.UTF-8',
        ...(this.options.egressProxy ? [`HTTP_PROXY=${this.options.egressProxy}`, `HTTPS_PROXY=${this.options.egressProxy}`, `http_proxy=${this.options.egressProxy}`, `https_proxy=${this.options.egressProxy}`] : []),
        'setsid', '--wait', '/bin/sh', '-c', wrapper, 'buk', pidfile, `${timeout / 1000}s`, request.command];
      const child = spawn(this.options.runtime, args, { env: cleanEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
      const result: CommandResult = { id, workspaceId: actor.workspaceId, agentId: actor.agentId, connectionId: actor.connectionId, cwd,
        commandHash: hash, startedAt: new Date().toISOString(), durationMs: 0, status: 'running', exitCode: null, output: '', truncated: false };
      let resolveDone!: (r: CommandResult) => void; let rejectDone!: (e: unknown) => void;
      const done = new Promise<CommandResult>((res, rej) => { resolveDone = res; rejectDone = rej; });
      // Caller may poll instead of wait; errors remain observable via wait without unhandled rejection.
      void done.catch(() => {});
      const run: Running = { result, done, stopping: false }; this.commands.set(id, run);
      const started = performance.now(); let captured = 0;
      const output = (chunk: Buffer) => {
        const remaining = this.options.maxOutputBytes! - captured;
        if (chunk.length > remaining) result.truncated = true;
        const part = chunk.subarray(0, Math.max(remaining, 0)); captured += part.length;
        // Content capture is opt-in: output can contain arbitrary credentials, not just tokens.
        if (part.length && this.options.sanitizeOutput) {
          const safe = this.options.sanitizeOutput(part.toString());
          const left = this.options.maxOutputBytes! - Buffer.byteLength(result.output);
          result.output += Buffer.from(safe).subarray(0, Math.max(0, left)).toString();
          while (Buffer.byteLength(result.output) > this.options.maxOutputBytes!) result.output = result.output.slice(0, -1);
        }
      };
      child.stdout.on('data', (c: Buffer) => { try { output(c); } catch { void stop('cancelled'); } });
      child.stderr.on('data', (c: Buffer) => { try { output(c); } catch { void stop('cancelled'); } });
      let stopError: unknown;
      const stop = async (reason: 'cancelled' | 'timed_out') => {
        if (run.stop) return run.stop;
        run.stopping = true; result.status = reason;
        run.stop = (async () => {
          try {
            await this.runtime(['exec', '--user', this.options.user!, this.options.container, '/bin/sh', '-c',
              'p=$(cat "$1" 2>/dev/null) || exit 1; case "$p" in ""|*[!0-9]*) exit 1;; esac; [ "$p" -gt 1 ] || exit 1; kill -TERM -"$p" 2>/dev/null; sleep 2; kill -KILL -"$p" 2>/dev/null; rm -f -- "$1"; exit 0', 'buk', pidfile]);
          } catch (e) {
            // Never confuse killing docker exec with killing the in-container command.
            // Fail-safe: stop the dedicated utility container if group cancellation fails.
            try { await this.runtime(['kill', '--signal', 'KILL', this.options.container]); }
            catch (fallback) { stopError = fallback; }
          } finally { child.kill('SIGKILL'); }
        })();
        return run.stop;
      };
      // Set before returning start so cancel cannot race an unassigned handler.
      const stops = this.stoppers; stops.set(id, stop);
      let checking = false;
      const validation = setInterval(() => {
        if (checking || run.stopping) return; checking = true;
        void this.check(actor).catch(() => stop('cancelled')).finally(() => { checking = false; });
      }, 1000);
      const timer = setTimeout(() => { void stop('timed_out'); }, timeout + 500);
      child.once('error', () => { result.status = 'failed'; });
      child.once('close', (code) => {
        clearInterval(validation); clearTimeout(timer);
        void (async () => {
          if (run.stop) await run.stop;
          result.durationMs = Math.round(performance.now() - started); result.exitCode = code;
          if (!run.stopping) result.status = code === 124 || code === 137 ? 'timed_out' : code === 0 ? 'completed' : 'failed';
          try {
            // A shell can exit after forking background children. Reap its entire remaining
            // group even on success, before acknowledging completion.
            try {
              await this.runtime(['exec', '--user', this.options.user!, this.options.container, '/bin/sh', '-c',
                'p=$(cat "$1" 2>/dev/null) || exit 0; case "$p" in ""|*[!0-9]*) exit 1;; esac; [ "$p" -gt 1 ] || exit 1; kill -TERM -"$p" 2>/dev/null; sleep .1; kill -KILL -"$p" 2>/dev/null; rm -f -- "$1"; exit 0', 'buk', pidfile]);
            } catch (e) {
              if (!run.stopping) { stopError = e; result.status = 'failed'; }
            }
            await this.audit(actor, 'command.completed', id, `Command ${hash}; status=${result.status}; exit=${code}; truncated=${result.truncated}${this.options.sanitizeOutput ? `; output=${JSON.stringify(result.output)}` : ''}`, 
              { status: result.status, durationMs: result.durationMs });
            if (stopError) throw new Error('command cancellation could not be confirmed');
            resolveDone({ ...result });
          } catch (e) { result.status = 'failed'; rejectDone(e); }
          finally {
            stops.delete(id);
            for (const [oldId, old] of this.commands) {
              if (this.commands.size <= this.options.maxHistory!) break;
              if (!stops.has(oldId) && oldId !== id) this.commands.delete(oldId);
            }
          }
        })();
      });
      return { id };
    } finally { this.starting--; }
  }
  private stoppers = new Map<string, (reason: 'cancelled' | 'timed_out') => Promise<void>>();
  async inspect(actor: FileActor, id: string): Promise<CommandResult> { await this.check(actor, false); return { ...this.own(actor, id).result }; }
  async wait(actor: FileActor, id: string): Promise<CommandResult> {
    await this.check(actor, false); const result = await this.own(actor, id).done; await this.check(actor, false); return result;
  }
  async list(actor: FileActor): Promise<CommandResult[]> {
    await this.check(actor, false);
    return [...this.commands.values()].filter(c => c.result.agentId === actor.agentId && c.result.connectionId === actor.connectionId).map(c => ({ ...c.result }));
  }
  async cancel(actor: FileActor, id: string) {
    // Cancellation must remain possible after an automation lease expires, but needs auth.
    await this.check(actor, false); this.own(actor, id);
    await this.options.authorize(actor, 'shell:execute');
    await this.audit(actor, 'command.cancel', id, 'Command cancellation requested');
    await this.stoppers.get(id)?.('cancelled');
  }
  /** Trusted lifecycle/takeover hook. No user-facing route should call this without authorization. */
  async cancelAll() { await Promise.all([...this.stoppers.values()].map(stop => stop('cancelled'))); }
}
