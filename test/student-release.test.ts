import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise actual activation and setup handlers, with only the VS Code host boundary
// replaced. No server, provider, real profile or credentials are used.
for (const hostMode of [1, 2, 3]) for (const rememberedMode of [undefined, "simulator"]) {
  test(`student entry in host mode ${hostMode} requires a connection with remembered mode ${rememberedMode}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "guide-release-"));
    const disposable = { dispose() {} };
    const commands = new Map<string, (...args: any[]) => any>();
    const state = new Map<string, unknown>([["tutorMode", rememberedMode]]);
    const uri = (path: string): any => ({ fsPath: path, scheme: "file", toString: () => path });
    state.set("courseServiceUrl", "https://old.example.test");
    const prompts: any[] = [], secretReads: string[] = [], secretWrites: [string, string][] = [];
    let answer: string | undefined;
    let networkRequests = 0;
    t.mock.method(globalThis, "fetch", async () => { networkRequests++; throw new Error("Unexpected network request before consent"); });
    let provider: any, receive: any;
    const webview: any = { html: "", cspSource: "test:", asWebviewUri: (u: any) => u.toString(),
      onDidReceiveMessage: (handler: any) => { receive = handler; return disposable; } };
    const stub: any = {
      ExtensionMode: { Production: 1, Development: 2, Test: 3 },
      Uri: { file: uri, joinPath: (base: any, ...parts: string[]) => uri(join(base.fsPath, ...parts)) },
      commands: { registerCommand: (name: string, handler: any) => { commands.set(name, handler); return disposable; },
        executeCommand: async (name: string, ...args: any[]) => commands.get(name)?.(...args) },
      extensions: { getExtension: () => { throw new Error("Student startup must not discover or activate legacy extensions"); } },
      workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(join(root, "assignment")) }],
        registerTextDocumentContentProvider: () => disposable,
        getConfiguration: () => { throw new Error("Student connection must ignore endpoint settings"); } },
      window: { showInputBox: async (options: any) => { prompts.push(options); return answer; }, onDidChangeActiveTextEditor: () => disposable,
        registerWebviewViewProvider: (_: string, value: any) => { provider = value; return disposable; } },
    };
    const context: any = { extensionMode: hostMode, extensionUri: uri(root), globalStorageUri: uri(join(root, "global")),
      storageUri: uri(join(root, "workspace")), subscriptions: [],
      globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
      secrets: { get: async (key: string) => { secretReads.push(key); return undefined; },
        store: async (key: string, value: string) => { secretWrites.push([key, value]); } } };
    const Module = require("node:module");
    const originalLoad = Module._load;
    try {
      await mkdir(join(root, "assignment", ".git"), { recursive: true });
      await writeFile(join(root, "assignment", "assignment.json"), JSON.stringify({ schema_version: 1, assignment_id: "brand-new-java-course", assignment_version: "1" }));
      Module._load = function(id: string, ...args: any[]) { return id === "vscode" ? stub : originalLoad.call(this, id, ...args); };
      // Each activation must capture this test's host, including edit-review/preview imports.
      for (const id of Object.keys(require.cache)) if (/\/out\/src\//.test(id)) delete require.cache[id];
      const { activate } = require(process.env.ASSIGNMENT_GUIDE_STUDENT_ENTRY ?? "../src/student");
      Module._load = originalLoad;
      assert.equal(await activate(context), undefined, "No test API in an installed client");
      assert.equal(state.has("legacyIdentityImported"), false, "No migration marker is written");
      await provider.resolveWebviewView({ webview, onDidDispose: () => disposable });
      assert.match(webview.html, /Course service connection is incomplete/);
      assert.match(webview.html, /id="connect"/);
      assert.deepEqual(secretReads, ["courseServiceKey:https://comp1117.alanwd.com"], "Never read old-origin credentials");
      const connect = commands.get("assignmentTutorV2.connect")!;
      commands.set("assignmentTutorV2.open", async () => undefined);
      commands.set("assignmentTutorV2.restart", async () => undefined);
      await connect(); // Cancelled key entry.
      assert.equal(secretWrites.length, 0);
      assert.equal(state.get("courseServiceUrl"), "https://old.example.test");
      answer = "bad key"; await connect(); assert.equal(secretWrites.length, 0);
      answer = "synthetic-personal-key"; await connect();
      assert.deepEqual(secretWrites, [["courseServiceKey:https://comp1117.alanwd.com", answer]]);
      assert.equal(state.get("courseServiceUrl"), "https://comp1117.alanwd.com");
      assert.equal(prompts.length, 3, "Exactly one key prompt per connection attempt");
      for (const prompt of prompts) {
        assert.equal(prompt.password, true); assert.doesNotMatch(prompt.prompt, /https:|address/);
      }
      assert.equal(networkRequests, 0, "Key storage cannot authenticate or send coursework");
      let connects = 0;
      commands.set("assignmentTutorV2.connect", () => { connects++; });
      await receive({ type: "connect" });
      assert.equal(connects, 1, "Setup button invokes normal connection flow");
      for (const command of ["simulator", "previewClosed", "previewStudent", "importConnection"]) assert.equal(commands.has(`assignmentTutorV2.${command}`), false);
      assert.equal(state.get("tutorMode"), "remote", "Student connection always selects remote mode");
      assert.match(webview.html, /Course service connection is incomplete/);
      await assert.rejects(readdir(join(root, "workspace", "simulator-v1")), { code: "ENOENT" });
    } finally {
      Module._load = originalLoad;
      for (const item of context.subscriptions) item.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
