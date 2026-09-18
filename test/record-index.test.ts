import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordCache } from "../src/record-cache";
import { RecordIndex } from "../src/record-index";

test("summary index avoids revalidation beyond payload cache and detects changed old revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "record-index-"));
  let validations = 0;
  const cache = new RecordCache<{ n: number }>(1, 1); // No payload fits.
  const index = new RecordIndex(path => cache.read(path, text => { validations++; return JSON.parse(text); }), value => value.n, 2);
  const paths = [0, 1, 2].map(n => join(directory, `${n}.json`));
  try {
    for (let n = 0; n < 3; n++) await writeFile(paths[n]!, JSON.stringify({ n }));
    for (let n = 0; n < 3; n++) assert.equal(await index.inspect(paths[n]!), n);
    assert.equal(validations, 3);
    for (let n = 0; n < 3; n++) await index.inspect(paths[n]!);
    assert.equal(validations, 4); // Third metadata entry exceeds the bound, so it is reread.
    await writeFile(paths[0]!, '{broken');
    await assert.rejects(index.inspect(paths[0]!));
    await writeFile(paths[0]!, '{"n":9}'); assert.equal(await index.inspect(paths[0]!), 9);
    await rm(paths[0]!); await assert.rejects(index.inspect(paths[0]!));
    index.retain(new Set([paths[1]!, paths[2]!]));
    await index.inspect(paths[2]!); const count = validations;
    await index.inspect(paths[2]!); assert.equal(validations, count);
    const link = join(directory, 'link.json'); await symlink(paths[1]!, link);
    await assert.rejects(index.inspect(link), /regular file/);
    await assert.rejects(cache.read(link, JSON.parse));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
