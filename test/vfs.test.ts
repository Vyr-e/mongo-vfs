import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { Bash } from "just-bash";
import { afterEach, describe, expect, it } from "vitest";
import { MongoFs, mongoBashDefense, VfsError, denySubtrees } from "../src/index.js";
import { withReplicaSet } from "../src/mongo-fs.js";

const URI = process.env.VFS_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const DB = process.env.VFS_MONGO_DB ?? "vfs";
const open: MongoFs[] = [];

async function workspace(): Promise<MongoFs> {
  const fs = await MongoFs.open(URI, { db: DB, workspace: `t-${randomUUID()}` });
  open.push(fs);
  return fs;
}

afterEach(async () => {
  while (open.length) {
    const fs = open.pop();
    if (fs) await fs.destroy();
  }
});

async function until(check: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met within timeout");
}

/** Deterministic high-entropy bytes, so distinct chunks hash distinctly. */
function varied(size: number, seed = 0x9e3779b9): Buffer {
  const body = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    body[i] = x & 0xff;
  }
  return body;
}

/**
 * Deterministic ASCII text for edit tests: searchReplace reads and writes UTF-8,
 * so random binary bytes would not survive the round trip. Hex lines give the
 * chunker enough entropy to cut at content-dependent points.
 */
function variedText(size: number, seed = 0x9e3779b9): Buffer {
  let x = seed >>> 0 || 1;
  const parts: string[] = [];
  let total = 0;
  let i = 0;
  while (total < size) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    const line = `line ${String(i).padStart(6, "0")} ${x.toString(16).padStart(8, "0")}\n`;
    parts.push(line);
    total += line.length;
    i += 1;
  }
  return Buffer.from(parts.join("").slice(0, size), "latin1");
}

/** Aligned differing positions plus any count mismatch: how much of the manifest changed. */
function differingCount(before: string[], after: string[]): number {
  const n = Math.min(before.length, after.length);
  let differing = 0;
  for (let i = 0; i < n; i++) {
    if (before[i] !== after[i]) differing += 1;
  }
  return differing + Math.abs(before.length - after.length);
}

function keptCount(before: string[], after: string[]): number {
  const pool = new Map<string, number>();
  for (const hash of before) pool.set(hash, (pool.get(hash) ?? 0) + 1);
  let kept = 0;
  for (const hash of after) {
    const n = pool.get(hash) ?? 0;
    if (n > 0) {
      kept += 1;
      pool.set(hash, n - 1);
    }
  }
  return kept;
}

describe("just-bash", () => {
  it("writes and reads through Bash, and ls does not fetch file bodies", async () => {
    const name = `t-${randomUUID()}`;
    const fs = await MongoFs.open(URI, { db: DB, workspace: name });
    open.push(fs);
    const bash = new Bash({ fs, cwd: "/", defenseInDepth: mongoBashDefense });
    const created = await bash.exec("echo hi > /src/main.py");
    expect(created.exitCode, created.stderr).toBe(0);

    const readsBefore = fs.contentFetches;
    const listed = await bash.exec("ls /src");
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("main.py");
    expect(fs.contentFetches).toBe(readsBefore);

    // writeFile already cached the body, so cat on this session does not hit Mongo.
    const shown = await bash.exec("cat /src/main.py");
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toBe("hi\n");
    expect(fs.contentFetches).toBe(readsBefore);

    // A new session loads the tree without bodies, then fetches the file once.
    const cold = await MongoFs.open(URI, { db: DB, workspace: name });
    open.push(cold);
    expect(cold.getAllPaths()).toContain("/src/main.py");
    expect(cold.contentFetches).toBe(0);
    const coldBash = new Bash({ fs: cold, cwd: "/", defenseInDepth: mongoBashDefense });
    const first = await coldBash.exec("cat /src/main.py");
    expect(first.stdout).toBe("hi\n");
    expect(cold.contentFetches).toBe(1);
    const again = await coldBash.exec("cat /src/main.py");
    expect(again.stdout).toBe("hi\n");
    expect(cold.contentFetches).toBe(1);
    const listedAgain = await coldBash.exec("ls /src");
    expect(listedAgain.stdout).toContain("main.py");
    expect(cold.contentFetches).toBe(1);
  });
});

