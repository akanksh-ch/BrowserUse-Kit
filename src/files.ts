import { constants as C } from 'node:fs';
import { open, readdir, rename, unlink, lstat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface FileActor { workspaceId: string; agentId: string; connectionId: string }
export interface OperationEvent {
  workspaceId: string; sourceId: string; type: string; summary: string;
  correlationId: string; status?: string; durationMs?: number;
}
export interface SecurityHooks {
  authorize: (actor: FileActor, permission: string) => void | Promise<void>;
  validateLease: (actor: FileActor) => void | Promise<void>;
  /** Must resolve only after durable commit. Do not suppress storage failures. */
  audit: (event: OperationEvent) => void | Promise<void>;
}
export interface FileServiceOptions extends SecurityHooks {
  workspaceId: string; root: string;
  /** Same filesystem as root, owned by control identity, NOT mounted in utility/browser.
   * Provision as a sibling on the workspace volume; mount only its files subtree in utility. */
  staging: string;
  quotaBytes?: number; maxFileBytes?: number; maxTransferBytes?: number;
  transferTimeoutMs?: number; maxEntries?: number;
  allowedRoots?: string[];
  /** Shared workspace group, if cross-identity browser/utility access is enabled. */
  sharedGid?: number;
}
export interface FileEntry { name: string; type: 'file' | 'directory' | 'blocked'; size: number }
const dirFlags = C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW;
const fdPath = (h: FileHandle, name = '') => `/proc/self/fd/${h.fd}${name ? '/' + name : ''}`;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

/** Linux-only descriptor-anchored traversal; no realpath-then-open TOCTOU checks.
 * Instance must be unique per workspace. External command/download writers additionally
 * require an administrator provisioned filesystem/project quota (API accounting is not a disk quota).
 */
export class FileService {
  private options: FileServiceOptions;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(options: FileServiceOptions) {
    if (process.platform !== 'linux') throw new Error('descriptor-safe files require Linux');
    if (!options.workspaceId || !isAbsolute(options.root) || !isAbsolute(options.staging)) throw new Error('absolute root and protected staging required');
    if (resolve(options.staging) === resolve(options.root) || resolve(options.staging).startsWith(resolve(options.root) + '/')) throw new Error('staging must not be agent-accessible');
    this.options = { quotaBytes: 10 * 1024 ** 3, maxFileBytes: 256 * 1024 ** 2, maxTransferBytes: 256 * 1024 ** 2,
      transferTimeoutMs: 60_000, maxEntries: 100_000,
      allowedRoots: ['agents', 'common', 'input', 'output', 'downloads'], ...options };
    for (const n of ['quotaBytes', 'maxFileBytes', 'maxTransferBytes', 'transferTimeoutMs', 'maxEntries'] as const)
      if (!Number.isSafeInteger(this.options[n]) || this.options[n]! <= 0) throw new Error(`invalid ${n}`);
    if (options.sharedGid !== undefined && (!Number.isSafeInteger(options.sharedGid) || options.sharedGid < 1)) throw new Error('invalid shared workspace group');
    for (const r of this.options.allowedRoots!) if (!/^[a-zA-Z0-9_-]+$/.test(r)) throw new Error('invalid allowed root');
  }
  private async check(actor: FileActor, mutate = false) {
    if (actor.workspaceId !== this.options.workspaceId) throw new Error('workspace mismatch');
    await this.options.authorize(actor, mutate ? 'files:write' : 'files:read');
    if (mutate) await this.options.validateLease(actor);
  }
  private event(actor: FileActor, type: string, id: string, summary: string) {
    return this.options.audit({ workspaceId: this.options.workspaceId, sourceId: actor.agentId, type, correlationId: id, summary });
  }
  private parts(path: string, allowRoot = false) {
    if (allowRoot && (path === '' || path === '.')) return [];
    const p = path.split('/');
    if (path.length > 4096 || p.some(s => !s || s === '.' || s === '..' || s.includes('\0') || s.includes('\\')) || !this.options.allowedRoots!.includes(p[0])) throw new Error('path outside permitted roots');
    return p;
  }
  private async directory(parts: string[]) {
    let h = await open(this.options.root, dirFlags);
    try {
      for (const part of parts) {
        const next = await open(fdPath(h, part), dirFlags);
        await h.close(); h = next;
      }
      return h;
    } catch (e) { await h.close(); throw e; }
  }
  private async parent(path: string) {
    const parts = this.parts(path); const name = parts.pop()!;
    // Top-level roots are provisioned by lifecycle, never removable through this API.
    if (!parts.length) throw new Error('operation requires a file within an allowed root');
    return { dir: await this.directory(parts), name };
  }
  private async regular(dir: FileHandle, name: string) {
    const h = await open(fdPath(dir, name), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try { const s = await h.stat(); if (!s.isFile() || s.nlink !== 1) throw new Error('not a private regular file'); return h; }
    catch (e) { await h.close(); throw e; }
  }
  private async locked<T>(f: () => Promise<T>): Promise<T> {
    const before = this.tail; let release!: () => void;
    this.tail = new Promise<void>(r => { release = r; });
    await before; try { return await f(); } finally { release(); }
  }
  private async usage() {
    let usedBytes = 0; let entries = 0;
    const walk = async (h: FileHandle): Promise<void> => {
      for (const name of await readdir(fdPath(h))) {
        if (++entries > this.options.maxEntries!) throw new Error('workspace entry limit exceeded');
        const s = await lstat(fdPath(h, name));
        if (s.isDirectory()) {
          const child = await open(fdPath(h, name), dirFlags);
          try { await walk(child); } finally { await child.close(); }
        } else if (s.isFile()) usedBytes += s.size;
      }
    };
    const root = await this.directory([]); const stage = await open(this.options.staging, dirFlags);
    try { await walk(root); await walk(stage); } finally { await root.close(); await stage.close(); }
    return usedBytes;
  }
  async quota(actor: FileActor) {
    await this.check(actor);
    return { usedBytes: await this.usage(), quotaBytes: this.options.quotaBytes!, maxFileBytes: this.options.maxFileBytes! };
  }
  async list(actor: FileActor, path = ''): Promise<FileEntry[]> {
    await this.check(actor); const parts = this.parts(path, true); const dir = await this.directory(parts);
    try {
      const names = await readdir(fdPath(dir));
      if (names.length > this.options.maxEntries!) throw new Error('directory entry limit exceeded');
      const entries: FileEntry[] = [];
      for (const name of names.sort()) {
        if (!parts.length && !this.options.allowedRoots!.includes(name)) continue;
        const s = await lstat(fdPath(dir, name));
        entries.push({ name, type: s.isDirectory() ? 'directory' : s.isFile() && s.nlink === 1 ? 'file' : 'blocked', size: s.size });
      }
      return entries;
    } finally { await dir.close(); }
  }
  async upload(actor: FileActor, path: string, source: AsyncIterable<Uint8Array>, options: { signal?: AbortSignal } = {}) {
    return this.locked(async () => {
      await this.check(actor, true);
      const { dir, name } = await this.parent(path); const id = randomUUID();
      let stage: FileHandle | undefined; let temp: FileHandle | undefined; let temporary = '';
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      const onAbort = () => abort.abort(options.signal?.reason ?? new Error('transfer aborted'));
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      timer = setTimeout(() => abort.abort(new Error('upload timeout')), this.options.transferTimeoutMs!);
      const next = async (iterator: AsyncIterator<Uint8Array>) => {
        abort.signal.throwIfAborted();
        let listener!: () => void;
        try { return await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
          listener = () => reject(abort.signal.reason); abort.signal.addEventListener('abort', listener, { once: true });
        })]); } finally { abort.signal.removeEventListener('abort', listener); }
      };
      try {
        // Validate existing leaf without following symlinks; replacement itself never follows it.
        try { const old = await this.regular(dir, name); await old.close(); } catch (e) { if (!missing(e)) throw e; }
        stage = await open(this.options.staging, dirFlags);
        const s = await stage.stat(); const d = await dir.stat();
        if (s.dev !== d.dev || (s.mode & 0o077) !== 0 || s.uid !== process.getuid!()) throw new Error('staging must be private, control-owned and on same filesystem');
        await this.event(actor, 'file.upload.started', id, 'Atomic upload requested');
        temporary = `.upload-${id}`;
        temp = await open(fdPath(stage, temporary), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
        let size = 0;
        const iterator = source[Symbol.asyncIterator]();
        try {
          for (;;) {
            const chunk = await next(iterator); if (chunk.done) break;
            await this.check(actor, true); abort.signal.throwIfAborted();
            if (!(chunk.value instanceof Uint8Array)) throw new Error('upload requires binary chunks');
            if (size + chunk.value.byteLength > Math.min(this.options.maxFileBytes!, this.options.maxTransferBytes!)) throw new Error('file/transfer size limit exceeded');
            if (await this.usage() + chunk.value.byteLength > this.options.quotaBytes!) throw new Error('workspace quota exceeded');
            let offset = 0;
            while (offset < chunk.value.byteLength) {
              const result = await temp.write(chunk.value, offset, chunk.value.byteLength - offset);
              if (!result.bytesWritten) throw new Error('short file write'); offset += result.bytesWritten;
            }
            size += chunk.value.byteLength;
          }
        } finally { if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {}); }
        if (this.options.sharedGid !== undefined) {
          await temp.chown(-1, this.options.sharedGid); await temp.chmod(0o660);
        }
        await temp.sync(); await this.check(actor, true); abort.signal.throwIfAborted();
        if (await this.usage() > this.options.quotaBytes!) throw new Error('workspace quota exceeded');
        await this.event(actor, 'file.upload.commit', id, `Atomic upload commit authorized; bytes=${size}`);
        await rename(fdPath(stage, temporary), fdPath(dir, name)); temporary = '';
        await dir.sync(); await stage.sync();
        await this.event(actor, 'file.upload.completed', id, `Upload committed; bytes=${size}`);
        return { size, correlationId: id };
      } catch (e) {
        // A post-rename fsync/audit error is reported, never "rolled back" over newer data.
        try { await this.event(actor, 'file.upload.failed', id, 'Upload failed or commit confirmation unavailable'); } catch {}
        throw e;
      } finally {
        clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
        try { if (temp) await temp.close(); } finally {
          try { if (stage && temporary) await unlink(fdPath(stage, temporary)); }
          finally { if (stage) await stage.close(); await dir.close(); }
        }
      }
    });
  }
  async *download(actor: FileActor, path: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<Buffer> {
    await this.check(actor); const { dir, name } = await this.parent(path); let file: FileHandle | undefined;
    const deadline = performance.now() + this.options.transferTimeoutMs!;
    try {
      file = await this.regular(dir, name); const stat = await file.stat();
      if (stat.size > Math.min(this.options.maxFileBytes!, this.options.maxTransferBytes!)) throw new Error('download size limit exceeded');
      let position = 0;
      for (;;) {
        await this.check(actor); options.signal?.throwIfAborted();
        if (performance.now() > deadline) throw new Error('download timeout');
        const buffer = Buffer.alloc(Math.min(64 * 1024, stat.size - position));
        if (!buffer.length) break;
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead; yield buffer.subarray(0, bytesRead);
      }
    } finally { if (file) await file.close(); await dir.close(); }
  }
  async delete(actor: FileActor, path: string) {
    return this.locked(async () => {
      await this.check(actor, true); const { dir, name } = await this.parent(path); const id = randomUUID();
      try {
        try { const h = await this.regular(dir, name); await h.close(); } catch (e) { if (!missing(e)) throw e; }
        await this.check(actor, true); await this.event(actor, 'file.delete.started', id, 'File deletion authorized');
        try { await unlink(fdPath(dir, name)); } catch (e) { if (!missing(e)) throw e; }
        await dir.sync(); await this.event(actor, 'file.delete.completed', id, 'File deletion committed');
      } finally { await dir.close(); }
    });
  }
}
