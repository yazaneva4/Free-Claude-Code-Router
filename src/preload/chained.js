'use strict';

const PREFIX = '--ccr-router-preload=';

function routerPreloadPath() {
  const flag = process.argv.find((arg) => typeof arg === 'string' && arg.startsWith(PREFIX));
  return flag ? flag.slice(PREFIX.length) : null;
}

const routerPreload = routerPreloadPath();
if (routerPreload) {
  try {
    require(routerPreload);
  } catch (err) {
    process.stderr.write(`[gate] router preload failed to load: ${err && err.message ? err.message : err}\n`);
  }
}

require('./preload.js');