describe("searchReplace", () => {
  it("replaces a unique match and rejects missing or repeated text", async () => {
    const fs = await workspace();
    await fs.writeFile("/src/main.txt", "alpha beta alpha\n");
    const rev = await fs.revision("/src/main.txt");

    const updated = await fs.searchReplace("/src/main.txt", "beta", "BETA");
    expect(updated.rev).toBe(rev + 1);
    expect(Buffer.from(await fs.readFileBuffer("/src/main.txt")).toString()).toBe("alpha BETA alpha\n");

    await expect(fs.searchReplace("/src/main.txt", "alpha", "X")).rejects.toThrow(/not_unique: \/src\/main.txt:/);
    await expect(fs.searchReplace("/src/main.txt", "nope", "X")).rejects.toThrow(/not_found: \/src\/main.txt:/);
    expect(Buffer.from(await fs.readFileBuffer("/src/main.txt")).toString()).toBe("alpha BETA alpha\n");
    expect(await fs.revision("/src/main.txt")).toBe(updated.rev);

    await fs.searchReplace("/src/main.txt", "alpha", "A", { replaceAll: true });
    expect(Buffer.from(await fs.readFileBuffer("/src/main.txt")).toString()).toBe("A BETA A\n");
    expect(Buffer.from(await fs.readExcerpt("/src/main.txt", 2, 4)).toString()).toBe("BETA");
  });

  it("treats $ patterns in the replacement literally", async () => {
    const fs = await workspace();
    await fs.writeFile("/sh.sh", "price=100 total=200\n");
    await fs.searchReplace("/sh.sh", "100", "$& and $$ and $' and $`");
    expect(await fs.readFile("/sh.sh")).toBe("price=$& and $$ and $' and $` total=200\n");
  });

  it("does not change content when ifRev is stale", async () => {
    const fs = await workspace();
    await fs.writeFile("/a.txt", "v1");
    await fs.writeFile("/a.txt", "v2");
    const before = Buffer.from(await fs.readFileBuffer("/a.txt")).toString();
    const rev = await fs.revision("/a.txt");
    await expect(fs.searchReplace("/a.txt", "v2", "v9", { ifRev: rev - 1 })).rejects.toBeInstanceOf(VfsError);
    await expect(fs.searchReplace("/a.txt", "v2", "v9", { ifRev: rev - 1 })).rejects.toThrow(/conflict: \/a.txt: ifRev/);
    expect(Buffer.from(await fs.readFileBuffer("/a.txt")).toString()).toBe(before);
    expect(await fs.revision("/a.txt")).toBe(rev);
  });
});

describe("applyPatch", () => {
  it("applies a strict diff and leaves the file unchanged on context mismatch", async () => {
    const fs = await workspace();
    await fs.writeFile("/f.txt", "alpha\nbeta\ngamma\n");
    const bad = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-WRONG",
      "+beta2",
      " gamma",
      "",
    ].join("\n");
    await expect(fs.applyPatch("/f.txt", bad)).rejects.toThrow(/context_mismatch: \/f.txt:/);
    expect(Buffer.from(await fs.readFileBuffer("/f.txt")).toString()).toBe("alpha\nbeta\ngamma\n");
    expect(await fs.revision("/f.txt")).toBe(1);

    const good = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+beta2",
      " gamma",
      "",
    ].join("\n");
    const applied = await fs.applyPatch("/f.txt", good);
    expect(applied.rev).toBe(2);
    expect(Buffer.from(await fs.readFileBuffer("/f.txt")).toString()).toBe("alpha\nbeta2\ngamma\n");
  });
});

describe("mv", () => {
  it("replaces an existing file target atomically and moves into an existing directory", async () => {
    const fs = await workspace();
    await fs.writeFile("/src.txt", "src");
    await fs.writeFile("/dst.txt", "dst");
    await fs.mv("/src.txt", "/dst.txt");
    expect(await fs.readFile("/dst.txt")).toBe("src");
    expect(await fs.exists("/src.txt")).toBe(false);

    // An existing directory target means move INTO it, like cp and POSIX mv.
    await fs.mkdir("/from");
    await fs.writeFile("/from/keep.txt", "keep");
    await fs.mkdir("/onto");
    await fs.writeFile("/onto/gone.txt", "gone");
    await fs.mv("/from", "/onto");
    expect(await fs.readFile("/onto/from/keep.txt")).toBe("keep");
    expect(await fs.readFile("/onto/gone.txt")).toBe("gone");
  });
});

