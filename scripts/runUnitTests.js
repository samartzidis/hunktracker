// Cross-platform unit test runner: compile the test config, then run the
// compiled tests with Node's test runner.
// Replaces the former `rm -rf && tsc && mkdir -p && cp && node --test` one-liner,
// which only worked in POSIX shells.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'out-test');

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.rmSync(outDir, { recursive: true, force: true });

run([require.resolve('typescript/bin/tsc'), '-p', './tsconfig.test.json']);

const testDir = path.join(outDir, 'test');
const testFiles = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testDir, f));

run(['--test', ...testFiles]);
