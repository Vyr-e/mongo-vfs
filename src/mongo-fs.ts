import { createHash, randomUUID } from "node:crypto";
import { applyPatch } from "diff";
import { Binary, Db, MongoClient, type ChangeStream, type ClientSession, type Collection, type MongoClientOptions } from "mongodb";
import type {
  BufferEncoding,
  CpOptions,
  CreateExclusiveOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";

// just-bash 3.6.0 ships these in dist/fs/interface.d.ts but forgets to
// re-export them at the package root; mirror the shapes until it does.
interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}
interface WriteFileOptions {
  encoding?: BufferEncoding;
}
interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
import { VfsError, fsErr } from "./errors.js";
import { basename, dirname, joinPath, normalizePath, resolvePath } from "./path.js";
import { PathTree, type Node } from "./tree.js";

const INLINE_LIMIT = 64 * 1024;
// Content-defined chunking (FastCDC-style gear hash): cut points depend on the
// bytes, not on offsets, so an insert or delete only re-chunks the region it
// touches instead of every chunk after it.
const CHUNK_MIN = 4 * 1024;
const CHUNK_AVG = 16 * 1024;
const CHUNK_MAX = 64 * 1024;
const MASK_STABLE = (1 << 14) - 1; // below the target size, a cut needs 14 mask bits
const MASK_EAGER = (1 << 13) - 1; // past it, 13 bits: cuts come faster
const DEFAULT_OP_TTL_SECONDS = 30 * 24 * 60 * 60;
const SYNC_DELAY_MS = 25;
const FILE_MODE = 0o644;
const DIR_MODE = 0o755;
const LINK_MODE = 0o777;

export interface OpenOptions {
  db: string;
  workspace: string;
  /**
   * MongoDB driver options (auth, TLS, pool sizes, timeouts, appName, ...),
   * applied when `target` is a connection URI. Ignored when a MongoClient or Db
   * is passed — that instance already carries its configuration. Setting
   * `replicaSet` here counts as naming your replica set, so the automatic
   * `replicaSet=rs0` append for local URIs is skipped.
   */
  mongoOptions?: MongoClientOptions;
  /**
   * Path guard, enforced inside the filesystem after symlink resolution: return
   * true to fail every read, write, metadata, and listing call on that path and
   * everything under it. Receives normalized absolute logical paths, including
   * each component walked while resolving symlinks, so links cannot route
   * around it. See denySubtrees().
   */
  deny?: (path: string) => boolean;
  /** Seconds a file_ops row survives before Mongo's TTL sweep deletes it. Default 30 days. */
  opTtlSeconds?: number;
  /** Watch file_ops so writes from other MongoFs instances appear without a restart. Default true. */
  watch?: boolean;
}

export type MongoFsTarget = string | MongoClient | Db;
type MaybePromise<T> = T | Promise<T>;
/** A user-supplied connection getter — e.g. the app's `getDb()`/`getMongo()` util, called once at open. */
export type MongoFsTargetFactory = () => MaybePromise<MongoFsTarget>;

interface BlobDoc {
  _id: string;
  size: number;
  content: Binary;
  refs?: number;
}

interface FileOpDoc {
  _id: string;
  workspace_id: string;
  path: string;
  rev_from: number;
  rev_to: number;
  op: string;
  bytes_in: number;
  bytes_out: number;
  detail: Record<string, unknown>;
  created_at: Date;
}

interface WorkspaceDoc {
  _id: string;
  name: string;
  owner_id: string;
  meta: Record<string, unknown>;
  created_at: Date;
}

interface FileDoc {
  workspace_id: string;
  path: string;
  rev: number;
  size: number;
  content_hash: string;
  storage: "inline" | "cas";
  content?: Binary | Buffer | null;
  chunk_size?: number | null;
  chunks?: string[] | null;
  kind: "file" | "dir" | "symlink";
  mode: number;
  mtime: Date;
  target?: string | null;
  updated_at: Date;
}

function hostOf(entry: string): string {
  let host = entry.trim();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = end === -1 ? host.slice(1) : host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) host = host.slice(0, colon);
  }
  return host.toLowerCase();
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127(\.\d+){3}$/.test(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  );
}

/**
 * Local single-node dev deployments need the replica set named for transactions
 * to be available, and the conventional name is rs0. Managed clusters (Atlas
 * and most real deployments) select their own replica set from the hosts in the
 * URI, and `replicaSet=rs0` breaks server selection there, so only local-only
 * URIs get the parameter appended.
 */
export function withReplicaSet(uri: string): string {
  if (/[?&]replicaSet=/.test(uri)) return uri;
  const scheme = /^mongodb(\+srv)?:\/\//i.exec(uri);
  if (!scheme || scheme[1]) return uri;
  const authority = uri.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
  const hostPart = authority.includes("@") ? authority.slice(authority.lastIndexOf("@") + 1) : authority;
  if (!hostPart || !hostPart.split(",").every((entry) => isLocalHost(hostOf(entry)))) return uri;
  return `${uri}${uri.includes("?") ? "&" : "?"}replicaSet=rs0`;
}

function sha(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Fixed gear table, so chunk boundaries are identical in every process and run.
 * A byte's contribution is shifted left one bit per following byte and falls out
 * after 32, which makes the cumulative gear hash effectively windowed: cut
 * decisions depend only on the last 32 bytes, so boundaries re-converge shortly
 * after an edited region.
 */
const GEAR: Uint32Array = buildGear();

function buildGear(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    table[i] = createHash("sha256").update(`vfs-gear-${i}`).digest().readUInt32BE(0);
  }
  return table;
}