describe("cas", () => {
  it("splits large files into content-defined chunks and keeps the chunks an edit does not touch", async () => {
    const fs = await workspace();
    const size = 80 * 1024;
    const body = variedText(size);
    const marker = Buffer.from("\nUNIQUE_LINE_MARKER\n");
    const repl = Buffer.from("\nUNIQUE_LINE_MARKEX\n");
    expect(marker.length).toBe(repl.length);
    const offset = 16 * 1024 + 100;
    marker.copy(body, offset);
    await fs.writeFile("/big.txt", body);
    const before = await fs.chunkHashes("/big.txt");
    expect(before!.length).toBeGreaterThanOrEqual(2);

    await fs.searchReplace("/big.txt", marker.toString(), repl.toString());
    const after = await fs.chunkHashes("/big.txt");
    // Same-length edit: only the chunk(s) containing the edit are rewritten;
    // the manifest otherwise survives, instead of every chunk after the edit.
    const differing = differingCount(before!, after!);
    expect(differing).toBeGreaterThanOrEqual(1);
    expect(differing).toBeLessThanOrEqual(3);

    const got = Buffer.from(await fs.readFileBuffer("/big.txt"));
    const want = Buffer.from(body);
    repl.copy(want, offset);
    expect(got.equals(want)).toBe(true);
    const cold = await MongoFs.open(URI, { db: DB, workspace: fs.workspaceId });
    open.push(cold);
    const coldGot = Buffer.from(await cold.readFileBuffer("/big.txt"));
    expect(coldGot.equals(want)).toBe(true);
    expect(cold.contentFetches).toBe(1);

    await fs.writeFile("/small.txt", "under-threshold");
    expect(await fs.chunkHashes("/small.txt")).toBeNull();
  });

  it("keeps almost every chunk when one byte is inserted near the start", async () => {
    const fs = await workspace();
    const body = variedText(80 * 1024);
    const marker = "INSERTION_ANCHOR_HERE";
    body.write(marker, 200, "latin1");
    await fs.writeFile("/ins.txt", body);
    const before = await fs.chunkHashes("/ins.txt");

    await fs.searchReplace("/ins.txt", marker, `${marker}!`);
    const after = await fs.chunkHashes("/ins.txt");
    // Fixed-size chunking would keep zero: one inserted byte shifts every
    // later boundary. Content-defined boundaries move with the content.
    expect(keptCount(before!, after!)).toBeGreaterThanOrEqual(before!.length - 2);
    expect(Buffer.from(await fs.readFileBuffer("/ins.txt")).length).toBe(body.length + 1);
  });

  it("keeps every chunk but the last when bytes are appended", async () => {
    const fs = await workspace();
    await fs.writeFile("/app.txt", varied(80 * 1024));
    const before = await fs.chunkHashes("/app.txt");
    await fs.appendFile("/app.txt", Buffer.alloc(2048, 0x42));
    const after = await fs.chunkHashes("/app.txt");
    expect(after!.slice(0, before!.length - 1)).toEqual(before!.slice(0, before!.length - 1));
  });

  it("shares chunks between identical files and deletes blobs with the last reference", async () => {
    const client = new MongoClient(URI);
    await client.connect();
    try {
      const blobs = client.db(DB).collection<{ _id: string; refs?: number }>("blobs");
      const fs = await workspace();
      const body = varied(80 * 1024);
      await fs.writeFile("/a.bin", body);
      await fs.writeFile("/b.bin", body);
      const hashes = [...new Set((await fs.chunkHashes("/a.bin"))!)];
      expect(await blobs.countDocuments({ _id: { $in: hashes } })).toBe(hashes.length);

      await fs.rm("/a.bin");
      expect(await blobs.countDocuments({ _id: { $in: hashes } })).toBe(hashes.length);

      await fs.rm("/b.bin");
      expect(await blobs.countDocuments({ _id: { $in: hashes } })).toBe(0);

      await fs.writeFile("/c.bin", varied(80 * 1024, 0x12345678));
      const first = [...new Set((await fs.chunkHashes("/c.bin"))!)];
      await fs.writeFile("/c.bin", varied(80 * 1024, 0x87654321));
      expect(await blobs.countDocuments({ _id: { $in: first } })).toBe(0);
      const second = [...new Set((await fs.chunkHashes("/c.bin"))!)];
      expect(await blobs.countDocuments({ _id: { $in: second } })).toBe(second.length);

      // destroy() releases the workspace's chunks too; blobs shared across
      // workspaces survive until their last reference is gone.
      const other = await MongoFs.open(URI, { db: DB, workspace: `t-${randomUUID()}` });
      await other.writeFile("/d.bin", varied(80 * 1024, 0xfeedbeef));
      const otherHashes = [...new Set((await other.chunkHashes("/d.bin"))!)];
      const sharedBody = varied(80 * 1024, 0x42424242);
      const yetAnother = await MongoFs.open(URI, { db: DB, workspace: `t-${randomUUID()}` });
      await yetAnother.writeFile("/e.bin", sharedBody);
      await other.destroy();
      expect(await blobs.countDocuments({ _id: { $in: otherHashes } })).toBe(0);
      const sharedHashes = [...new Set((await yetAnother.chunkHashes("/e.bin"))!)];
      await yetAnother.destroy();
      expect(await blobs.countDocuments({ _id: { $in: sharedHashes } })).toBe(0);
    } finally {
      await client.close();
    }
  });
});

