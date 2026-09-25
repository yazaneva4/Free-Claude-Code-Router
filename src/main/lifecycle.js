'use strict';

const CLOSE_TO_QUIT_WINDOW_MS = 2000;

function shouldBlockQuit(state = {}, now = Date.now()) {
  if (!state.authenticated) return false;
  if (state.quitting) return false;
  if (!state.windowClosedAt) return false;
  return now - state.windowClosedAt < CLOSE_TO_QUIT_WINDOW_MS;
}

module.exports = { shouldBlockQuit, CLOSE_TO_QUIT_WINDOW_MS };
