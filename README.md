# @vyr-e/mongo-vfs

A just-bash `IFileSystem` backed by MongoDB, built for coding agents. Bash is how an agent explores; `searchReplace` and `applyPatch` are how it edits — sending only what changed instead of rewriting whole files, with every write in a transaction.

```bash
bun add @vyr-e/mongo-vfs
```

## Usage

```ts
import { Bash } from "just-bash";
import { MongoFs, mongoBashDefense } from "@vyr-e/mongo-vfs";

const fs = await MongoFs.open("mongodb://127.0.0.1:27017", {
  db: "vfs",
  workspace: "demo",
});
const bash = new Bash({ fs, cwd: "/", defenseInDepth: mongoBashDefense });
await bash.exec("echo 'hello' > /src/main.py");
await fs.searchReplace("/src/main.py", "hello", "goodbye"); // sends old + new, not the file
```

## Connecting

Pass a URI (with optional driver options), your own `MongoClient` or `Db` — or your app's mongo util, and the filesystem awaits it once at open:

```ts
MongoFs.open(getDb, { workspace: "demo" });                         // async () => Db — your util, as-is
MongoFs.open(() => client, { db: "vfs", workspace: "demo" });       // shared client, never closed by the fs
MongoFs.open(uri, { db, workspace, mongoOptions: { tls: true } });  // dedicated client + your driver config
```

A URI gets a dedicated client that `close()`/`destroy()` close; anything you supply (client, Db, or a factory returning one) is only used, never closed — your app owns the connection. Local URIs get `replicaSet=rs0` appended automatically; Atlas and other managed clusters pass through untouched.

## Shape

- Every write is a multi-document transaction; stale edits are a `conflict`, not a silent overwrite.
- Files over 64 KiB split into content-defined chunks, so an edit re-chunks only the region it touches and unchanged spans stay shared across files and workspaces.
- A `file_ops` change stream keeps other `MongoFs` instances current — another agent process, a sandbox writing results back. `watch: false` for single-process use.
- `deny: denySubtrees(["/.env"])` blocks paths inside the filesystem, after resolution — symlinks and shell quoting cannot route around it.
- `scripts/measure.ts` puts a number on the cheap write: a 76-byte `searchReplace` where bash redirection sends the whole 51 KB file.

## Development

```bash
bun install && bun run test
```

The suite expects a local single-node replica set (`VFS_MONGO_URI` to override): `docker run -d --name vfs-mongo -p 127.0.0.1:27017:27017 mongo:7 --replSet rs0`, then `rs.initiate()`.
