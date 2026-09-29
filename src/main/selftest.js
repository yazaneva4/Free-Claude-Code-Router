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
    const isFree = (card) => card.querySelector('.badge').textContent === 'No payment';
    const models = (card) => Array.from(card.querySelectorAll('select[name=model] option')).map((option) => option.value);
    return {
      count: cards.length,
      names: cards.map((card) => card.querySelector('.provider-head div').textContent),
      free: cards.filter(isFree).map((card) => card.dataset.harness),
      paid: cards.filter((card) => !isFree(card)).map((card) => card.dataset.harness),
      paidWithPassword: cards.filter((card) => !isFree(card)).some((card) => card.querySelector('input[type=password]')),
      models: Object.fromEntries(cards.map((card) => [card.dataset.harness, models(card)])),
    };
  })()`);

  record(results, logFile, { name: 'every harness is listed', ok: harnessView.count === 5, detail: harnessView.names.join(', ') });
  record(results, logFile, {
    name: 'only Claude Code is flagged as needing a paid plan',
    ok: JSON.stringify(harnessView.paid) === JSON.stringify(['claude-code']),
    detail: harnessView.paid.join(', '),
  });
  record(results, logFile, {
    name: 'Claude, Codex and Gemini all run on the free plan',
    ok: JSON.stringify(harnessView.free) === JSON.stringify(['claude-app', 'codex-app', 'codex-cli', 'gemini-cli']),
    detail: harnessView.free.join(', '),
  });
  const otherModels = Object.entries(harnessView.models).filter(([id]) => id !== 'gemini-cli');
  record(results, logFile, {
    name: 'only Gemini offers built-in models, and Claude Code has none',
    ok: harnessView.models['gemini-cli'].length === 3 && otherModels.every(([, models]) => models.length === 0),
    detail: `gemini: ${harnessView.models['gemini-cli'].join(', ')} | claude-code: ${harnessView.models['claude-code'].join(', ') || 'none'}`,
  });
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

    await showAccountPage('#settings');
    const settingsView = await waitFor(win, `!document.querySelector('#view-settings').hidden`, 20000);
    const identity = await win.webContents.executeJavaScript(
      `(() => document.querySelector('#settings-account-email').textContent)()`,
      true
    );
    record(results, logFile, { name: 'the account menu opens settings in the same window', ok: settingsView, detail: settingsView ? '' : 'the settings view never appeared' });
    record(results, logFile, { name: 'settings shows the signed-in identity', ok: identity === ACCOUNT.email, detail: identity });

    // Everything the app can manage has to be reachable from settings, and the
    // back button has to be there to leave again.
    const layout = await win.webContents.executeJavaScript(`(() => {
      const tabs = Array.from(document.querySelectorAll('#settings-tabs .tab')).map((tab) => tab.dataset.tab);
      return {
        tabs,
        back: !!document.querySelector('#btn-settings-back'),
        account: !!document.querySelector('#form-profile'),
        language: !!document.querySelector('#language-select'),
      };
    })()`, true);
    for (const wanted of ['account', 'language', 'agents', 'gateway', 'providers', 'updates']) {
      record(results, logFile, {
        name: `settings has a ${wanted} tab`,
        ok: Boolean(layout && layout.tabs.includes(wanted)),
        detail: layout ? layout.tabs.join(', ') : 'no tabs',
      });
    }
    record(results, logFile, { name: 'settings has a back button', ok: Boolean(layout && layout.back), detail: '' });
    record(results, logFile, { name: 'the account form lives in settings', ok: Boolean(layout && layout.account), detail: '' });
    record(results, logFile, { name: 'settings offers a language picker', ok: Boolean(layout && layout.language), detail: '' });

    // The language picker has to offer every language and switch the page.
    const languages = await win.webContents.executeJavaScript(`(async () => {
      const select = document.querySelector('#language-select');
      const options = Array.from(select.options).map((option) => option.value);
      select.value = 'ar';
      select.dispatchEvent(new Event('change'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const dir = document.documentElement.dir;
      const lang = document.documentElement.lang;
      const back = document.querySelector('#btn-settings-back').textContent.replace(/\s+/g, ' ').trim();
      const tab = document.querySelector('#settings-tabs .tab[data-tab="language"]').textContent.trim();
      select.value = 'en';
      select.dispatchEvent(new Event('change'));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { count: options.length, options, dir, lang, back, tab, backEn: document.querySelector('#btn-settings-back').textContent.replace(/\s+/g, ' ').trim() };
    })()`, true);
    record(results, logFile, {
      name: 'the language picker offers every language',
      ok: Boolean(languages && languages.count >= 20),
      detail: languages ? `${languages.count} offered` : 'no options',
    });
    if (languages) console.log(`      languages: ${languages.options.join(' ')}`);
    record(results, logFile, { name: 'choosing a language repaints the page in it', ok: Boolean(languages && languages.back && languages.back !== languages.backEn), detail: languages ? `${languages.backEn} -> ${languages.back}` : '' });
    record(results, logFile, { name: 'a right to left language flips the layout', ok: Boolean(languages && languages.dir === 'rtl' && languages.lang === 'ar'), detail: languages ? `dir=${languages.dir} lang=${languages.lang}` : '' });

    // The update card has to say something true without ever offering a button
    // that cannot finish.
    const updates = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#settings-tabs .tab[data-tab="updates"]').click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      const summary = document.querySelector('#updates-summary');
      const install = document.querySelector('#btn-updates-install');
      const check = document.querySelector('#btn-updates-check');
      if (!summary || !install || !check) return { ok: false, reason: 'the update card is missing' };
      const state = await window.gate.updates.check(true).catch(() => null);
      return {
        ok: typeof summary.textContent === 'string' && summary.textContent.trim().length > 0,
        reason: 'the card never said anything',
        said: summary.textContent,
        installHidden: install.hidden,
        offline: !state || state.state === 'no-release' || state.state === 'check-failed',
      };
    })()`, true);
    record(results, logFile, { name: 'the update card reports the real version and offers nothing broken', ok: updates && updates.ok, detail: updates && !updates.ok ? updates.reason : '' });
    if (updates && updates.ok) {
      console.log(`      said: ${updates.said}`);
      record(results, logFile, {
        name: 'the install button only appears when a build can actually be installed',
        ok: updates.installHidden || !updates.offline,
        detail: updates.installHidden ? '' : 'it offered an install with nothing to install',
      });
    }

    // Agents are listed from settings, and one can be added and removed again.
    const agents = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#settings-tabs .tab[data-tab="agents"]').click();
      const pick = () => Array.from(document.querySelectorAll('#agent-list [data-agent]'));
      // Listing the agents also asks each one what models it offers, which
      // shells out to the real CLI a few times over, so the list is polled
      // rather than read after a fixed pause. The window is generous on purpose:
      // when this machine is busy a single probe can take several seconds, and a
      // test that fails on load stops telling anyone anything.
      const began = Date.now();
      while (Date.now() - began < 60000 && !pick().length) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      const cards = pick();
      if (!cards.length) return { ok: false, reason: 'no agents were listed' };
      const card = cards.find((node) => node.querySelector('[data-role=add]')) || cards[0];
      const id = card.dataset.agent;
      card.querySelector('[data-role=add], [data-role=remove]').click();
      const started = Date.now();
      let added = false;
      while (Date.now() - started < 8000) {
        const next = pick().find((node) => node.dataset.agent === id);
        const button = next && next.querySelector('[data-role=add], [data-role=remove]');
        if (button && button.dataset.role === 'remove') { added = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!added) return { ok: false, reason: 'the agent could not be added' };
      pick().find((node) => node.dataset.agent === id).querySelector('[data-role=remove]').click();
      const off = await new Promise((resolve) => {
        const begin = Date.now();
        const tick = () => {
          const node = pick().find((n) => n.dataset.agent === id);
          const button = node && node.querySelector('[data-role=add], [data-role=remove]');
          if (button && button.dataset.role === 'add') return resolve(true);
          if (Date.now() - begin > 8000) return resolve(false);
          setTimeout(tick, 200);
        };
        tick();
      });
      return { ok: off, reason: 'the agent could not be removed', id, count: cards.length };
    })()`, true);
    record(results, logFile, { name: 'settings lists the agents and one can be added and removed', ok: agents && agents.ok, detail: agents && !agents.ok ? `${agents.reason} (${agents.count || 0} listed)` : '' });

    // Removing a profile must not retire the agent: it has to be addable again.
    const readd = await win.webContents.executeJavaScript(`(async () => {
      const pick = () => Array.from(document.querySelectorAll('#agent-list [data-agent]'));
      const id = ${JSON.stringify(agents && agents.id ? agents.id : 'claude-code')};
      const card = () => pick().find((node) => node.dataset.agent === id);
      const waitFor = async (want) => {
        const begin = Date.now();
        for (;;) {
          const node = card();
          const button = node && node.querySelector('[data-role=add], [data-role=remove]');
          if (button && button.dataset.role === want) return true;
          if (Date.now() - begin > 15000) return false;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      };
      // Add it, take it away, then put it back the way a person would.
      if (await waitFor('add')) card().querySelector('[data-role=add]').click();
      if (!await waitFor('remove')) return { ok: false, reason: 'it could not be added the first time' };
      card().querySelector('[data-role=remove]').click();
      if (!await waitFor('add')) return { ok: false, reason: 'removing it did not bring the add button back' };
      card().querySelector('[data-role=add]').click();
      const back = await waitFor('remove');
      if (!back) return { ok: false, reason: 'it could not be added a second time' };
      card().querySelector('[data-role=remove]').click();
      return { ok: await waitFor('add'), reason: 'it could not be left clean', id };
    })()`, true);
    record(results, logFile, { name: 'an agent can be added again after being removed', ok: readd && readd.ok, detail: readd && !readd.ok ? `${readd.reason}` : '' });

    // The providers panel has to actually list the providers, DeepSeek included,
    // because a provider that is defined but never drawn is one you cannot use.
    const providers = await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('#settings-tabs .tab[data-tab="providers"]').click();
      const cards = () => Array.from(document.querySelectorAll('#provider-list [data-provider]'));
      const began = Date.now();
      while (Date.now() - began < 15000 && !cards().length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const listed = cards().map((card) => card.dataset.provider);
      return { listed, empty: document.querySelector('[data-panel="providers"]').innerText.replace(/\\s+/g, ' ').trim().slice(0, 120) };
    })()`, true);
    record(results, logFile, {
      name: 'the providers panel lists the providers',
      ok: Boolean(providers && providers.listed.length >= 8),
      detail: providers ? `${providers.listed.length} shown: ${providers.listed.join(', ')}` : 'nothing rendered',
    });
    record(results, logFile, {
      name: 'DeepSeek is offered as a provider',
      ok: Boolean(providers && providers.listed.includes('deepseek')),
      detail: providers && !providers.listed.includes('deepseek') ? `not in: ${providers.listed.join(', ')}` : '',
    });

    await showAccountPage('#settings');
    await waitFor(win, `!document.querySelector('#view-settings').hidden`, 20000);

    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#btn-settings-back').click();
      return true;
    })()`, true);
    const backToRouter = await waitFor(win, `location.href.includes('pages/home/index.html')`, 30000);
    record(results, logFile, { name: 'the settings back button returns to the router', ok: backToRouter, detail: backToRouter ? '' : 'router did not come back' });

    await showAccountPage('#settings');
    await waitFor(win, `!document.querySelector('#view-settings').hidden`, 20000);
    await lockApp();
    const lockedFromAccount = await waitFor(win, `!document.querySelector('#view-auth').hidden`, 20000);
    record(results, logFile, { name: 'locking from settings returns to sign in', ok: lockedFromAccount, detail: lockedFromAccount ? '' : 'sign-in page never appeared' });

    const signIn = async () => {
      await win.webContents.executeJavaScript(`(() => {
        const form = document.querySelector('#form-login');
        form.email.value = ${JSON.stringify(ACCOUNT.email)};
        form.password.value = ${JSON.stringify(ACCOUNT.password)};
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        return true;
      })()`, true);
      return waitFor(win, `location.href.includes('pages/home/index.html')`, 30000);
    };

    record(results, logFile, { name: 'signing in again reopens the router', ok: await signIn(), detail: '' });

    await showAccountPage('#settings');
    await waitFor(win, `!document.querySelector('#view-settings').hidden`, 20000);
    await win.webContents.executeJavaScript(`(() => {
      document.querySelector('#btn-logout').click();
      return true;
    })()`, true);
    const signedOutFromPage = await waitFor(win, `!document.querySelector('#view-auth').hidden`, 20000);
    record(results, logFile, { name: 'signing out from settings returns to sign in', ok: signedOutFromPage, detail: signedOutFromPage ? '' : 'sign-in page never appeared' });

    const afterLogout = await win.webContents.executeJavaScript(
      `(async () => (await window.gate.reveal()).reason)()`,
      true
    );
    record(results, logFile, {
      name: 'the router stays locked after signing out from the page',
      ok: afterLogout === 'signed_out',
      detail: afterLogout,
    });
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
