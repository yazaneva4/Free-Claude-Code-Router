'use strict';

/**
 * Runs one suite and makes a failure say why.
 *
 * A step that exits non-zero with nothing on stdout looks the same in the
 * checks API whether it died in a require, was killed, or printed somewhere
 * that was not collected. So the exit code, the platform and the interesting
 * lines are turned into an annotation, which shows up next to the run and can
 * be read without opening the log.
 *
 *   node scripts/run-step.js test/run.js
 */

const { spawnSync } = require('node:child_process');

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/run-step.js <file>');
  process.exit(2);
}

const result = spawnSync(process.execPath, [file], { encoding: 'utf8' });
const output = `${result.stdout || ''}${result.stderr || ''}`;
if (output) process.stdout.write(output);

const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
const interesting = lines.filter((line) => /^(FAIL|CRASH)|Error:|error:/i.test(line));
const detail = (interesting.length ? interesting : lines.slice(-5)).slice(0, 8).join(' | ');

if (result.error) {
  console.error(`::error title=${file} could not be run on ${process.platform}::${result.error.message.replace(/[%\r\n]/g, ' ')}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`::error title=${file} was killed by ${result.signal} on ${process.platform}::${detail.replace(/[%\r\n]/g, ' ')}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(`::error title=${file} exited ${result.status} on ${process.platform} ${process.arch}::${detail.replace(/[%\r\n]/g, ' ')}`);
}

process.exit(result.status === null ? 1 : result.status);