/** End offset (exclusive) of the chunk starting at `start`. */
function cutPoint(bytes: Buffer, start: number): number {
  const hardMax = Math.min(bytes.length, start + CHUNK_MAX);
  const minEnd = start + CHUNK_MIN;
  let h = 0;
  for (let pos = start; pos < hardMax; pos++) {
    h = ((h << 1) + GEAR[bytes[pos]!]) >>> 0;
    if (pos < minEnd) continue;
    if ((h & (pos - start < CHUNK_AVG ? MASK_STABLE : MASK_EAGER)) === 0) return pos + 1;
  }
  return hardMax;
}

/** Mongo duplicate-key error, i.e. another instance created the same path first. */
function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number | string; message?: string };
  return e?.code === 11000 || e?.code === "11000" || !!e?.message?.includes("E11000");
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Binary) return Buffer.from(value.read(0, value.length()));
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.alloc(0);
}

function encodingOf(options?: WriteFileOptions | BufferEncoding | ReadFileOptions | null): BufferEncoding | null | undefined {
  if (!options) return undefined;
  if (typeof options === "string") return options;
  return options.encoding;
}

function toBytes(content: FileContent, encoding?: BufferEncoding): Buffer {
  if (content instanceof Uint8Array) return Buffer.from(content);
  const enc = encoding ?? "utf8";
  if (enc === "hex" || enc === "base64" || enc === "ascii" || enc === "utf8" || enc === "utf-8" || enc === "latin1" || enc === "binary") {
    const nodeEnc = enc === "utf-8" ? "utf8" : enc === "binary" ? "latin1" : enc;
    return Buffer.from(content, nodeEnc);
  }
  return Buffer.from(content, "utf8");
}

function fromBytes(bytes: Uint8Array, encoding?: BufferEncoding | null): string {
  const enc = encoding ?? "utf8";
  const nodeEnc = enc === "utf-8" ? "utf8" : enc === "binary" ? "latin1" : enc;
  return Buffer.from(bytes).toString(nodeEnc);
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let i = 0;
  while (needle.length > 0) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) break;
    n += 1;
    i = at + needle.length;
  }
  return n;
}

export class MongoFs implements IFileSystem {
  /** Logical file bodies loaded from Mongo during this session. */
  contentFetches = 0;

  get workspaceId(): string {
    return this.workspace;
  }

  private readonly cache = new Map<string, Uint8Array>();
  private readonly tree = new PathTree();
  private watch: ChangeStream<FileOpDoc> | null = null;
  private watchBroken = false;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private readonly pendingPaths = new Set<string>();
  private lastLocalCommitAt = new Date(0);

  private constructor(
    private readonly client: MongoClient,
    private readonly database: Db,
    private readonly workspace: string,
    private readonly files: Collection<FileDoc>,
    private readonly blobs: Collection<BlobDoc>,
    private readonly ops: Collection<FileOpDoc>,
    private readonly workspaces: Collection<WorkspaceDoc>,
    private readonly deny: ((path: string) => boolean) | null,
    private readonly watchEnabled: boolean,
    private readonly opTtlSeconds: number,
    private readonly ownsClient: boolean,
  ) {}

/**
 * `target` is a connection URI, an existing MongoClient, an existing Db, or a
 * function returning any of those (sync or async) — pass the app's mongo util
 * directly and the filesystem awaits it once at open. A URI gets a dedicated
 * client built with `options.mongoOptions` (so a user's auth/TLS/pool config
 * rides along) that close() and destroy() close; a passed client or Db is only
 * used, never closed — its owner keeps the connection alive across
 * close()/destroy() (destroy still deletes this workspace's data). `options.db`
 * picks the database for a URI or client and is ignored when a Db is passed.
 */
  static async open(
    target: MongoFsTarget | MongoFsTargetFactory,
    options: OpenOptions,
  ): Promise<MongoFs> {
    const resolved: MongoFsTarget =
      typeof target === "function" ? await (target as MongoFsTargetFactory)() : target;
    let client: MongoClient;
    let database: Db;
    let ownsClient = false;
    if (typeof resolved === "string") {
      // An explicit replicaSet in mongoOptions means the caller named their
      // topology; the local-rs0 default would only fight it.
      const uri = options.mongoOptions?.replicaSet ? resolved : withReplicaSet(resolved);
      client = new MongoClient(uri, options.mongoOptions);
      await client.connect();
      database = client.db(options.db);
      ownsClient = true;
    } else if (resolved instanceof Db) {
      client = resolved.client;
      database = resolved;
    } else if (resolved instanceof MongoClient) {
      client = resolved;
      database = client.db(options.db);
    } else {
      throw new Error(
        "mongo-vfs: a connection target must be a URI string, a MongoClient, a Db, or a function returning one of them",
      );
    }
    const fs = new MongoFs(
      client,
      database,
      options.workspace,
      database.collection<FileDoc>("files"),
      database.collection<BlobDoc>("blobs"),
      database.collection<FileOpDoc>("file_ops"),
      database.collection<WorkspaceDoc>("workspaces"),
      options.deny ?? null,
      options.watch !== false,
      options.opTtlSeconds ?? DEFAULT_OP_TTL_SECONDS,
      ownsClient,
    );
    await fs.init();
    return fs;
  }

  async close(): Promise<void> {
    this.stopWatch();
    if (this.ownsClient) await this.client.close();
  }

  async destroy(): Promise<void> {
    this.stopWatch();
    // Blobs are shared across workspaces by content hash, so release this
    // workspace's references and delete only the ones that reach zero.
    const casDocs = await this.files
      .find({ workspace_id: this.workspace, storage: "cas" }, { projection: { chunks: 1 } })
      .toArray();
    const hashes: string[] = [];
    for (const doc of casDocs) hashes.push(...(doc.chunks ?? []));
    await this.files.deleteMany({ workspace_id: this.workspace });
    await this.releaseChunks(hashes);
    await this.ops.deleteMany({ workspace_id: this.workspace });
    await this.workspaces.deleteOne({ _id: this.workspace });
    await this.close();
  }

