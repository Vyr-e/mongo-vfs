// Runs under `bun test` only (vitest ignores *_test.ts): vitest workers run on
// Node, where the MongoDB driver does not touch the timers just-bash blocks.
import { randomUUID } from "node:crypto";
import { Bash } from "just-bash";
import { afterAll, expect, test } from "bun:test";
import { MongoFs, mongoBashDefense } from "../src/index.js";

const URI = process.env.VFS_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const DB = process.env.VFS_MONGO_DB ?? "vfs";
const open: MongoFs[] = [];

afterAll(async () => {
  for (const fs of open) await fs.destroy().catch(() => fs.close());
});

test("a cold read through Bash works on Bun with mongoBashDefense", async () => {
  const name = `t-${randomUUID()}`;
  const warm = await MongoFs.open(URI, { db: DB, workspace: name });
  await warm.writeFile("/src/main.py", "hi\n");
  await warm.close();

  const cold = await MongoFs.open(URI, { db: DB, workspace: name });
  open.push(cold);
  const result = await new Bash({ fs: cold, cwd: "/", defenseInDepth: mongoBashDefense }).exec("cat /src/main.py");
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("hi\n");
});
