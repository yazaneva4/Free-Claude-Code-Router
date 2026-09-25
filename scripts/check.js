'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const roots = [
  path.join(__dirname, '..', 'src'),
  path.join(__dirname, '..', 'test'),
  path.join(__dirname),
];
let checked = 0;
const failures = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) check(full);
  }
}

function check(file) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(source, { filename: file });
    checked += 1;
  } catch (err) {
    failures.push({ file, message: err.message });
  }
}

for (const root of roots) {
  if (fs.existsSync(root)) walk(root);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure.file}: ${failure.message}`);
  console.error(`\n${failures.length} file(s) failed, ${checked} passed.`);
  process.exit(1);
}

console.log(`syntax ok: ${checked} files`);