  /**
   * Reload the tree from Mongo and drop cached bodies whose rev changed. Runs
   * automatically from the file_ops change stream; call it directly to pick up
   * another process's writes on demand (for example before retrying a conflict).
   */
  async refresh(): Promise<void> {
    const docs = await this.files
      .find({ workspace_id: this.workspace }, { projection: { content: 0 } })
      .toArray();
    const byPath = new Map<string, FileDoc>();
    for (const doc of docs) {
      if (!doc.path || doc.path === "/") continue;
      byPath.set(doc.path, doc);
    }
    for (const [path, doc] of byPath) {
      const cur = this.tree.get(path);
      if (!cur || cur.rev !== doc.rev || cur.size !== doc.size || cur.kind !== doc.kind) {
        this.ensureMemoryDirs(dirname(path));
        this.tree.add(path, this.nodeFromDoc(doc));
        this.cache.delete(path);
      }
    }
    // Keep in-memory-only dirs that are still ancestors of live docs; the rest
    // of the tree no longer matches Mongo and goes away with its cached bodies.
    const keep = new Set<string>();
    for (const path of byPath.keys()) {
      let cur = dirname(path);
      while (cur !== "/") {
        keep.add(cur);
        cur = dirname(cur);
      }
    }
    for (const key of [...this.tree.nodes.keys()]) {
      if (key === "/" || byPath.has(key) || keep.has(key)) continue;
      this.tree.removeTree(key);
      this.cache.delete(key);
    }
  }

  resolvePath(base: string, path: string): string {
    return resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.tree.allPaths();
  }

  async revision(path: string): Promise<number> {
    const real = this.follow(normalizePath(path));
    return this.must(real, "stat").rev;
  }

  async readExcerpt(path: string, offset: number, limit: number): Promise<Uint8Array> {
    if (offset < 0 || limit < 0) {
      throw new VfsError("invalid_range", normalizePath(path), "offset and limit must be >= 0");
    }
    const bytes = await this.readFileBuffer(path);
    if (offset > bytes.length) {
      throw new VfsError("invalid_range", normalizePath(path), "offset past end");
    }
    const end = limit === 0 ? bytes.length : Math.min(bytes.length, offset + limit);
    return bytes.slice(offset, end);
  }

  async chunkHashes(path: string): Promise<string[] | null> {
    const real = this.follow(normalizePath(path));
    const node = this.must(real, "stat");
    if (node.kind !== "file") throw new VfsError("not_found", real, "not a file");
    if (node.storage !== "cas") return null;
    const doc = await this.files.findOne(
      { workspace_id: this.workspace, path: real },
      { projection: { chunks: 1, storage: 1 } },
    );
    return doc?.chunks ?? null;
  }

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const bytes = await this.readFileBuffer(path);
    return fromBytes(bytes, encodingOf(options) ?? "utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const real = this.follow(normalizePath(path));
    const node = this.must(real, "open");
    if (node.kind === "dir") throw fsErr("EISDIR", "read", path);
    if (node.kind === "symlink") throw fsErr("EINVAL", "read", path, "unresolved symlink");
    return this.loadBytes(real);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const norm = normalizePath(path);
    await this.ensureParents(dirname(norm));
    const target = this.resolveLeaf(norm, true);
    const bytes = toBytes(content, encodingOf(options) ?? undefined);
    await this.writeBytes(target, bytes, "writeFile", bytes.length);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const norm = normalizePath(path);
    await this.ensureParents(dirname(norm));
    const target = this.resolveLeaf(norm, true);
    const extra = toBytes(content, encodingOf(options) ?? undefined);
    const node = this.tree.get(target);
    const existing = node?.kind === "file" ? Buffer.from(await this.loadBytes(target)) : Buffer.alloc(0);
    if (node && node.kind !== "file") throw fsErr("EISDIR", "open", path);
    const next = Buffer.concat([existing, extra]);
    await this.writeBytes(target, next, "appendFile", extra.length, { ifRev: node?.rev });
  }

