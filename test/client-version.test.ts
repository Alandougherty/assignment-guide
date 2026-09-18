import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_VERSION, CLIENT_USER_AGENT } from "../src/client-version";
test("course request version matches the release manifest", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
  assert.equal(CLIENT_VERSION, manifest.version);
  assert.equal(CLIENT_USER_AGENT, `AssignmentGuide/${manifest.version} (course-client)`);
});
