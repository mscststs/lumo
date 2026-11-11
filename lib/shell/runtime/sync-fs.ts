/**
 * `fs.*Sync` for the QuickJS guest.
 *
 * A synchronous read cannot await IndexedDB, so the guest cannot call the VFS
 * directly. Instead this bridge holds a plain in-memory view of the tree, which
 * the `node` command builds before the VM starts and which answers every
 * synchronous call. Three properties make it behave like Node inside one script:
 *
 *  - **The view is the authority.** While the bridge is active, the guest's
 *    asynchronous `fs` calls are routed here too, so `writeFileSync('/a')` is
 *    visible to `await fs.readFile('/a')` and vice versa.
 *  - **Mutations are journalled.** Every write/mkdir/rm/rename is recorded and
 *    replayed against the real VFS when the script ends (success, error,
 *    timeout or abort), so a failing script keeps what it already wrote.
 *  - **`exec` flushes first.** A subprocess reads the real store, so the journal
 *    is applied before `exec`, `tools.*` and `fetch` and the view is rebuilt
 *    from the store afterwards.
 *
 * Contents are only loaded when the script actually reads synchronously (see
 * `detectSyncFsUsage`); `existsSync`/`statSync`/`readdirSync`/`mkdirSync` need
 * metadata only, which the host already keeps in memory.
 *
 * Node semantics that the VFS cannot represent are reported instead of faked:
 * symlinks/hard links are `ENOSYS`, and permissions are advisory (`chmod` only
 * records a mode for the rest of the execution).
 */

import { bytesFromBase64, textFromBytes } from '@/lib/encoding';
import { normalizeVfsPath, resolveVfsPath, type VfsSnapshotEntry } from '../vfs';

/**
 * The VFS surface the bridge needs.
 *
 * Narrower than `LumoFileSystem` because `just-bash` types the shell's `fs` as
 * `IFileSystem`, and because it documents exactly which store operations a
 * synchronous script can trigger.
 */