  async exists(path: string): Promise<boolean> {
    try {
      this.follow(normalizePath(path));
      return true;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (message.startsWith("ENOENT") || message.startsWith("ELOOP") || message.startsWith("ENOTDIR")) return false;
      throw err;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const real = this.follow(normalizePath(path));
    return this.toStat(real, this.must(real, "stat"), false);
  }

  async lstat(path: string): Promise<FsStat> {
    const full = this.leaf(normalizePath(path), "lstat");
    const node = this.must(full, "lstat");
    return this.toStat(full, node, node.kind === "symlink");
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const norm = normalizePath(path);
    if (norm === "/") return;
    if (options?.recursive) {
      await this.ensureParents(norm);
      return;
    }
    const parent = dirname(norm);
    const realParent = this.follow(parent);
    if (this.must(realParent, "mkdir").kind !== "dir") throw fsErr("ENOTDIR", "mkdir", path);
    const full = joinPath(realParent, basename(norm));
    this.assertAllowed(full, "mkdir");
    if (this.tree.has(full)) throw fsErr("EEXIST", "mkdir", path);
    await this.putDir(full, DIR_MODE);
  }

  async createExclusive(path: string, options: CreateExclusiveOptions): Promise<void> {
    const norm = normalizePath(path);
    const realParent = this.follow(dirname(norm));
    if (this.must(realParent, "mkdir").kind !== "dir") throw fsErr("ENOTDIR", "open", path);
    const full = joinPath(realParent, basename(norm));
    this.assertAllowed(full, "open");
    if (this.tree.has(full)) throw fsErr("EEXIST", "open", path);
    if (options.directory) await this.putDir(full, options.mode);
    else await this.writeBytes(full, Buffer.alloc(0), "createExclusive", 0, { mode: options.mode });
  }

  async readdir(path: string): Promise<string[]> {
    const real = this.follow(normalizePath(path));
    if (this.must(real, "scandir").kind !== "dir") throw fsErr("ENOTDIR", "scandir", path);
    return this.tree.list(real);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const real = this.follow(normalizePath(path));
    if (this.must(real, "scandir").kind !== "dir") throw fsErr("ENOTDIR", "scandir", path);
    return this.tree.list(real).map((name) => {
      const node = this.must(joinPath(real, name), "scandir");
      return {
        name,
        isFile: node.kind === "file",
        isDirectory: node.kind === "dir",
        isSymbolicLink: node.kind === "symlink",
      };
    });
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    let full: string;
    try {
      full = this.leaf(normalizePath(path), "rm");
    } catch (err) {
      if (options?.force) return;
      throw err;
    }
    const node = this.must(full, "rm");
    if (node.kind === "dir" && this.tree.list(full).length > 0 && !options?.recursive) {
      throw fsErr("ENOTEMPTY", "rm", path);
    }
    const removed = await this.txn((session) => this.removeTxn(session, full));
    for (const gone of removed) this.cache.delete(gone);
    this.tree.removeTree(full);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const from = this.leaf(normalizePath(src), "cp");
    const node = this.must(from, "cp");
    if (node.kind === "dir") {
      if (!options?.recursive) throw fsErr("EISDIR", "cp", src);
      await this.copyTree(from, await this.destPath(dest, from));
      return;
    }
    if (node.kind === "symlink") {
      await this.symlink(node.target ?? "", dest);
      return;
    }
    const bytes = await this.loadBytes(from);
    await this.writeFile(await this.destPath(dest, from), bytes);
  }

  async mv(src: string, dest: string): Promise<void> {
    const from = this.leaf(normalizePath(src), "mv");
    const target = await this.destPath(dest, from);
    if (target === from) return;
    if (target.startsWith(`${from}/`)) throw fsErr("EINVAL", "mv", dest, "cannot move a directory into itself");
    const keys = [...this.tree.nodes.keys()]
      .filter((key) => key === from || key.startsWith(`${from}/`))
      .sort((a, b) => b.length - a.length);
    const now = new Date();
    await this.txn(async (session) => {
      // Replacing the target and moving happen in one transaction: a crash in
      // between can no longer leave the target deleted without the move done.
      if (this.tree.has(target)) await this.removeTxn(session, target);
      for (const key of keys) {
        const node = this.must(key, "mv");
        const next = target + key.slice(from.length);
        const rev = node.rev + 1;
        const res = await this.files.updateOne(
          { workspace_id: this.workspace, path: key },
          { $set: { path: next, rev, mtime: now, updated_at: now } },
          { session },
        );
        if (res.matchedCount !== 1) {
          throw new VfsError("conflict", key, "path changed during mv");
        }
        await this.insertOp(session, next, "mv", node.rev, rev, 0, node.size, { from: key });
      }
    });
    if (this.tree.has(target)) {
      for (const gone of this.tree.nodes.keys()) {
        if (gone === target || gone.startsWith(`${target}/`)) this.cache.delete(gone);
      }
      this.tree.removeTree(target);
    }
    for (const key of keys) {
      const next = target + key.slice(from.length);
      const cached = this.cache.get(key);
      if (cached) {
        this.cache.delete(key);
        this.cache.set(next, cached);
      }
    }
    this.tree.renameSubtree(from, target);
    for (const key of keys) {
      const next = target + key.slice(from.length);
      const node = this.tree.get(next);
      if (node) {
        node.rev += 1;
        node.mtime = now;
      }
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const real = this.follow(normalizePath(path));
    const node = this.must(real, "chmod");
    const now = new Date();
    await this.txn(async (session) => {
      const res = await this.files.updateOne(
        { workspace_id: this.workspace, path: real, rev: node.rev },
        { $set: { mode, rev: node.rev + 1, mtime: now, updated_at: now } },
        { session },
      );
      if (res.matchedCount !== 1) throw new VfsError("conflict", real, `rev ${node.rev} changed before chmod`);
      await this.insertOp(session, real, "chmod", node.rev, node.rev + 1, 0, node.size);
    });
    node.mode = mode;
    node.rev += 1;
    node.mtime = now;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    const real = this.follow(normalizePath(path));
    const node = this.must(real, "utimes");
    await this.txn(async (session) => {
      const res = await this.files.updateOne(
        { workspace_id: this.workspace, path: real, rev: node.rev },
        { $set: { mtime, rev: node.rev + 1, updated_at: new Date() } },
        { session },
      );
      if (res.matchedCount !== 1) throw new VfsError("conflict", real, `rev ${node.rev} changed before utimes`);
      await this.insertOp(session, real, "utimes", node.rev, node.rev + 1, 0, node.size);
    });
    node.mtime = mtime;
    node.rev += 1;
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const norm = normalizePath(linkPath);
    await this.ensureParents(dirname(norm));
    const full = this.resolveLeaf(norm, false);
    if (this.tree.has(full)) throw fsErr("EEXIST", "symlink", linkPath);
    const now = new Date();
    const bytes = Buffer.from(target, "utf8");
    await this.txn(async (session) => {
      try {
        await this.files.insertOne(this.doc({
          path: full,
          kind: "symlink",
          mode: LINK_MODE,
          mtime: now,
          rev: 1,
          size: bytes.length,
          storage: "inline",
          content: null,
          chunks: null,
          chunk_size: null,
          target,
          content_hash: sha(bytes),
        }), { session });
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw new VfsError("EEXIST", full, "path already exists (created by another process)");
        }
        throw err;
      }
      await this.insertOp(session, full, "symlink", 0, 1, bytes.length, bytes.length);
    });
    this.tree.add(full, {
      kind: "symlink",
      mode: LINK_MODE,
      mtime: now,
      size: bytes.length,
      rev: 1,
      storage: "inline",
      target,
    });
  }

  async readlink(path: string): Promise<string> {
    const full = this.leaf(normalizePath(path), "readlink");
    const node = this.must(full, "readlink");
    if (node.kind !== "symlink" || node.target === undefined) {
      throw fsErr("EINVAL", "readlink", path, "not a symbolic link");
    }
    return node.target;
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const real = this.follow(normalizePath(existingPath));
    const node = this.must(real, "link");
    if (node.kind !== "file") throw fsErr("EPERM", "link", existingPath);
    const bytes = await this.loadBytes(real);
    await this.writeFile(newPath, bytes);
  }

  async realpath(path: string): Promise<string> {
    return this.follow(normalizePath(path));
  }

  async searchReplace(
    path: string,
    oldText: string,
    newText: string,
    opts?: { replaceAll?: boolean; ifRev?: number },
  ): Promise<{ rev: number; size: number }> {
    const shown = normalizePath(path);
    const real = this.follow(shown);
    const node = this.must(real, "open");
    if (node.kind !== "file") throw new VfsError("not_found", shown, "not a file");
    if (oldText.length === 0) throw new VfsError("invalid_argument", shown, "old string is empty");
    if (opts?.ifRev !== undefined && opts.ifRev !== node.rev) {
      throw new VfsError("conflict", shown, `ifRev ${opts.ifRev} does not match rev ${node.rev}`);
    }
    const text = Buffer.from(await this.loadBytes(real)).toString("utf8");
    const found = countOf(text, oldText);
    if (found === 0) throw new VfsError("not_found", shown, "old string was not found");
    if (!opts?.replaceAll && found !== 1) {
      throw new VfsError("not_unique", shown, `old string appears ${found} times`);
    }
    // Function replacer: a string replacer would expand $&, $', $$ in newText.
    const nextText = opts?.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
    const next = Buffer.from(nextText, "utf8");
    const bytesIn = Buffer.byteLength(oldText) + Buffer.byteLength(newText);
    const rev = await this.writeBytes(real, next, "searchReplace", bytesIn, { ifRev: node.rev, mode: node.mode });
    return { rev, size: next.length };
  }

  async applyPatch(path: string, unifiedDiff: string, opts?: { ifRev?: number }): Promise<{ rev: number; size: number }> {
    const shown = normalizePath(path);
    const real = this.follow(shown);
    const node = this.must(real, "open");
    if (node.kind !== "file") throw new VfsError("not_found", shown, "not a file");
    if (opts?.ifRev !== undefined && opts.ifRev !== node.rev) {
      throw new VfsError("conflict", shown, `ifRev ${opts.ifRev} does not match rev ${node.rev}`);
    }
    const text = Buffer.from(await this.loadBytes(real)).toString("utf8");
    let patched: string | false;
    try {
      patched = applyPatch(text, unifiedDiff, { fuzzFactor: 0 });
    } catch (err) {
      throw new VfsError("context_mismatch", shown, `unified diff was rejected (${(err as Error).message})`);
    }
    if (patched === false) {
      throw new VfsError("context_mismatch", shown, "unified diff context did not match; file unchanged");
    }
    const next = Buffer.from(patched, "utf8");
    const rev = await this.writeBytes(real, next, "applyPatch", Buffer.byteLength(unifiedDiff), { ifRev: node.rev, mode: node.mode });
    return { rev, size: next.length };
  }

  private async init(): Promise<void> {
    await this.files.createIndex({ workspace_id: 1, path: 1 }, { unique: true });
    await this.ensureOpTtlIndex();
    await this.backfillBlobRefs();
    await this.workspaces.updateOne(
      { _id: this.workspace },
      { $setOnInsert: { name: this.workspace, owner_id: "local", meta: {}, created_at: new Date() } },
      { upsert: true },
    );
    const docs = await this.files.find({ workspace_id: this.workspace }, { projection: { content: 0 } }).toArray();
    docs.sort((a, b) => a.path.length - b.path.length);
    for (const doc of docs) {
      if (!doc.path || doc.path === "/") continue;
      this.ensureMemoryDirs(dirname(doc.path));
      if (!this.tree.has(doc.path)) {
        this.tree.add(doc.path, this.nodeFromDoc(doc));
      }
    }
    this.startWatch();
  }

  private nodeFromDoc(doc: FileDoc): Node {
    return {
      kind: doc.kind,
      mode: doc.mode,
      mtime: doc.mtime instanceof Date ? doc.mtime : new Date(doc.mtime),
      size: doc.size,
      rev: doc.rev,
      storage: doc.storage,
      target: doc.target ?? undefined,
    };
  }

  private async ensureOpTtlIndex(): Promise<void> {
    const spec = { name: "file_ops_ttl", expireAfterSeconds: this.opTtlSeconds };
    try {
      await this.ops.createIndex({ created_at: 1 }, spec);
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e?.code === 85 || e?.code === 86 || /different options/i.test(e?.message ?? "")) {
        await this.ops.dropIndex("file_ops_ttl").catch(() => {});
        await this.ops.createIndex({ created_at: 1 }, spec);
      } else {
        throw err;
      }
    }
  }

