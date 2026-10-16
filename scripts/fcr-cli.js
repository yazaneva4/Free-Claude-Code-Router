#!/usr/bin/env node
'use strict';
const { launch: run } = require('../src/main/routed-launcher');
function launch(args = process.argv.slice(2), options = {}) {
  try { return run(args[0], args.slice(1), options); }
  catch (err) { console.error(err.message); return 1; }
}
if (require.main === module) process.exitCode = launch();
module.exports = { launch };
