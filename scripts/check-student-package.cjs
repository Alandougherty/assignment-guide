const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const vsix = path.join(root, 'dist', `assignment-guide-${version}.vsix`);
const entries = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).trim().split('\n');
const pkg = JSON.parse(execFileSync('unzip', ['-p', vsix, 'extension/package.json'], { encoding: 'utf8' }));
assert.equal(pkg.main, './out/src/student.js');
assert.equal(pkg.version, version);
assert.equal(pkg.contributes.configuration, undefined, "Student settings must not select the credential recipient");
for (const c of pkg.contributes.commands) assert.ok(!/\.(simulator|previewClosed|previewStudent|importConnection)$/.test(c.command), c.command);
for (const entry of entries) {
  assert.ok(!/^extension\/out\/src\/(extension|extension-migration|migration-bridge|simulator|simulator-domain|tutor|sample-assignments|student-preview|local-hku)\.js$/.test(entry), entry);
  assert.ok(!/^extension\/(test|scripts|examples|src)\//.test(entry), entry);
  assert.ok(!/^extension\/media\/student-preview\./.test(entry), entry);
  assert.ok(!/^extension\/node_modules\/pg(?:\/|-)/.test(entry), entry);
  if (entry.startsWith('extension/out/src/service/')) assert.equal(entry, 'extension/out/src/service/protocol.js');
}
for (const required of ['out/src/student.js', 'out/src/extension-host.js',
  'node_modules/proper-lockfile/index.js', 'node_modules/graceful-fs/graceful-fs.js',
  'node_modules/retry/index.js', 'node_modules/signal-exit/index.js',
  'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'node_modules/markdown-it/LICENSE']) {
  assert.ok(entries.includes('extension/' + required), 'Missing runtime asset: ' + required);
}
console.log(`Student VSIX verified: ${version}, ${entries.length} entries, no development modules or commands.`);

if (pkg.license === "SEE LICENSE IN LICENSE") {
  assert.ok(entries.includes("extension/LICENSE.txt"), "Missing restricted-use licence");
  assert.ok(entries.includes("extension/PRIVACY.md"), "Missing privacy notice");
}

for (const entry of entries.filter(name => /^extension\/out\/src\/.*\.js$/.test(name))) {
  const text = execFileSync('unzip', ['-p', vsix, entry], { encoding: 'utf8' });
  assert.ok(!text.includes('simulated-student-001') && !text.includes('TEST_STUDENT') &&
    !text.includes('LEGACY_ID') && !text.includes('alandougherty.assignment-tutor-v2') && !text.includes('alandougherty.hku-assignment-guide'), 'Simulator identity leaked into ' + entry);
}