  /**
   * Blobs written before reference counting carry no refs field. If any are
   * left, count every chunk occurrence across all workspaces' files once and
   * stamp it; whatever still has no count is unreferenced and gets swept.
   */
  private async backfillBlobRefs(): Promise<void> {
    const missing = await this.blobs.findOne({ refs: { $exists: false } }, { projection: { _id: 1 } });
    if (!missing) return;
    const counts = await this.files
      .aggregate<{ _id: string; n: number }>([
        { $match: { storage: "cas" } },
        { $project: { chunks: 1 } },
        { $unwind: "$chunks" },
        { $group: { _id: "$chunks", n: { $sum: 1 } } },
      ])
      .toArray();
    if (counts.length > 0) {
      await this.blobs.bulkWrite(
        counts.map((c) => ({
          updateOne: {
            filter: { _id: c._id, refs: { $exists: false } },
            update: { $set: { refs: c.n } },
          },
        })),
        { ordered: false },
      );
    }
    await this.blobs.updateMany({ refs: { $exists: false } }, { $set: { refs: 0 } });
    await this.blobs.deleteMany({ refs: { $lte: 0 } });
  }

  /** Start the file_ops watcher that keeps this instance's tree current when other processes write. */
  private startWatch(): void {
    if (!this.watchEnabled || this.watchBroken) return;
    try {
      const stream = this.ops.watch(
        [{ $match: { operationType: "insert", "fullDocument.workspace_id": this.workspace } }],
        { fullDocument: "updateLookup" },
      );
      stream.on("change", (event) => {
        if (!("fullDocument" in event) || !event.fullDocument) return;
        const op = event.fullDocument;
        if (!op.path) return;
        this.pendingPaths.add(op.path);
        if (op.op === "mv" && typeof op.detail?.from === "string") this.pendingPaths.add(op.detail.from);
        this.scheduleSync();
      });
      // Change streams need a replica set, which transactions already require.
      // Where they are unavailable, degrade to single-process behavior plus
      // explicit refresh() calls instead of crashing the instance.
      stream.on("error", (err) => {
        this.stopWatch(true);
      });
      stream.on("close", () => {
        this.stopWatch(true);
      });
      this.watch = stream;
    } catch {
      this.stopWatch(true);
    }
  }

