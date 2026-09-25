'use strict';

const fs = require('node:fs');

const ACCOUNT = { displayName: 'Selftest', email: 'selftest@example.com', password: 'selftestpass123' };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(results, logFile, entry) {
  const item = entry && typeof entry === 'object' ? entry : { name: String(entry), ok: Boolean(entry) };
  const result = { name: item.name, ok: Boolean(item.ok), detail: item.detail || '' };
  results.push(result);
  const line = result.ok ? `ok   ${result.name}` : `FAIL ${result.name}${result.detail ? ` (${result.detail})` : ''}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
  } catch {}
}

async function waitFor(win, expression, timeoutMs = 25000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await win.webContents.executeJavaScript(
        `(() => { try { return Boolean(${expression}); } catch (err) { return false; } })()`,
        true
      );
    } catch {
      last = null;
    }
    if (last) return last;
    await delay(150);
  }
  return last;
}

async function run(win, results, logFile) {
  record(results, logFile, {
    name: 'the account page opens in the router window when signed out',
    ok: await waitFor(win, `!document.querySelector('#view-auth').hidden`),
    detail: 'no #view-auth became visible',
  });

  const bridge = await win.webContents.executeJavaScript(`(() => ({
    hasGate: typeof window.gate === 'object' && window.gate !== null,
    hasRouterBridge: typeof window.ccr === 'object' && window.ccr !== null,
    nodeLeak: typeof window.require !== 'undefined' || typeof window.process !== 'undefined',
    onRouterPage: location.href.includes('app-original'),
    signedIn: null,
  }))()`);

  record(results, logFile, { name: 'the account bridge is exposed next to the router bridge', ok: bridge.hasGate && bridge.hasRouterBridge });
  record(results, logFile, { name: 'the renderer has no node access', ok: !bridge.nodeLeak });
  record(results, logFile, { name: 'the router page is not loaded while signed out', ok: !bridge.onRouterPage, detail: bridge.onRouterPage ? 'router page was loaded' : '' });

  const layout = await win.webContents.executeJavaScript(`(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    bodyScrollHeight: document.body.scrollHeight,
    locked: document.body.classList.contains('no-scroll'),
    loginNames: Array.from(document.querySelectorAll('#form-login input')).map((input) => input.name),
    signupNames: Array.from(document.querySelectorAll('#form-signup input')).map((input) => input.name),
  }))()`);

  record(results, logFile, {
    name: 'the sign-in page fits on screen with no scrolling',
    ok: layout.scrollHeight <= layout.innerHeight && layout.bodyScrollHeight <= layout.innerHeight && layout.locked,
    detail: `content ${layout.scrollHeight}px in a ${layout.innerHeight}px window`,
  });
  record(results, logFile, {
    name: 'sign in asks for an email and a password only',
    ok: JSON.stringify(layout.loginNames) === JSON.stringify(['email', 'password']),
    detail: layout.loginNames.join(','),
  });
  record(results, logFile, {
    name: 'create account asks for a name, an email and a password',
    ok: JSON.stringify(layout.signupNames) === JSON.stringify(['displayName', 'email', 'password']),
    detail: layout.signupNames.join(','),
  });

  const signedOut = await win.webContents.executeJavaScript(
    `(async () => (await window.gate.auth.bootstrap()).signedIn)()`,
    true
  );
  record(results, logFile, { name: 'bootstrap reports signed out', ok: signedOut === false });

  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('[data-gate-tab="signup"]').click();
    const form = document.querySelector('#form-signup');
    form.displayName.value = ${JSON.stringify(ACCOUNT.displayName)};
    form.email.value = ${JSON.stringify(ACCOUNT.email)};
    form.password.value = ${JSON.stringify(ACCOUNT.password)};
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`, true);

  const reachedSync = await waitFor(win, `!document.querySelector('#view-sync').hidden`);
  record(results, logFile, { name: 'creating an account moves to the sync question', ok: reachedSync, detail: reachedSync ? '' : 'sync step never appeared' });

  await win.webContents.executeJavaScript(`(() => {
    const form = document.querySelector('#form-sync');
    form.storageMode.value = 'device';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`, true);

  const reachedHarness = await waitFor(win, `!document.querySelector('#view-harness').hidden`);
  record(results, logFile, { name: 'answering sync moves to the harness step', ok: reachedHarness, detail: reachedHarness ? '' : 'harness step never appeared' });

  const harnessView = await win.webContents.executeJavaScript(`(() => {
    const cards = Array.from(document.querySelectorAll('#harness-list .harness'));
    return {
      count: cards.length,
      names: cards.map((card) => card.querySelector('.provider-head div').textContent),
      free: cards.filter((card) => card.querySelector('.badge').textContent === 'No payment').map((card) => card.dataset.harness),
      paid: cards.filter((card) => card.querySelector('.badge').textContent === 'Payment required').map((card) => card.dataset.harness),
      paidWithPassword: cards.filter((card) => card.querySelector('.badge').textContent === 'Payment required').some((card) => card.querySelector('input[type=password]')),
      freeWithModels: cards.filter((card) => card.querySelector('.badge').textContent === 'No payment').every((card) => card.querySelectorAll('select[name=model] option').length > 0),
      freeModels: cards.filter((card) => card.dataset.harness === 'gemini-cli').map((card) => Array.from(card.querySelectorAll('select[name=model] option')).map((o) => o.value)),
    };
  })()`);

  record(results, logFile, { name: 'every harness is listed', ok: harnessView.count === 5, detail: harnessView.names.join(', ') });
  record(results, logFile, { name: 'paid harnesses are flagged', ok: harnessView.paid.length === 4, detail: harnessView.paid.join(', ') });
  record(results, logFile, { name: 'the free harness keeps its built-in models', ok: harnessView.freeWithModels && harnessView.freeModels.flat().length === 3, detail: harnessView.freeModels.flat().join(', ') });
  record(results, logFile, { name: 'paid harnesses never ask for a login', ok: harnessView.paidWithPassword === false });

  await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.harness[data-harness="gemini-cli"]');
    card.querySelector('input[name=enabled]').checked = true;
    document.querySelector('#form-harness').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  })()`, true);

  const revealed = await waitFor(win, `location.href.includes('app-original') && location.href.includes('/renderer/')`, 30000);
  record(results, logFile, { name: 'finishing setup hands the same window to the router', ok: revealed, detail: revealed ? '' : 'router page never loaded' });

  const stillOneWindow = await win.webContents.executeJavaScript(`(() => ({ url: location.href }))()`, true);
  record(results, logFile, { name: 'the router page is the one now on screen', ok: stillOneWindow.url.includes('pages/home/index.html'), detail: stillOneWindow.url });

  const integrations = await win.webContents.executeJavaScript(
    `(async () => {
      const settings = await window.gate.settings.get();
      return {
        gemini: settings.integrations.cli.gemini,
        claude: settings.integrations.cli.claudeCode,
      };
    })()`,
    true
  );
  record(results, logFile, {
    name: 'the chosen harness is saved and pointed at the local gateway',
    ok: integrations.gemini.enabled === true && String(integrations.gemini.baseUrl).startsWith('http://127.0.0.1:'),
    detail: JSON.stringify(integrations.gemini),
  });
  record(results, logFile, {
    name: 'harnesses that were left off stay off',
    ok: integrations.claude.enabled === false,
    detail: JSON.stringify(integrations.claude),
  });

  return { revealed };
}

async function runSelfTest({ app, window: win, lockApp, showAccountPage, logFile }) {
  const results = [];
  const consoleErrors = [];
  const onConsole = (...args) => {
    const first = args[0] || {};
    const level = typeof first.level === 'number' ? first.level : Number(args[1]) || 0;
    const message = typeof first.message === 'string' ? first.message : String(args[2] || '');
    if (level >= 2) consoleErrors.push(message);
  };
  win.webContents.on('console-message', onConsole);

  try {
    await run(win, results, logFile);
    record(results, logFile, { name: 'the account page logged no console errors', ok: consoleErrors.length === 0, detail: consoleErrors.join(' | ') });

    await lockApp();
    const locked = await waitFor(win, `!document.querySelector('#view-auth').hidden`, 20000);
    const signedOutAgain = await win.webContents.executeJavaScript(
      `(async () => (await window.gate.auth.bootstrap()).signedIn)()`,
      true
    );
    record(results, logFile, { name: 'locking returns the window to the sign-in page', ok: locked, detail: locked ? '' : 'sign-in page never came back' });
    record(results, logFile, { name: 'locking really clears the session', ok: signedOutAgain === false });

    await win.webContents.executeJavaScript(`(() => {
      const form = document.querySelector('#form-login');
      form.email.value = ${JSON.stringify(ACCOUNT.email)};
      form.password.value = ${JSON.stringify(ACCOUNT.password)};
      form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      return true;
    })()`, true);

    const backAgain = await waitFor(win, `location.href.includes('pages/home/index.html')`, 30000);
    record(results, logFile, { name: 'signing back in skips setup and reopens the router', ok: backAgain, detail: backAgain ? '' : 'router did not come back' });

    await showAccountPage('#account');
    const accountView = await waitFor(win, `!document.querySelector('#view-account').hidden`, 20000);
    const identity = await win.webContents.executeJavaScript(
      `(() => document.querySelector('#account-email').textContent)()`,
      true
    );
    record(results, logFile, { name: 'the account menu opens account management in the same window', ok: accountView, detail: accountView ? '' : 'account view never appeared' });
    record(results, logFile, { name: 'account management shows the signed-in identity', ok: identity === ACCOUNT.email, detail: identity });

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#btn-back-router').click();
      return true;
    })()`, true);
    const backToRouter = await waitFor(win, `location.href.includes('pages/home/index.html')`, 30000);
    record(results, logFile, { name: 'going back returns the window to the router', ok: backToRouter, detail: backToRouter ? '' : 'router did not come back' });

    await showAccountPage('#account');
    await waitFor(win, `!document.querySelector('#view-account').hidden`, 20000);
    await lockApp();
    const lockedFromAccount = await waitFor(win, `!document.querySelector('#view-auth').hidden`, 20000);
    record(results, logFile, { name: 'locking from account management returns to sign in', ok: lockedFromAccount, detail: lockedFromAccount ? '' : 'sign-in page never appeared' });
  } catch (err) {
    record(results, logFile, { name: 'the self-test ran to completion', ok: false, detail: err && err.message ? err.message : String(err) });
  } finally {
    win.webContents.off('console-message', onConsole);
  }

  const failed = results.filter((r) => !r.ok).length;
  const summary = `\n${results.length - failed} passed, ${failed} failed\n`;
  process.stdout.write(summary);
  try {
    fs.appendFileSync(logFile, summary, { mode: 0o600 });
  } catch {}

  setTimeout(() => app.exit(failed ? 1 : 0), 250);
}

module.exports = { runSelfTest };