describe("multiple instances", () => {
  it("picks up another instance's writes, invalidates its cache, and reports concurrent creates as VfsError", async () => {
    const name = `t-${randomUUID()}`;
    const a = await MongoFs.open(URI, { db: DB, workspace: name });
    const b = await MongoFs.open(URI, { db: DB, workspace: name });
    const stale = await MongoFs.open(URI, { db: DB, workspace: name, watch: false });
    open.push(a, b, stale);

    await a.writeFile("/note.txt", "v1");
    await until(async () => {
      try {
        return Buffer.from(await b.readFileBuffer("/note.txt")).toString() === "v1";
      } catch {
        return false;
      }
    });

    await a.writeFile("/note.txt", "v2");
    await until(async () => {
      try {
        return Buffer.from(await b.readFileBuffer("/note.txt")).toString() === "v2";
      } catch {
        return false;
      }
    });

    await a.writeFile("/made.txt", "new");
    await until(() => b.exists("/made.txt"));

    await a.rm("/note.txt");
    await until(async () => !(await b.exists("/note.txt")));

    // The stale instance never watched, so its tree does not know /race.txt
    // exists; the insert must surface as a VfsError, not a raw Mongo error.
    await a.writeFile("/race.txt", "a");
    await expect(stale.writeFile("/race.txt", "b")).rejects.toThrow(/EEXIST: \/race.txt:/);

    await stale.refresh();
    expect(await stale.exists("/race.txt")).toBe(true);
    expect(Buffer.from(await stale.readFileBuffer("/race.txt")).toString()).toBe("a");
  });
});

describe("deny guard", () => {
  it("blocks denied paths, including through symlinks, relative paths, and shell quoting", async () => {
    const plain = await workspace();
    await plain.writeFile("/.vault/key", "secret");
    await plain.writeFile("/.env", "SECRET=1");
    await plain.symlink("/.vault", "/escape");
    const fs = await MongoFs.open(URI, {
      db: DB,
      workspace: plain.workspaceId,
      deny: denySubtrees([".vault", "/.env"]),
    });
    open.push(fs);

    await expect(fs.readFile("/.vault/key")).rejects.toThrow(/EACCES: permission denied, open '\/\.vault'/);
    await expect(fs.readFile("/escape/key")).rejects.toThrow(/EACCES/);
    await expect(fs.readFile(".vault/key")).rejects.toThrow(/EACCES/);
    await expect(fs.readFile("/.env")).rejects.toThrow(/EACCES/);
    await expect(fs.writeFile("/.vault/new", "x")).rejects.toThrow(/EACCES/);
    await expect(fs.mkdir("/.vault/sub")).rejects.toThrow(/EACCES/);
    await expect(fs.stat("/.vault")).rejects.toThrow(/EACCES/);

    await fs.writeFile("/ok.txt", "fine");
    expect(await fs.readFile("/ok.txt")).toBe("fine");
    expect(await fs.readdir("/")).toContain("ok.txt");

    const bash = new Bash({ fs, cwd: "/", defenseInDepth: mongoBashDefense });
    const quoted = await bash.exec('cat "/.va""ult/key"');
    expect(quoted.exitCode, quoted.stderr).not.toBe(0);
    const globbed = await bash.exec("cat /.v*/*");
    expect(globbed.exitCode, globbed.stderr).not.toBe(0);
    const redirected = await bash.exec("echo pwned > /.env");
    expect(redirected.exitCode, redirected.stderr).not.toBe(0);
    const allowed = await bash.exec("cat /ok.txt");
    expect(allowed.exitCode, allowed.stderr).toBe(0);
    expect(allowed.stdout).toBe("fine");
  });
});

