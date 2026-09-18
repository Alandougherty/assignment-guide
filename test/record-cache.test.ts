import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecordCache } from "../src/record-cache";

test("record cache reuses validation, detects corruption and replacement, and respects admission bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "record-cache-"));
  let validations = 0;
  const parse = (text: string) => { validations++; return JSON.parse(text); };
  const cache = new RecordCache(20, 1);
  const path = join(dir, "one.json");
  try {
    await writeFile(path, '{"n":1}');
    assert.deepEqual(await cache.read(path, parse), { n: 1 });
    await cache.read(path, parse); assert.equal(validations, 1);
    await writeFile(path, '{broken');
    await assert.rejects(cache.read(path, parse));
    await writeFile(join(dir, "replacement"), '{"n":2}');
    await rename(join(dir, "replacement"), path);
    assert.deepEqual(await cache.read(path, parse), { n: 2 });
    const other = join(dir, "two.json"); await writeFile(other, '{"n":3}');
    await cache.read(other, parse); await cache.read(other, parse);
    assert.equal(validations, 5);
    await cache.read(path, parse); assert.equal(validations, 5);
    await rm(path); await assert.rejects(cache.read(path, parse));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
