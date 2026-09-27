'use strict';

const api = window.gate;
const state = { boot: null, harnesses: [] };

const t = (key, vars) => window.ccrI18n.t(key, vars);
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const VIEWS = ['#view-auth', '#view-sync', '#view-harness', '#view-settings'];
const STEP_VIEWS = { sync: '#view-sync', harnesses: '#view-harness' };
const STEP_NUMBERS = { '#view-auth': 1, '#view-sync': 2, '#view-harness': 3 };

function toast(message, isError) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('err', Boolean(isError));
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    node.hidden = true;
  }, 3200);
}

function setError(form, message) {
  const node = form.querySelector('[data-error]');
  if (!node) return;
  node.textContent = message || '';
  node.hidden = !message;
}

function showView(selector) {
  for (const view of VIEWS) $(view).hidden = view !== selector;
  const progress = $('#progress');
  const step = STEP_NUMBERS[selector];
  progress.hidden = !step;
  for (const marker of $$('[data-progress]')) {
    marker.classList.toggle('is-active', Number(marker.dataset.progress) === step);
  }
  document.body.classList.toggle('no-scroll', selector === '#view-auth');
  document.title = step ? `Claude Code Router — ${step}/3` : t('app.name');
  if (selector === '#view-harness') renderHarnesses();
  if (selector === '#view-settings') openSettings();
}

function renderHarnesses() {
  const list = $('#harness-list');
  list.textContent = '';
  for (const harness of state.harnesses) {
    const card = document.createElement('div');
    card.className = 'card harness';
    card.dataset.harness = harness.id;

    const head = document.createElement('div');
    head.className = 'provider-head';

    const title = document.createElement('div');
    title.textContent = harness.name;

    const badge = document.createElement('span');
    badge.className = `badge ${harness.billing === 'free' ? 'ok' : 'busy'}`;
    badge.textContent = t(harness.billing === 'free' ? 'harness.billing.free' : 'harness.billing.paid');

    head.append(title, badge);

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = `${harness.note} (${harness.billingLabel})`;

    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'enabled';
    box.checked = Boolean(harness.enabled);
    const toggleText = document.createElement('span');
    toggleText.textContent = t('harness.enable');
    toggle.append(box, toggleText);

    card.append(head, note, toggle);

    if (harness.builtInModels.length) {
      const label = document.createElement('label');
      label.textContent = t('harness.builtInModel');
      const select = document.createElement('select');
      select.name = 'model';
      for (const model of harness.builtInModels) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        if (harness.model === model) option.selected = true;
        select.append(option);
      }
      label.append(select);
      card.append(label);
    } else {
      const routed = document.createElement('p');
      routed.className = 'hint';
      routed.textContent = t('harness.noBuiltIn');
      card.append(routed);
    }

    list.append(card);
  }
}

function harnessSelections() {
  const selections = {};
  for (const card of $$('#harness-list .harness')) {
    const box = card.querySelector('input[name=enabled]');
    const select = card.querySelector('select[name=model]');
    selections[card.dataset.harness] = {
      enabled: Boolean(box && box.checked),
      model: select ? select.value : null,
    };
  }
  return selections;
}

async function openSettings(tab) {
  if (!window.ccrSettings) return;
  try {
    await window.ccrSettings.open(state.boot, tab);
  } catch (err) {
    toast(err.message, true);
  }
}

window.ccrGate = {
  onSignedOut() {
    state.boot = { signedIn: false };
    showView('#view-auth');
  },
};

async function afterAuth() {
  state.boot = await api.auth.bootstrap();
  state.harnesses = state.boot.harnesses;
  if (!state.boot.onboarding.complete) {
    showView(STEP_VIEWS[state.boot.onboarding.nextStep] || '#view-auth');
    return;
  }
  await openRouter();
}

async function openRouter() {
  const result = await api.reveal();
  if (!result.revealed) {
    toast(window.ccrI18n.t('toast.routerDidNotOpen', { reason: result.reason || '' }), true);
    if (state.boot && state.boot.signedIn) {
      showView('#view-settings');
    } else {
      showView('#view-auth');
    }
    return;
  }
  toast(window.ccrI18n.t('toast.signedIn'));
}

async function refresh(showHash) {
  state.boot = await api.auth.bootstrap();
  state.harnesses = state.boot.harnesses;
  if (!state.boot.signedIn) {
    showView('#view-auth');
    return;
  }
  if (showHash === 'settings' || location.hash === '#settings') {
    showView('#view-settings');
    return;
  }
  if (showHash === 'account' || location.hash === '#account') {
    showView('#view-settings');
    return;
  }
  if (!state.boot.onboarding.complete) {
    showView(STEP_VIEWS[state.boot.onboarding.nextStep] || '#view-auth');
    return;
  }
  await openRouter();
}

function wireAuth() {
  for (const tab of $$('[data-gate-tab]')) {
    tab.addEventListener('click', () => {
      for (const other of $$('[data-gate-tab]')) other.classList.toggle('is-active', other === tab);
      const signup = tab.dataset.gateTab === 'signup';
      $('#form-login').hidden = signup;
      $('#form-signup').hidden = !signup;
      $('#gate-subtitle').textContent = signup
        ? t('auth.subtitle.signup')
        : t('auth.subtitle.login');
    });
  }

  $('#form-login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(form, '');
    try {
      await api.auth.login({ email: form.email.value, password: form.password.value });
      await afterAuth();
    } catch (err) {
      setError(form, err.message);
    }
  });

  $('#form-signup').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(form, '');
    try {
      await api.auth.signup({
        displayName: form.displayName.value,
        email: form.email.value,
        password: form.password.value,
        storageMode: 'device',
      });
      toast(t('toast.accountCreated'));
      await afterAuth();
    } catch (err) {
      setError(form, err.message);
    }
  });
}

function wireSync() {
  const form = $('#form-sync');
  const endpointField = $('#sync-endpoint-field');
  for (const radio of $$('input[name=storageMode]', form)) {
    radio.addEventListener('change', () => {
      endpointField.hidden = form.storageMode.value !== 'synced';
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(form, '');
    try {
      await api.onboarding.saveSync({
        storageMode: form.storageMode.value,
        syncEndpoint: form.syncEndpoint.value.trim(),
      });
      state.boot = await api.auth.bootstrap();
      state.harnesses = state.boot.harnesses;
      showView(STEP_VIEWS[state.boot.onboarding.nextStep] || '#view-harness');
    } catch (err) {
      setError(form, err.message);
    }
  });
}

function wireHarness() {
  const form = $('#form-harness');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setError(form, '');
    try {
      await api.onboarding.saveHarnesses({ selections: harnessSelections() });
      state.boot = await api.auth.bootstrap();
      await openRouter();
    } catch (err) {
      setError(form, err.message);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  wireAuth();
  wireSync();
  wireHarness();
  // A stored language is applied before anything is painted, so the first frame
  // is already in the right language rather than flashing English.
  window.ccrI18n.apply(window.ccrI18n.detect());
  try {
    await refresh();
  } catch (err) {
    toast(err.message, true);
    showView('#view-auth');
  }
});