describe("open with an existing connection", () => {
  it("runs on a caller-owned MongoClient or Db and leaves the connection open on close", async () => {
    const client = new MongoClient(URI);
    await client.connect();
    // Self-cleaning: afterEach's destroy() must not outlive the shared client.
    try {
      const ws = `t-${randomUUID()}`;
      const fs = await MongoFs.open(client, { db: DB, workspace: ws });
      await fs.writeFile("/x.txt", "hi");
      expect(await fs.readFile("/x.txt")).toBe("hi");

      const sameDb = await MongoFs.open(client.db(DB), { db: DB, workspace: ws });
      expect(await sameDb.readFile("/x.txt")).toBe("hi");
      expect(sameDb.workspaceId).toBe(ws);

      // destroy() wipes the workspace but leaves the borrowed client usable.
      await fs.destroy();
      expect(await client.db(DB).collection("files").countDocuments({ workspace_id: ws })).toBe(0);

      // close() on a borrowed connection does not close the client either.
      await sameDb.close();
      await client.db(DB).command({ ping: 1 });
    } finally {
      await client.close();
    }
  });
});

describe("open with mongoOptions", () => {
  it("passes driver options through when connecting by URI, and an explicit replicaSet in options skips the rs0 append", async () => {
    const fs = await MongoFs.open(URI, {
      db: DB,
      workspace: `t-${randomUUID()}`,
      // replicaSet via options also exercises the suppression branch: the URI
      // is used verbatim instead of getting replicaSet=rs0 appended.
      mongoOptions: { appName: "mongo-vfs-test", replicaSet: "rs0" },
    });
    open.push(fs);
    await fs.writeFile("/x.txt", "options config");
    expect(await fs.readFile("/x.txt")).toBe("options config");
  });
});

describe("open with a connection factory", () => {
  it("awaits the app's mongo util once and borrows what it returns", async () => {
    const client = new MongoClient(URI);
    await client.connect();
    let calls = 0;
    try {
      const getDb = async () => {
        calls += 1;
        return client.db(DB);
      };
      const fs = await MongoFs.open(getDb, { db: DB, workspace: `t-${randomUUID()}` });
      await fs.writeFile("/factory.txt", "from a util");
      expect(await fs.readFile("/factory.txt")).toBe("from a util");
      expect(calls).toBe(1);

      // Sync factories returning a client work too, and the client stays open.
      const fromClient = await MongoFs.open(() => client, { db: DB, workspace: fs.workspaceId });
      expect(await fromClient.readFile("/factory.txt")).toBe("from a util");
      // Self-cleaning: destroy here, before the finally closes the shared client.
      await fromClient.close();
      await fs.destroy();
      await client.db(DB).command({ ping: 1 });
    } finally {
      await client.close();
    }
  });
});

describe("withReplicaSet", () => {
  it("adds rs0 only when every host in the URI is local", () => {
    expect(withReplicaSet("mongodb://127.0.0.1:27017")).toBe("mongodb://127.0.0.1:27017?replicaSet=rs0");
    expect(withReplicaSet("mongodb://localhost:27017,localhost:27018/?w=1")).toBe(
      "mongodb://localhost:27017,localhost:27018/?w=1&replicaSet=rs0",
    );
    expect(withReplicaSet("mongodb://user:pass@localhost:27017/vfs?authSource=admin")).toBe(
      "mongodb://user:pass@localhost:27017/vfs?authSource=admin&replicaSet=rs0",
    );
    expect(withReplicaSet("mongodb://[::1]:27017")).toBe("mongodb://[::1]:27017?replicaSet=rs0");
    expect(withReplicaSet("mongodb://localhost:27017?replicaSet=rs1")).toBe("mongodb://localhost:27017?replicaSet=rs1");
    expect(withReplicaSet("mongodb+srv://cluster0.abcd.mongodb.net")).toBe("mongodb+srv://cluster0.abcd.mongodb.net");
    expect(withReplicaSet("mongodb://cluster0-shard-00-00.abcd.mongodb.net:27017")).toBe(
      "mongodb://cluster0-shard-00-00.abcd.mongodb.net:27017",
    );
    expect(withReplicaSet("mongodb://localhost:27017,remote.example.com:27017")).toBe(
      "mongodb://localhost:27017,remote.example.com:27017",
    );
  });
});