  private stopWatch(markBroken = false): void {
    if (markBroken) this.watchBroken = true;
    const stream = this.watch;
    this.watch = null;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingPaths.clear();
    if (stream) {
      stream.removeAllListeners();
      void stream.close().catch(() => {});
    }
  }

  private scheduleSync(): void {
    if (this.syncTimer || this.watchBroken) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      void this.flushSync();
    }, SYNC_DELAY_MS);
    this.syncTimer.unref?.();
  }

  private async flushSync(): Promise<void> {
    if (this.syncing) {
      this.scheduleSync();
      return;
    }
    this.syncing = true;
    try {
      const paths = [...this.pendingPaths];
      this.pendingPaths.clear();
      await this.syncPaths(paths);
    } catch (err) {
      // The last-known tree stays; refresh() rebuilds it on demand.
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Re-read exactly the paths named by new file_ops rows; Mongo is the source of
   * truth, the ops only say which paths to look at. A path that comes back
   * missing while one of our own transactions committed during the read is
   * deferred a batch rather than taken as deleted.
   */
  private async syncPaths(paths: string[]): Promise<void> {
    for (const path of paths) {
      if (path === "/") continue;
      const started = new Date();
      let doc = await this.files.findOne(
        { workspace_id: this.workspace, path },
        { projection: { content: 0 } },
      );
      if (!doc && this.lastLocalCommitAt > started) {
        doc = await this.files.findOne(
          { workspace_id: this.workspace, path },
          { projection: { content: 0 } },
        );
        if (!doc && this.lastLocalCommitAt > started) {
          this.pendingPaths.add(path);
          this.scheduleSync();
          continue;
        }
      }
      if (doc) {
        const cur = this.tree.get(path);
        if (!cur || cur.rev !== doc.rev || cur.size !== doc.size || cur.kind !== doc.kind) {
          this.ensureMemoryDirs(dirname(path));
          this.tree.add(path, this.nodeFromDoc(doc));
          this.cache.delete(path);
        }
      } else {
        for (const gone of this.tree.removeTree(path)) this.cache.delete(gone);
      }
    }
  }

  private ensureMemoryDirs(dir: string): void {
    if (dir === "/" || this.tree.has(dir)) return;
    this.ensureMemoryDirs(dirname(dir));
    this.tree.add(dir, {
      kind: "dir",
      mode: DIR_MODE,
      mtime: new Date(),
      size: 0,
      rev: 0,
      storage: "inline",
    });
  }

  private async loadBytes(path: string): Promise<Uint8Array> {
    this.assertAllowed(path, "open");
    const hit = this.cache.get(path);
    if (hit) return hit;
    this.contentFetches += 1;
    const doc = await this.files.findOne({ workspace_id: this.workspace, path });
    if (!doc || doc.kind !== "file") throw fsErr("ENOENT", "open", path);
    let bytes: Buffer;
    if (doc.storage === "cas") {
      const hashes = doc.chunks ?? [];
      const found = await this.blobs.find({ _id: { $in: hashes } }).toArray();
      const byId = new Map(found.map((blob) => [String(blob._id), asBuffer(blob.content)]));
      const parts: Buffer[] = [];
      for (const hash of hashes) {
        const piece = byId.get(hash);
        if (!piece) throw new Error(`missing blob ${hash}`);
        parts.push(piece);
      }
      bytes = Buffer.concat(parts);
    } else {
      bytes = doc.content ? asBuffer(doc.content) : Buffer.alloc(0);
    }
    const out = new Uint8Array(bytes);
    this.cache.set(path, out);
    return out;
  }

  private async writeBytes(
    path: string,
    bytes: Buffer,
    op: string,
    bytesIn: number,
    opts?: { ifRev?: number; mode?: number },
  ): Promise<number> {
    this.assertAllowed(path, "open");
    const node = this.tree.get(path);
    if (node?.kind === "dir") throw fsErr("EISDIR", "open", path);
    const current = node?.rev ?? 0;
    if (opts?.ifRev !== undefined && opts?.ifRev !== current) {
      throw new VfsError("conflict", path, `ifRev ${opts.ifRev} does not match rev ${current}`);
    }
    const rev = current + 1;
    const now = new Date();
    const mode = opts?.mode ?? node?.mode ?? FILE_MODE;
    const storage = bytes.length > INLINE_LIMIT ? "cas" : "inline";
    let chunks: string[] | null = null;
    await this.txn(async (session) => {
      let oldChunks: string[] | null = null;
      if (node && node.storage === "cas") {
        const old = await this.files.findOne(
          { workspace_id: this.workspace, path },
          { projection: { chunks: 1 }, session },
        );
        oldChunks = old?.chunks ?? null;
      }
      if (storage === "cas") chunks = await this.storeChunks(session, bytes);
      const set: Partial<FileDoc> = {
        workspace_id: this.workspace,
        path,
        rev,
        size: bytes.length,
        content_hash: sha(bytes),
        storage,
        content: storage === "inline" ? new Binary(bytes) : null,
        chunk_size: storage === "cas" ? CHUNK_AVG : null,
        chunks,
        kind: "file",
        mode,
        mtime: now,
        target: null,
        updated_at: now,
      };
      if (node) {
        const res = await this.files.updateOne(
          { workspace_id: this.workspace, path, rev: current },
          { $set: set },
          { session },
        );
        if (res.matchedCount !== 1) {
          throw new VfsError("conflict", path, `rev ${current} changed before ${op}`);
        }
      } else {
        try {
          await this.files.insertOne(set as FileDoc, { session });
        } catch (err) {
          if (isDuplicateKey(err)) {
            throw new VfsError("EEXIST", path, "path already exists (created by another process)");
          }
          throw err;
        }
      }
      await this.releaseChunks(oldChunks, session);
      await this.insertOp(session, path, op, current, rev, bytesIn, bytes.length);
    });
    this.tree.add(path, { kind: "file", mode, mtime: now, size: bytes.length, rev, storage });
    this.cache.set(path, new Uint8Array(bytes));
    return rev;
  }

  private async storeChunks(session: ClientSession, bytes: Buffer): Promise<string[]> {
    const unique = new Map<string, { count: number; sample: Buffer }>();
    const hashes: string[] = [];
    let start = 0;
    while (start < bytes.length) {
      const end = cutPoint(bytes, start);
      const piece = bytes.subarray(start, end);
      const hash = sha(piece);
      hashes.push(hash);
      const seen = unique.get(hash);
      if (seen) seen.count += 1;
      else unique.set(hash, { count: 1, sample: Buffer.from(piece) });
      start = end;
    }
    // One bulkWrite for the whole file: a per-chunk round trip made storing a
    // 10MB file take 640 sequential updates inside the transaction.
    await this.blobs.bulkWrite(
      [...unique].map(([hash, { count, sample }]) => ({
        updateOne: {
          filter: { _id: hash },
          update: {
            $setOnInsert: { size: sample.length, content: new Binary(sample) },
            $inc: { refs: count },
          },
          upsert: true,
        },
      })),
      { session, ordered: false },
    );
    return hashes;
  }

  /**
   * Drop one reference per occurrence of each listed hash (blobs are shared by
   * content, so counts matter) and delete the blobs that reach zero. Inside a
   * transaction this is atomic with the file update that orphaned them.
   */
  private async releaseChunks(hashes: string[] | null | undefined, session?: ClientSession): Promise<void> {
    if (!hashes || hashes.length === 0) return;
    const counts = new Map<string, number>();
    for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1);
    const ids = [...counts.keys()];
    await this.blobs.bulkWrite(
      ids.map((hash) => ({
        updateOne: {
          filter: { _id: hash },
          update: { $inc: { refs: -(counts.get(hash) ?? 0) } },
        },
      })),
      { ordered: false, ...(session ? { session } : {}) },
    );
    await this.blobs.deleteMany(
      { _id: { $in: ids }, refs: { $lte: 0 } },
      session ? { session } : {},
    );
  }

  /** Delete `full` and everything under it inside the caller's transaction, logging ops and releasing chunks. */
  private async removeTxn(session: ClientSession, full: string): Promise<string[]> {
    const removed = [...this.tree.nodes.keys()].filter((key) => key === full || key.startsWith(`${full}/`));
    if (removed.length === 0) return removed;
    const casDocs = await this.files
      .find(
        { workspace_id: this.workspace, path: { $in: removed }, storage: "cas" },
        { projection: { chunks: 1 }, session },
      )
      .toArray();
    await this.files.deleteMany({ workspace_id: this.workspace, path: { $in: removed } }, { session });
    for (const gone of removed) {
      const cur = this.tree.get(gone);
      const rev = cur?.rev ?? 0;
      await this.insertOp(session, gone, "rm", rev, rev + 1, 0, 0);
    }
    const released: string[] = [];
    for (const doc of casDocs) released.push(...(doc.chunks ?? []));
    await this.releaseChunks(released, session);
    return removed;
  }

  private async putDir(path: string, mode: number): Promise<void> {
    this.assertAllowed(path, "mkdir");
    const now = new Date();
    await this.txn(async (session) => {
      try {
        await this.files.insertOne(this.doc({
          path,
          kind: "dir",
          mode,
          mtime: now,
          rev: 1,
          size: 0,
          storage: "inline",
          content: null,
          chunks: null,
          chunk_size: null,
          target: null,
          content_hash: sha(Buffer.alloc(0)),
        }), { session });
      } catch (err) {
        if (isDuplicateKey(err)) {
          throw new VfsError("EEXIST", path, "path already exists (created by another process)");
        }
        throw err;
      }
      await this.insertOp(session, path, "mkdir", 0, 1, 0, 0);
    });
    this.tree.add(path, { kind: "dir", mode, mtime: now, size: 0, rev: 1, storage: "inline" });
  }

  private async ensureParents(dir: string): Promise<void> {
    const norm = normalizePath(dir);
    this.assertAllowed(norm, "mkdir");
    if (this.tree.has(norm) && this.must(norm, "mkdir").kind === "dir" && this.ancestorsExist(norm)) return;
    const parts = norm === "/" ? [] : norm.split("/").filter(Boolean);
    let cur = "/";
    for (const part of parts) {
      cur = joinPath(cur, part);
      this.assertAllowed(cur, "mkdir");
      const existing = this.tree.get(cur);
      if (!existing) {
        await this.putDir(cur, DIR_MODE);
      } else if (existing.kind !== "dir") {
        throw fsErr("ENOTDIR", "mkdir", cur);
      }
    }
  }

  private ancestorsExist(dir: string): boolean {
    let cur = dir;
    while (cur !== "/") {
      if (!this.tree.has(cur)) return false;
      cur = dirname(cur);
    }
    return true;
  }

  private async copyTree(src: string, dest: string): Promise<void> {
    const node = this.must(src, "cp");
    if (node.kind === "dir") {
      if (!this.tree.has(dest)) await this.mkdir(dest, { recursive: true });
      for (const name of this.tree.list(src)) {
        await this.copyTree(joinPath(src, name), joinPath(dest, name));
      }
      return;
    }
    if (node.kind === "symlink") {
      await this.symlink(node.target ?? "", dest);
      return;
    }
    await this.writeFile(dest, await this.loadBytes(src));
  }

  private async destPath(dest: string, src: string): Promise<string> {
    const norm = normalizePath(dest);
    await this.ensureParents(dirname(norm));
    if (this.tree.has(norm) && this.tree.get(norm)!.kind === "dir") {
      return joinPath(norm, basename(src));
    }
    return this.resolveLeaf(norm, true);
  }

  private resolveLeaf(path: string, followFinalSymlink: boolean): string {
    this.assertAllowed(path, "open");
    const parent = this.follow(dirname(path));
    if (this.must(parent, "open").kind !== "dir") throw fsErr("ENOTDIR", "open", path);
    const full = joinPath(parent, basename(path));
    this.assertAllowed(full, "open");
    const node = this.tree.get(full);
    if (followFinalSymlink && node?.kind === "symlink" && node.target) {
      const jumped = node.target.startsWith("/") ? normalizePath(node.target) : normalizePath(joinPath(parent, node.target));
      return this.follow(jumped);
    }
    return full;
  }

  private leaf(path: string, syscall: string): string {
    this.assertAllowed(path, syscall);
    const parent = this.follow(dirname(path));
    if (this.must(parent, syscall).kind !== "dir") throw fsErr("ENOTDIR", syscall, path);
    const full = joinPath(parent, basename(path));
    this.assertAllowed(full, syscall);
    if (!this.tree.has(full)) throw fsErr("ENOENT", syscall, path);
    return full;
  }

  private follow(path: string, depth = 0): string {
    const norm = normalizePath(path);
    if (norm === "/") return "/";
    if (depth > 40) throw fsErr("ELOOP", "open", path);
    const parts = norm.split("/").filter(Boolean);
    let cur = "/";
    for (let i = 0; i < parts.length; i++) {
      const next = joinPath(cur, parts[i]!);
      // Every component is checked as it is resolved, including components
      // reached by jumping through a symlink, so a link cannot route around
      // the guard.
      this.assertAllowed(next, "open");
      const node = this.tree.get(next);
      if (!node) throw fsErr("ENOENT", "open", path);
      if (node.kind === "symlink") {
        if (!node.target) throw fsErr("EINVAL", "open", path, "symlink has no target");
        const jumped = node.target.startsWith("/") ? normalizePath(node.target) : normalizePath(joinPath(cur, node.target));
        const rest = parts.slice(i + 1);
        const combined = rest.reduce((acc, part) => joinPath(acc, part), jumped);
        return this.follow(combined, depth + 1);
      }
      if (i < parts.length - 1 && node.kind !== "dir") throw fsErr("ENOTDIR", "open", path);
      cur = next;
    }
    return cur;
  }

  private must(path: string, syscall: string): Node {
    const node = this.tree.get(path);
    if (!node) throw fsErr("ENOENT", syscall, path);
    return node;
  }

  /**
   * The path guard: deny the path itself and any denied ancestor. Called from
   * follow()/leaf()/resolveLeaf() on resolved components and from the write
   * paths before anything is created, so relative paths, shell quoting, globs
   * (which all normalize to the same logical path) and symlinks cannot reach a
   * denied subtree.
   */
  private assertAllowed(path: string, syscall: string): void {
    if (!this.deny) return;
    let cur = normalizePath(path);
    for (;;) {
      if (this.deny(cur)) throw fsErr("EACCES", syscall, cur);
      if (cur === "/") return;
      cur = dirname(cur);
    }
  }

  private toStat(path: string, node: Node, asLink: boolean): FsStat {
    return {
      isFile: !asLink && node.kind === "file",
      isDirectory: !asLink && node.kind === "dir",
      isSymbolicLink: asLink,
      mode: node.mode,
      size: node.size,
      mtime: node.mtime,
      identity: `${this.workspace}:${path}`,
    };
  }

  private doc(fields: Omit<FileDoc, "workspace_id" | "updated_at">): FileDoc {
    return { ...fields, workspace_id: this.workspace, updated_at: new Date() };
  }

  private async insertOp(
    session: ClientSession,
    path: string,
    op: string,
    revFrom: number,
    revTo: number,
    bytesIn: number,
    bytesOut: number,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    await this.ops.insertOne({
      _id: randomUUID(),
      workspace_id: this.workspace,
      path,
      rev_from: revFrom,
      rev_to: revTo,
      op,
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      detail,
      created_at: new Date(),
    }, { session });
  }

  private async txn<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      const result = await session.withTransaction(() => fn(session));
      // Marks that a local commit may have landed after a concurrent sync's
      // snapshot was taken; syncPaths re-reads before trusting a missing doc.
      this.lastLocalCommitAt = new Date();
      return result;
    } finally {
      await session.endSession();
    }
  }
}