export interface SyncFsHost {
  /** Whole tree as plain metadata; absent on a non-Lumo filesystem. */
  snapshotSync?: () => VfsSnapshotEntry[];
  /** Re-read the index when another writer changed the store. */
  refresh?: () => Promise<void>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array, options?: unknown): Promise<void>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  mv(from: string, to: string): Promise<void>;
  cp(from: string, to: string, options?: { recursive?: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

/** Files above this total are not snapshotted; sync reads fail with the reason. */
const CONTENT_SNAPSHOT_LIMIT_BYTES = 64 * 1024 * 1024;

const FILE_MODE = 0o644;
const DIR_MODE = 0o755;

const ERROR_MESSAGES: Record<string, string> = {
  EACCES: 'permission denied',
  EBADF: 'bad file descriptor',
  EBUSY: 'resource busy or locked',
  EEXIST: 'file already exists',
  EINVAL: 'invalid argument',
  EISDIR: 'illegal operation on a directory',
  ENOENT: 'no such file or directory',
  ENOSYS: 'function not implemented',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  ENOTSUP: 'operation not supported',
  EPERM: 'operation not permitted',
};

type DeviceKind = 'dir' | 'null' | 'zero';

interface Entry {
  kind: 'file' | 'dir';
  size: number;
  /** Epoch milliseconds. */
  mtime: number;
  mode: number;
}

/** The documented `fs.Stats` subset the async host call already returns. */
export interface StatPayload {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mode: number;
  mtime: number;
}

export interface DirentPayload {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

type JournalOp =
  | { op: 'write'; path: string; bytes: Uint8Array }
  | { op: 'mkdir'; path: string }
  | { op: 'rm'; path: string; recursive: boolean; force: boolean }
  | { op: 'mv'; from: string; to: string }
  | { op: 'cp'; from: string; to: string }
  | { op: 'chmod'; path: string; mode: number }
  | { op: 'utimes'; path: string; atime: number; mtime: number };

export interface SyncFileBridgeOptions {
  fs: SyncFsHost;
}

function fsError(code: string, syscall: string, path: string, dest?: string): Error {
  const error = new Error(
    `${code}: ${ERROR_MESSAGES[code] ?? 'error'}, ${syscall} '${path}'`,
  ) as Error & { code: string; syscall: string; path: string; dest?: string };
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  if (dest !== undefined) error.dest = dest;
  return error;
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

function deviceKind(path: string): DeviceKind | undefined {
  const normalized = normalizeVfsPath(path);
  if (normalized === '/dev') return 'dir';
  if (normalized === '/dev/null') return 'null';
  if (normalized === '/dev/zero') return 'zero';
  return undefined;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.length === 0) return right;
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function decodeData(payload: Record<string, unknown>): Uint8Array {
  const data = String(payload.data ?? '');
  if (payload.encoding === 'base64') return bytesFromBase64(data);
  if (payload.encoding === 'hex') {
    const clean = data.replace(/[^0-9a-fA-F]/g, '');
    const bytes = new Uint8Array(Math.floor(clean.length / 2));
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (payload.encoding === 'latin1' || payload.encoding === 'binary') {
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i += 1) bytes[i] = data.charCodeAt(i) & 0xff;
    return bytes;
  }
  return new TextEncoder().encode(data);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SyncFileBridge {
  private readonly fs: SyncFsHost;
  private entries = new Map<string, Entry>();
  private data = new Map<string, Uint8Array>();
  private journal: JournalOp[] = [];
  private contents: 'unloaded' | 'loaded' | 'too-large' = 'unloaded';
  /** Files whose bytes could not be read; reads must fall through, not fail. */
  private contentMisses = new Set<string>();
  private totalBytes = 0;
  private active = false;
  /** Errors raised while replaying the journal; the command reports them. */
  readonly flushErrors: string[] = [];

  constructor(options: SyncFileBridgeOptions) {
    this.fs = options.fs;
  }

  /** True when the script touched a `*Sync` fs API and the view is in use. */
  get isActive(): boolean {
    return this.active;
  }

  /**
   * Build the view, and load file contents when the script reads synchronously.
   *
   * Leading with metadata keeps `existsSync`/`readdirSync` free: the host's VFS
   * index is already in memory, so this walk touches no storage.
   */
  async prepare(options: { contents: boolean }): Promise<void> {
    if (typeof this.fs.snapshotSync !== 'function') {
      throw new Error(
        'fs: the synchronous filesystem needs the extension VFS, which this shell does not provide; use the async fs API',
      );
    }
    this.active = true;
    await this.refreshIndex();
    this.rebase();
    this.totalBytes = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind === 'file') this.totalBytes += entry.size;
    }
    if (!options.contents) return;
    if (this.totalBytes > CONTENT_SNAPSHOT_LIMIT_BYTES) {
      this.contents = 'too-large';
      return;
    }
    this.contents = 'loaded';
    await this.fillContents();
  }

  /** Route one synchronous guest call. Throws a Node-shaped error on failure. */
  call(op: string, payload: Record<string, unknown>): unknown {
    switch (op) {
      case 'read':
        return this.read(this.pathOf(payload), payload.encoding);
      case 'write':
        this.write(this.pathOf(payload), payload, {
          append: false,
          exclusive: payload.exclusive === true,
        });
        return { ok: true };
      case 'append':
        this.write(this.pathOf(payload), payload, { append: true, exclusive: false });
        return { ok: true };
      case 'readdir':
        return this.readdir(this.pathOf(payload), payload.withFileTypes === true);
      case 'stat':
        return this.stat(this.pathOf(payload));
      case 'exists':
        return this.exists(this.pathOf(payload));
      case 'mkdir':
        return this.mkdir(this.pathOf(payload), payload.recursive !== false);
      case 'rm':
        this.rm(this.pathOf(payload), payload.recursive === true, payload.force === true);
        return { ok: true };
      case 'rename':
        this.rename(this.pathOf(payload, 'from'), this.pathOf(payload, 'to'));
        return { ok: true };
      case 'copy':
        this.copy(this.pathOf(payload, 'from'), this.pathOf(payload, 'to'), {
          exclusive: payload.exclusive === true,
          recursive: payload.recursive !== false,
        });
        return { ok: true };
      case 'chmod':
        this.chmod(this.pathOf(payload), Number(payload.mode ?? FILE_MODE));
        return { ok: true };
      case 'utimes':
        this.utimes(this.pathOf(payload), payload);
        return { ok: true };
      case 'truncate':
        this.truncate(this.pathOf(payload), Number(payload.length ?? 0));
        return { ok: true };
      case 'realpath':
        return this.realpath(this.pathOf(payload));
      default:
        throw new Error(`fs: unsupported synchronous operation '${op}'`);
    }
  }

  /**
   * Answer an asynchronous `fs.*` call from the same view.
   *
   * Returning `undefined` means "not this bridge" and the caller falls back to
   * the normal host path; that only happens when the script mixes both APIs and
   * the bytes were not snapshotted (the library is over the snapshot limit).
   */
  tryAsync(
    kind: string,
    payload: Record<string, unknown>,
  ): { value: unknown } | undefined {
    if (!this.active) return undefined;
    switch (kind) {
      case 'fs.read': {
        const path = this.pathOf(payload);
        // The guest always names an encoding here; anything else stays on the
        // normal bridge, which knows how to return bytes.
        if (typeof payload.encoding !== 'string') return undefined;
        if (!this.hasContent(path)) return undefined;
        return { value: this.read(path, payload.encoding) };
      }
      case 'fs.write':
        this.write(this.pathOf(payload), payload, { append: false, exclusive: false });
        return { value: { ok: true } };
      case 'fs.append':
        this.write(this.pathOf(payload), payload, { append: true, exclusive: false });
        return { value: { ok: true } };
      case 'fs.readdir':
        return { value: this.readdir(this.pathOf(payload), payload.withFileTypes === true) };
      case 'fs.stat':
        return { value: this.stat(this.pathOf(payload)) };
      case 'fs.exists':
        return { value: this.exists(this.pathOf(payload)) };
      case 'fs.mkdir': {
        const path = this.pathOf(payload);
        this.mkdir(path, payload.recursive !== false);
        // The async host call answers with the resolved path.
        return { value: path };
      }
      case 'fs.rm':
        this.rm(this.pathOf(payload), payload.recursive === true, payload.force === true);
        return { value: { ok: true } };
      case 'fs.rename':
        this.rename(this.pathOf(payload, 'from'), this.pathOf(payload, 'to'));
        return { value: { ok: true } };
      case 'fs.copy': {
        const from = this.pathOf(payload, 'from');
        if (!this.hasContent(from)) return undefined;
        this.copy(from, this.pathOf(payload, 'to'), { exclusive: false, recursive: true });
        return { value: { ok: true } };
      }
      case 'fs.chmod':
        this.chmod(this.pathOf(payload), Number(payload.mode ?? FILE_MODE));
        return { value: { ok: true } };
      case 'fs.utimes':
        this.utimes(this.pathOf(payload), payload);
        return { value: { ok: true } };
      case 'fs.realpath':
        return { value: this.realpath(this.pathOf(payload)) };
      default:
        return undefined;
    }
  }

  /**
   * Replay the journal against the real VFS.
   *
   * Called before anything that reads the store (`exec`, another tool) and once
   * when the script ends. Errors are collected rather than thrown: the script
   * has already produced its result, and the command turns them into stderr.
   */
  async flush(): Promise<void> {
    if (this.journal.length === 0) return;
    const ops = this.journal.splice(0);
    const written = new Set<string>();
    for (const op of ops) {
      try {
        await this.apply(op);
        if (op.op === 'write') written.add(op.path);
      } catch (error) {
        this.flushErrors.push(describe(error));
      }
    }
    this.rebase(written);
  }

  /**
   * Rebuild metadata from the store after something outside this script wrote
   * to it (`exec`, an MCP tool), then re-read the bytes that changed.
   */
  async resync(): Promise<void> {
    await this.refreshIndex();
    this.rebase();
    if (this.contents === 'loaded') await this.fillContents();
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  private pathOf(payload: Record<string, unknown>, key = 'path'): string {
    const base = typeof payload.cwd === 'string' ? payload.cwd : '/';
    return resolveVfsPath(base, String(payload[key] ?? ''));
  }

  private entry(path: string): Entry | undefined {
    const device = deviceKind(path);
    if (device === 'dir') return { kind: 'dir', size: 0, mtime: 0, mode: DIR_MODE };
    if (device) return { kind: 'file', size: 0, mtime: 0, mode: 0o666 };
    return this.entries.get(path);
  }

  private requireEntry(path: string, syscall: string): Entry {
    const entry = this.entry(path);
    if (!entry) throw fsError('ENOENT', syscall, path);
    return entry;
  }

  private hasContent(path: string): boolean {
    if (deviceKind(path)) return true;
    if (this.data.has(path)) return true;
    const entry = this.entries.get(path);
    if (!entry || entry.kind !== 'file') return false;
    return this.contents === 'loaded' && !this.contentMisses.has(path);
  }

  private bytesOf(path: string): Uint8Array {
    const device = deviceKind(path);
    if (device && device !== 'dir') return new Uint8Array();
    const cached = this.data.get(path);
    if (cached) return cached;
    const entry = this.entries.get(path);
    if (!entry || entry.kind === 'dir') throw fsError('EISDIR', 'read', path);
    throw fsError(
      'ENOTSUP',
      'read',
      path,
      undefined,
    );
  }

  /**
   * Read the bytes of an existing file, or explain why they are not in memory.
   *
   * A miss is not a bug: the script may read a file this execution created
   * after the snapshot, or the library may be over the snapshot limit.
   */
  private bytesOrExplain(path: string): Uint8Array {
    try {
      return this.bytesOf(path);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'ENOTSUP') throw new Error(this.contentsMessage(path));
      throw error;
    }
  }

  private contentsMessage(path: string): string {
    if (this.contents === 'too-large') {
      const mib = (this.totalBytes / (1024 * 1024)).toFixed(1);
      return (
        `fs: the file library is ${mib} MiB, above the ${CONTENT_SNAPSHOT_LIMIT_BYTES / (1024 * 1024)} MiB ` +
        `synchronous-fs snapshot limit, so '${path}' cannot be read synchronously; ` +
        `use \`await fs.readFile(...)\` instead`
      );
    }
    return (
      `fs: '${path}' is not in the synchronous snapshot; ` +
      'use `await fs.readFile(...)` for files written while the script runs'
    );
  }

  private read(path: string, encoding: unknown): string | Uint8Array {
    const device = deviceKind(path);
    if (device === 'dir') throw fsError('EISDIR', 'read', path);
    const entry = this.requireEntry(path, 'open');
    if (entry.kind === 'dir') throw fsError('EISDIR', 'read', path);
    const bytes = this.bytesOrExplain(path);
    if (typeof encoding === 'string') return textFromBytes(bytes, encoding);
    return bytes;
  }

  private write(
    path: string,
    payload: Record<string, unknown>,
    options: { append: boolean; exclusive: boolean },
  ): void {
    const device = deviceKind(path);
    if (device === 'dir') throw fsError('EISDIR', 'open', path);
    if (device) return;
    const existing = this.entries.get(path);
    if (existing?.kind === 'dir') throw fsError('EISDIR', 'open', path);
    if (options.exclusive && existing) throw fsError('EEXIST', 'open', path);
    const addition = decodeData(payload);
    let bytes = addition;
    if (options.append) {
      const current = existing ? this.bytesOrExplain(path) : new Uint8Array();
      bytes = concatBytes(current, addition);
    }
    // The async `fs.writeFile` creates missing parents, and a script that mixes
    // both APIs must not see one of them refuse what the other accepts.
    this.ensureDir(parentOf(path));
    this.entries.set(path, {
      kind: 'file',
      size: bytes.length,
      mtime: Date.now(),
      mode: existing?.mode ?? FILE_MODE,
    });
    this.data.set(path, bytes);
    this.journal.push({ op: 'write', path, bytes });
  }

  private readdir(path: string, withFileTypes: boolean): Array<string | DirentPayload> {
    const normalized = normalizeVfsPath(path);
    if (deviceKind(normalized) === 'dir') {
      const names = ['null', 'zero'];
      return withFileTypes
        ? names.map((name) => ({ name, isFile: true, isDirectory: false, isSymbolicLink: false }))
        : names;
    }
    if (deviceKind(normalized)) throw fsError('ENOTDIR', 'scandir', normalized);
    const entry = this.requireEntry(normalized, 'scandir');
    if (entry.kind !== 'dir') throw fsError('ENOTDIR', 'scandir', normalized);
    const prefix = normalized === '/' ? '/' : `${normalized}/`;
    const children = new Map<string, 'file' | 'dir'>();
    for (const [candidate, candidateEntry] of this.entries) {
      if (!candidate.startsWith(prefix) || candidate === normalized) continue;
      const rest = candidate.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      if (children.get(name) === 'dir') continue;
      children.set(name, slash === -1 && candidateEntry.kind === 'file' ? 'file' : 'dir');
    }
    const names = [...children.keys()].sort();
    if (!withFileTypes) return names;
    return names.map((name) => ({
      name,
      isFile: children.get(name) === 'file',
      isDirectory: children.get(name) === 'dir',
      isSymbolicLink: false,
    }));
  }

  private stat(path: string): StatPayload {
    const entry = this.requireEntry(path, 'stat');
    return {
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'dir',
      isSymbolicLink: false,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime,
    };
  }

  private exists(path: string): boolean {
    return this.entry(path) !== undefined;
  }

  private mkdir(path: string, recursive: boolean): { firstCreated?: string } {
    const device = deviceKind(path);
    if (device === 'dir') return {};
    if (device) throw fsError('EEXIST', 'mkdir', path);
    if (path === '/') return {};
    const existing = this.entries.get(path);
    if (existing) {
      if (recursive && existing.kind === 'dir') return {};
      throw fsError('EEXIST', 'mkdir', path);
    }
    const parent = parentOf(path);
    if (!this.exists(parent)) {
      if (!recursive) throw fsError('ENOENT', 'mkdir', parent);
      const created = this.mkdir(parent, true);
      this.ensureDir(path);
      return { firstCreated: created.firstCreated ?? path };
    }
    this.ensureDir(path);
    return { firstCreated: recursive ? path : undefined };
  }

  private rm(path: string, recursive: boolean, force: boolean): void {
    if (deviceKind(path)) throw fsError('EPERM', 'unlink', path);
    if (path === '/') throw fsError('EBUSY', 'rmdir', path);
    const entry = this.entries.get(path);
    if (!entry) {
      if (force) return;
      throw fsError('ENOENT', 'unlink', path);
    }
    if (entry.kind === 'dir') {
      const prefix = `${path}/`;
      const children = [...this.entries.keys()].filter((candidate) => candidate.startsWith(prefix));
      if (children.length > 0 && !recursive) throw fsError('ENOTEMPTY', 'rmdir', path);
      for (const child of children) {
        this.entries.delete(child);
        this.data.delete(child);
      }
      this.journal.push({ op: 'rm', path, recursive: true, force: false });
    } else {
      this.journal.push({ op: 'rm', path, recursive: false, force: false });
    }
    this.entries.delete(path);
    this.data.delete(path);
  }

  private rename(from: string, to: string): void {
    if (deviceKind(from) || deviceKind(to)) {
      throw fsError('EPERM', 'rename', from, to);
    }
    const source = this.entries.get(from);
    if (!source) throw fsError('ENOENT', 'rename', from);
    if (from === to) return;
    const dest = this.entries.get(to);
    if (dest?.kind === 'dir') throw fsError('EEXIST', 'rename', from, to);
    this.ensureDir(parentOf(to));
    const moving = [...this.entries.keys()].filter(
      (candidate) => candidate === from || candidate.startsWith(`${from}/`),
    );
    for (const candidate of moving) {
      const target = to + candidate.slice(from.length);
      const entry = this.entries.get(candidate);
      if (entry) this.entries.set(target, entry);
      const bytes = this.data.get(candidate);
      if (bytes) this.data.set(target, bytes);
      this.entries.delete(candidate);
      this.data.delete(candidate);
    }
    this.journal.push({ op: 'mv', from, to });
  }

  private copy(
    from: string,
    to: string,
    options: { exclusive: boolean; recursive: boolean },
  ): void {
    const source = this.requireEntry(from, 'copyfile');
    if (deviceKind(to) === 'dir') throw fsError('EISDIR', 'copyfile', to, from);
    if (deviceKind(to)) return;
    if (options.exclusive && this.entries.get(to)) {
      throw fsError('EEXIST', 'copyfile', to, from);
    }
    if (source.kind === 'file') {
      if (this.entries.get(to)?.kind === 'dir') throw fsError('EISDIR', 'copyfile', to, from);
      const bytes = this.bytesOrExplain(from);
      this.ensureDir(parentOf(to));
      this.entries.set(to, { ...source, mtime: Date.now() });
      this.data.set(to, bytes);
      this.journal.push({ op: 'cp', from, to });
      return;
    }
    if (!options.recursive) throw fsError('EISDIR', 'copyfile', from);
    const prefix = `${from}/`;
    const moving = [...this.entries.keys()].filter((candidate) => candidate.startsWith(prefix));
    for (const candidate of moving) {
      const entry = this.entries.get(candidate);
      if (!entry) continue;
      const target = to + candidate.slice(from.length);
      if (entry.kind === 'dir') {
        this.ensureDir(target);
        continue;
      }
      const bytes = this.bytesOrExplain(candidate);
      this.data.set(target, bytes);
      this.entries.set(target, { ...entry });
    }
    this.journal.push({ op: 'cp', from, to });
  }

  private chmod(path: string, mode: number): void {
    if (deviceKind(path)) return;
    const entry = this.requireEntry(path, 'chmod');
    this.entries.set(path, { ...entry, mode });
    this.journal.push({ op: 'chmod', path, mode });
  }

  private utimes(path: string, payload: Record<string, unknown>): void {
    if (deviceKind(path)) return;
    const entry = this.requireEntry(path, 'utimes');
    const mtime = Number(payload.mtime ?? Date.now());
    this.entries.set(path, { ...entry, mtime });
    this.journal.push({
      op: 'utimes',
      path,
      atime: Number(payload.atime ?? mtime),
      mtime,
    });
  }

  private truncate(path: string, length: number): void {
    const entry = this.requireEntry(path, 'open');
    if (entry.kind === 'dir') throw fsError('EISDIR', 'open', path);
    if (!Number.isFinite(length) || length < 0) {
      throw fsError('EINVAL', 'open', path);
    }
    const bytes = this.bytesOrExplain(path);
    const next = new Uint8Array(Math.max(0, Math.trunc(length)));
    next.set(bytes.subarray(0, next.length));
    this.entries.set(path, { ...entry, size: next.length, mtime: Date.now() });
    this.data.set(path, next);
    this.journal.push({ op: 'write', path, bytes: next });
  }

  private realpath(path: string): string {
    const normalized = normalizeVfsPath(path);
    if (!this.exists(normalized)) throw fsError('ENOENT', 'realpath', normalized);
    return normalized;
  }

  /** Create `path` and its ancestors in the view, journalling each directory. */
  private ensureDir(path: string): void {
    if (path === '/' || path === '') return;
    if (this.exists(path)) return;
    this.ensureDir(parentOf(path));
    this.entries.set(path, { kind: 'dir', size: 0, mtime: Date.now(), mode: DIR_MODE });
    this.journal.push({ op: 'mkdir', path });
  }

  // -------------------------------------------------------------------------
  // Store access
  // -------------------------------------------------------------------------

  /** Pick up writes made by `exec` or an MCP tool between two sync calls. */
  private async refreshIndex(): Promise<void> {
    try {
      await this.fs.refresh?.();
    } catch {
      // A failed refresh keeps the previous view; the next async op retries.
    }
  }

  private rebase(keepContent: Set<string> = new Set()): void {
    const snapshot = this.fs.snapshotSync;
    if (typeof snapshot !== 'function') return;
    const previous = this.entries;
    const next = new Map<string, Entry>();
    for (const entry of snapshot.call(this.fs)) {
      next.set(entry.path, {
        kind: entry.kind,
        size: entry.size,
        mtime: entry.mtime,
        mode: entry.mode,
      });
    }
    this.entries = next;
    for (const path of [...this.data.keys()]) {
      const after = next.get(path);
      if (!after || after.kind !== 'file') {
        if (!keepContent.has(path)) this.data.delete(path);
        continue;
      }
      const before = previous.get(path);
      if (keepContent.has(path)) continue;
      if (before && before.size === after.size && before.mtime === after.mtime) continue;
      // Written by something outside this script (`exec`, an MCP tool): the
      // cached bytes are stale, so the next synchronous read reports it instead
      // of returning the old content.
      this.data.delete(path);
    }
  }

  /**
   * Read every file whose bytes are not cached yet.
   *
   * One round trip per file against IndexedDB, so a handful run in parallel:
   * a script that reads one file still has to wait for the whole snapshot, and
   * a serial walk of a few hundred small files is what made the first
   * `readFileSync` feel slow.
   */
  private async fillContents(): Promise<void> {
    const pending: string[] = [];
    for (const [path, entry] of this.entries) {
      if (entry.kind !== 'file' || this.data.has(path)) continue;
      pending.push(path);
    }
    let index = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const path = pending[index];
        index += 1;
        if (path === undefined) return;
        try {
          const bytes = await this.fs.readFileBuffer(path);
          this.data.set(path, bytes);
          this.contentMisses.delete(path);
        } catch {
          // Unreadable file: leave it out and let the sync read explain why.
          this.contentMisses.add(path);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  }

  private async apply(op: JournalOp): Promise<void> {
    switch (op.op) {
      case 'write':
        await this.fs.writeFile(op.path, op.bytes);
        return;
      case 'mkdir':
        await this.fs.mkdir(op.path, { recursive: true });
        return;
      case 'rm':
        await this.fs.rm(op.path, { recursive: op.recursive, force: op.force });
        return;
      case 'mv':
        await this.fs.mv(op.from, op.to);
        return;
      case 'cp':
        await this.fs.cp(op.from, op.to, { recursive: true });
        return;
      case 'chmod':
        await this.fs.chmod(op.path, op.mode);
        return;
      case 'utimes':
        await this.fs.utimes(op.path, new Date(op.atime), new Date(op.mtime));
        return;
      default:
        return;
    }
  }
}

/** fs APIs that need the file bytes in memory before the VM starts. */
const CONTENT_SYNC_PATTERN =
  /\b(?:readFileSync|appendFileSync|copyFileSync|cpSync|openSync|truncateSync|ftruncateSync|readSync)\b/;

/** Any `*Sync` fs API at all — metadata-only calls need no snapshot. */
const ANY_SYNC_PATTERN =
  /\b(?:readFile|writeFile|appendFile|exists|stat|lstat|readdir|mkdir|rmdir|rm|unlink|rename|copyFile|cp|realpath|chmod|lchmod|utimes|truncate|ftruncate|open|close|access|mkdtemp|read|write|fstat|fsync|fdatasync)Sync\b/;

/**
 * Decide how much of the VFS the guest needs before it runs.
 *
 * `null` means the script never touches a synchronous fs API, so the bridge
 * stays inactive and the async host path is used unchanged.
 */
export function detectSyncFsUsage(sources: string[]): { contents: boolean } | null {
  let active = false;
  let contents = false;
  for (const source of sources) {
    if (ANY_SYNC_PATTERN.test(source)) active = true;
    if (CONTENT_SYNC_PATTERN.test(source)) {
      active = true;
      contents = true;
    }
  }
  return active ? { contents } : null;
}
