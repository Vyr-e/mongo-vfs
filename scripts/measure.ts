import { randomUUID } from "node:crypto";
import { MongoFs } from "../src/index.js";

const URI = process.env.VFS_MONGO_URI ?? "mongodb://127.0.0.1:27017";
const DB = process.env.VFS_MONGO_DB ?? "vfs";

function buildSource(minSize: number): { body: string; oldText: string; newText: string } {
  const oldText = 'const AgentSentinel = "edit-me-please"';
  const newText = 'const AgentSentinel = "edited-please!"';
  if (oldText.length !== newText.length) {
    throw new Error("sentinel replacement changed length");
  }
  let body = `package fixture\n\n${oldText}\n\n`;
  for (let i = 0; body.length < minSize; i++) {
    body += `func f${String(i).padStart(5, "0")}(n int) int {\n\t// stable helper keeps the corpus boring\n\tif n < 0 {\n\t\treturn 0\n\t}\n\treturn n + ${i % 97}\n}\n\n`;
  }
  if (body.split(oldText).length !== 2) throw new Error("sentinel not unique");
  return { body, oldText, newText };
}

function manifestDiff(before: string[], after: string[]): { rewritten: number; kept: number } {
  const n = Math.min(before.length, after.length);
  let rewritten = 0;
  let kept = 0;
  for (let i = 0; i < n; i++) {
    if (before[i] === after[i]) kept += 1;
    else rewritten += 1;
  }
  rewritten += Math.abs(before.length - after.length);
  return { rewritten, kept };
}

const fs = await MongoFs.open(URI, { db: DB, workspace: `measure-${randomUUID()}` });
try {
  const small = buildSource(50 * 1024);
  if (small.body.length > 64 * 1024) throw new Error(`fixture ${small.body.length} crossed 64KiB`);
  const edited = small.body.replace(small.oldText, small.newText);
  await fs.writeFile("/src/fixture.go", small.body);
  await fs.writeFile("/src/fixture.go", edited);
  const byWrite = Buffer.from(await fs.readFileBuffer("/src/fixture.go")).toString();

  await fs.writeFile("/src/other.go", small.body);
  await fs.searchReplace("/src/other.go", small.oldText, small.newText);
  const byReplace = Buffer.from(await fs.readFileBuffer("/src/other.go")).toString();
  if (byWrite !== edited || byReplace !== edited) throw new Error("writeFile and searchReplace diverged");

  const cas = buildSource(80 * 1024);
  if (Buffer.byteLength(cas.body) <= 64 * 1024) throw new Error("cas fixture is not over the inline limit");
  await fs.writeFile("/src/big.go", cas.body);
  const before = await fs.chunkHashes("/src/big.go");
  if (!before || before.length < 2) throw new Error("expected multiple cas chunks");
  await fs.searchReplace("/src/big.go", cas.oldText, cas.newText);
  const after = await fs.chunkHashes("/src/big.go");
  if (!after) throw new Error("cas file lost its manifest");
  const { rewritten, kept } = manifestDiff(before, after);

  const payloadFull = Buffer.byteLength(edited);
  const payloadReplace = Buffer.byteLength(small.oldText) + Buffer.byteLength(small.newText);
  const ratio = payloadFull / payloadReplace;
  console.log(`file_size=${Buffer.byteLength(small.body)}`);
  console.log(`write_full_payload_bytes=${payloadFull}`);
  console.log(`search_replace_payload_bytes=${payloadReplace}`);
  console.log(`ratio_write_full_over_search_replace=${ratio}`);
  console.log(`cas_file_size=${Buffer.byteLength(cas.body)}`);
  console.log(`cas_blobs_rewritten=${rewritten}`);
  console.log(`cas_blobs_kept=${kept}`);
} finally {
  await fs.destroy();
}
