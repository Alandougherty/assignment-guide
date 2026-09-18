// Build a fresh, explicit student staging tree. Never package the development root.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const stage = path.join(root, 'dist/student-extension');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const copied = new Set();
const forbidden = /(?:^|\/)(?:extension|extension-migration|migration-bridge|simulator|simulator-domain|tutor|sample-assignments|student-preview|local-hku)\.js$/;
function copy(file) {
  const target = path.join(stage, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
function visit(file) {
  if (copied.has(file)) return;
  if (forbidden.test(file)) throw Error('Development dependency in student build: ' + file);
  copied.add(file);
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function scan(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const arg = node.arguments[0];
      if (!arg || !ts.isStringLiteral(arg)) throw Error('Dynamic require needs explicit release review: ' + file);
      const name = arg.text;
      if (name.startsWith('.')) {
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), name + '.js'));
        if (!next.startsWith('out/src/')) throw Error('Dependency escapes client output: ' + next);
        if (next.startsWith('out/src/service/') && next !== 'out/src/service/protocol.js') throw Error('Server dependency: ' + next);
        visit(next);
      } else if (!name.startsWith('node:') && !['vscode', 'proper-lockfile'].includes(name)) throw Error('Unreviewed runtime dependency: ' + name);
    }
    ts.forEachChild(node, scan);
  }
  scan(ast);
  copy(file);
}
visit('out/src/student.js');
for (const file of ['chat.css', 'chat.js', 'setup.js', 'tutor.svg']) copy('media/' + file);
copy('README.md');
copy('docs/student-guide.md');
for (const file of ['LICENSE', 'PRIVACY.md']) if (fs.existsSync(path.join(root, file))) copy(file);
// Preserve complete dependency licence files. Only the Markdown browser asset is used.
for (const file of ['dist/browser/markdown-it.umd.min.js', 'LICENSE', 'package.json']) copy('node_modules/markdown-it/' + file);
const packages = new Set();
function dependency(name) {
  if (packages.has(name)) return;
  packages.add(name);
  const relative = 'node_modules/' + name;
  const source = path.join(root, relative);
  fs.cpSync(source, path.join(stage, relative), { recursive: true,
    filter: file => !/(?:^|\/)(?:test|tests|\.github|\.git)(?:\/|$)/.test(file) });
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json')));
  for (const child of Object.keys(pkg.dependencies || {})) dependency(child);
}
dependency('proper-lockfile');
dependency('markdown-it');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
pkg.main = './out/src/student.js';
const dev = new Set(['assignmentTutorV2.simulator', 'assignmentTutorV2.previewClosed', 'assignmentTutorV2.previewStudent', 'assignmentTutorV2.importConnection']);
pkg.contributes.commands = pkg.contributes.commands.filter(command => !dev.has(command.command));
delete pkg.contributes.menus;
delete pkg.contributes.configuration;
delete pkg.scripts;
delete pkg.devDependencies;
delete pkg.dependencies.pg;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.writeFileSync(path.join(stage, '.vscodeignore'), `**/*.map
node_modules/**/test/**
node_modules/**/tests/**
node_modules/markdown-it/**
!node_modules/markdown-it/dist/browser/markdown-it.umd.min.js
!node_modules/markdown-it/LICENSE
node_modules/argparse/**
node_modules/entities/**
node_modules/linkify-it/**
node_modules/mdurl/**
node_modules/punycode.js/**
node_modules/uc.micro/**
`);
const output = path.join(root, 'dist', `assignment-guide-${pkg.version}.vsix`);
execFileSync(process.execPath, [path.join(root, 'node_modules/@vscode/vsce/vsce'), 'package', '--githubBranch', 'main', ...(pkg.license === 'UNLICENSED' ? ['--skip-license'] : []), '--out', output], { cwd: stage, stdio: 'inherit' });
console.log(`Student build: ${copied.size} client modules; ${packages.size} Node dependency packages. ${output}`);

execFileSync(process.execPath, [path.join(root, "scripts/check-student-package.cjs")], { cwd: root, stdio: "inherit" });
