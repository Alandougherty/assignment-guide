import { test, mock } from "node:test";
import fs = require("node:fs/promises");
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, link, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureWorkspace, eligibleWorkspacePath, validateWorkspace } from "../src/workspace";
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tutor-workspace-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("workspace captures eligible source and brief files with immutable unsaved buffers", async () => {
  await fixture(async root => {
    await mkdir(join(root, "src")); await writeFile(join(root, "src", "main.py"), "old"); await writeFile(join(root, "ASSIGNMENT.md"), "Brief");
    const buffer = { filename: join(root, "src", "main.py"), text: "unsaved", documentVersion: 7, language: "python" };
    const pending = captureWorkspace(root, [buffer, { ...buffer, filename: join(root, "missing.py") }]); buffer.text = "changed after Send";
    const context = await pending;
    assert.deepEqual(context.files.map(file => file.path), ["ASSIGNMENT.md", "src/main.py"]);
    assert.deepEqual(context.files[1], { path: "src/main.py", text: "unsaved", documentVersion: 7, language: "python" });
    validateWorkspace(context);
  });
});

test("workspace excludes credentials, policy files, dependencies, hidden files and symbolic links", async () => {
  await fixture(async root => {
    const excluded = ["tutor-chat-primes.md", "TUTOR-CHAT-other.MD", "assignment.json", "pilot.json", "pilot-connection.json", "proxy-environment.json", "tutor-preferences.json", "TUTOR.md", "AGENTS.md", "CLAUDE.md", "secret.json", "credentials.py", "api-key.txt", "keys.json", "my_key.json", "access_token.json", "package-lock.json", ".hidden.py", "image.png"];
    for (const name of excluded) await writeFile(join(root, name), "do-not-capture");
    for (const dir of ["node_modules", "dist", ".git", "venv", "secrets"]) { await mkdir(join(root, dir)); await writeFile(join(root, dir, "main.py"), "do-not-capture"); }
    await writeFile(join(root, "main.py"), "keep");
    await symlink(join(root, "main.py"), join(root, "link.py")); await symlink(tmpdir(), join(root, "linked-folder"));
    const result = await captureWorkspace(root);
    assert.deepEqual(result.files.map(file => file.path), ["main.py"]); assert.ok(!JSON.stringify(result).includes("do-not-capture"));
  });
  for (const path of ["../main.py", "/main.py", "a/../main.py", "a\\main.py", "a/.private/main.py", "a/secret.json", "x/TUTOR.md", "x/node_modules/main.js", "main.pem", "py"]) assert.equal(eligibleWorkspacePath(path), false, path);
});

test("workspace refuses oversized, binary and invalid UTF-8 eligible files without truncation", async () => {
  await fixture(async root => {
    for (const value of ["é".repeat(4001), Buffer.from([0, 1]), Buffer.from([0xff])]) {
      await writeFile(join(root, "work.txt"), value); await assert.rejects(captureWorkspace(root));
    }
    await writeFile(join(root, "work.txt"), "x".repeat(6000)); await writeFile(join(root, "other.txt"), "y".repeat(6000));
    await assert.rejects(captureWorkspace(root), /12,000-byte/);
  });
});

test("workspace wire validator rejects extra fields, duplicate paths, unsafe files and byte overflow", () => {
  const file = { path: "main.py", language: "python", text: "print(1)", documentVersion: 1 };
  validateWorkspace({ files: [] }); validateWorkspace({ files: [file] });
  for (const value of [{ files: [file], extra: true }, { files: [{ ...file, extra: true }] }, { files: [file, file] }, { files: [{ ...file, path: "secret.py" }] }, { files: [{ ...file, documentVersion: 0 }] }, { files: [{ ...file, text: "x".repeat(8001) }] }, { files: Array.from({ length: 41 }, (_, i) => ({ ...file, path: `file${i}.py` })) }]) assert.throws(() => validateWorkspace(value));
  const exact = { files: [{ ...file, text: "" }, { ...file, path: "other.py", text: "" }] };
  const remaining = 12000 - Buffer.byteLength(JSON.stringify(exact)); exact.files[0]!.text = "x".repeat(6000); exact.files[1]!.text = "y".repeat(remaining - 6000);
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), 12000); validateWorkspace(exact); exact.files[1]!.text += "é"; assert.throws(() => validateWorkspace(exact));
});

test("workspace enumeration and eligible file counts are bounded", async () => {
  await fixture(async root => {
    await Promise.all(Array.from({ length: 41 }, (_, i) => writeFile(join(root, `file${i}.py`), "")));
    await assert.rejects(captureWorkspace(root), /40 eligible/);
  });
  await fixture(async root => {
    await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(join(root, `ignored${i}.bin`), "")));
    await assert.rejects(captureWorkspace(root), /2,000 entries/);
  });
});


test("workspace refuses hard-linked eligible files", async () => {
  await fixture(async root => {
    await writeFile(join(root, "outside.txt"), "private");
    await mkdir(join(root, "student")); await link(join(root, "outside.txt"), join(root, "student", "work.txt"));
    await assert.rejects(captureWorkspace(join(root, "student")), /file changed/);
  });
});


test("workspace detects a disk edit during file reading", async () => {
  await fixture(async root => {
    const filename = join(root, "work.py"); await writeFile(filename, "original");
    const originalOpen = fs.open; let changed = false;
    const intercept = mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      const originalRead = handle.read.bind(handle);
      Object.defineProperty(handle, "read", { value: async (...readArgs: any[]) => {
        const result = await (originalRead as any)(...readArgs);
        if (!changed) { changed = true; await writeFile(filename, "changed with another length"); }
        return result;
      } });
      return handle;
    });
    try { await assert.rejects(captureWorkspace(root), /file changed while capturing/); }
    finally { intercept.mock.restore(); }
  });
});


test("workspace coalesces identical editor aliases and rejects conflicting unsaved contents", async () => {
  await fixture(async root => {
    await mkdir(join(root, "student")); await writeFile(join(root, "student", "work.py"), "disk");
    await symlink(join(root, "student"), join(root, "alias"));
    const canonical = await realpath(join(root, "student"));
    const first = { filename: join(canonical, "work.py"), text: "unsaved", language: "python", documentVersion: 2 };
    const second = { ...first, filename: join(root, "alias", "work.py"), documentVersion: 7 };
    const result = await captureWorkspace(canonical, [first, second]);
    assert.deepEqual(result.files, [{ path: "work.py", text: "unsaved", language: "python", documentVersion: 7 }]);
    await assert.rejects(captureWorkspace(canonical, [first, { ...second, text: "different unsaved text" }]), /Close the duplicate tabs/);
    await assert.rejects(captureWorkspace(canonical, [first, { ...second, language: "plaintext" }]), /Close the duplicate tabs/);
  });
});
