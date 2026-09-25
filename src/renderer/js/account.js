'use strict';

const api = window.gate;
const state = { boot: null, harnesses: [] };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const VIEWS = ['#view-auth', '#view-sync', '#view-harness', '#view-account'];
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
  document.title = step ? `Claude Code Router — Step ${step} of 3` : 'Claude Code Router — Account';
  if (selector === '#view-harness') renderHarnesses();
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
    badge.textContent = harness.billing === 'free' ? 'No payment' : 'Payment required';

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
    toggleText.textContent = 'Enable for this device';
    toggle.append(box, toggleText);

    card.append(head, note, toggle);

    if (harness.builtInModels.length) {
      const label = document.createElement('label');
      label.textContent = 'Built-in model';
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
      routed.textContent = 'No built-in models: requests are routed to the providers you configure.';
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

function encryptionNote() {
  return state.boot && state.boot.encryptionBackend === 'os-keychain'
    ? 'Secrets on this account are encrypted with the macOS keychain.'
    : 'Secrets on this account are encrypted with a key stored on this device only.';
}

function fillAccountView() {
  const account = state.boot.account;
  $('#account-email').textContent = account ? account.email : '';
  const form = $('#form-profile');
  form.displayName.value = (account && account.displayName) || '';
  form.storageMode.value = (account && account.storageMode) || 'device';
  form.syncEndpoint.value = (account && account.syncEndpoint) || '';
  $('#encryption-note').textContent = encryptionNote();
}

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
    toast(`The router did not open: ${result.reason}`, true);
    if (state.boot && state.boot.signedIn) {
      fillAccountView();
      showView('#view-account');
    } else {
      showView('#view-auth');
    }
    return;
  }
  toast('Signed in');
}

async function refresh(showHash) {
  state.boot = await api.auth.bootstrap();
  state.harnesses = state.boot.harnesses;
  if (!state.boot.signedIn) {
    showView('#view-auth');
    return;
  }
  if (showHash === 'account' || location.hash === '#account') {
    fillAccountView();
    showView('#view-account');
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
        ? 'Create an account to use your router. Guest access is not available.'
        : 'Sign in to open your router. Guest access is not available.';
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
      toast('Account created');
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

function wireAccount() {
  $('#btn-back-router').addEventListener('click', async () => {
    await openRouter();
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api.auth.logout();
    state.boot = await api.auth.bootstrap();
    showView('#view-auth');
    toast('Signed out');
  });

  $('#form-profile').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(form, '');
    try {
      const result = await api.account.updateProfile({
        displayName: form.displayName.value,
        storageMode: form.storageMode.value,
        syncEndpoint: form.syncEndpoint.value.trim(),
      });
      state.boot = { ...state.boot, account: result.account };
      fillAccountView();
      toast('Profile saved');
    } catch (err) {
      setError(form, err.message);
    }
  });

  $('#form-password').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setError(form, '');
    try {
      await api.account.changePassword({
        currentPassword: form.currentPassword.value,
        newPassword: form.newPassword.value,
      });
      form.reset();
      toast('Password replaced');
    } catch (err) {
      setError(form, err.message);
    }
  });

  $('#btn-delete-account').addEventListener('click', async () => {
    if (!confirm('Delete this account and its stored secrets on this device?')) return;
    try {
      await api.account.remove();
      state.boot = await api.auth.bootstrap();
      showView('#view-auth');
      toast('Account deleted');
    } catch (err) {
      toast(err.message, true);
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  wireAuth();
  wireSync();
  wireHarness();
  wireAccount();
  try {
    await refresh();
  } catch (err) {
    toast(err.message, true);
    showView('#view-auth');
  }
});
