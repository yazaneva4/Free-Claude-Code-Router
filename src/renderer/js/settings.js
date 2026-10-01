'use strict';

/**
 * The settings surface: account, language, agents, gateway, providers and
 * updates, all behind one back button.
 *
 * Wrapped in its own scope because this page is loaded as a classic script
 * alongside account.js, and two top level `const api` declarations in the same
 * global scope is a parse error rather than a shadow.
 */
(() => {
  const api = window.gate;
  const i18n = window.ccrI18n;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const t = (key, vars) => i18n.t(key, vars);

  const state = {
    account: null,
    agents: [],
    gateway: null,
    providers: { local: [], cloud: [] },
    updates: null,
    secretSync: null,
    tab: 'account',
  };

  let bound = false;

  function toast(message, isError) {
    const node = $('#toast');
    if (!node) return;
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

  /* ------------------------------------------------------------------ tabs */

  function showTab(name) {
    const known = ['account', 'language', 'agents', 'gateway', 'providers', 'updates'];
    state.tab = known.includes(name) ? name : 'account';
    for (const panel of $$('#view-settings [data-panel]')) {
      panel.hidden = panel.dataset.panel !== state.tab;
    }
    for (const tab of $$('#settings-tabs .tab')) {
      tab.classList.toggle('is-active', tab.dataset.tab === state.tab);
    }
    document.title = `${t('app.settings')} — Claude Code Router`;
    if (state.tab === 'agents') loadAgents();
    if (state.tab === 'gateway') loadGateway();
    if (state.tab === 'providers') loadProviders();
    if (state.tab === 'updates') renderUpdates(state.updates);
  }

  /* --------------------------------------------------------------- account */

  function encryptionNote() {
    const account = state.account;
    if (!account) return '';
    if (account.storageMode === 'synced' && account.syncEndpoint) {
      return t('account.encryptionShared', { email: account.email });
    }
    return window.ccrSettingsEncryption === 'os-keychain'
      ? t('account.encryptionKeychain')
      : t('account.encryptionDevice');
  }

  function renderSecretSync(result) {
    const node = $('#settings-secret-state');
    if (!node) return;
    if (!result) {
      node.textContent = '';
      return;
    }
    if (!result.ok) {
      node.textContent = result.error || '';
      return;
    }
    if (result.shared !== undefined) node.textContent = t('account.secretSyncShared', { count: result.shared, time: new Date(result.at).toLocaleTimeString() });
    else if (result.nothingSaved) node.textContent = t('account.secretSyncEmpty');
    else node.textContent = t('account.secretSyncTaken', { count: result.imported, time: new Date(result.at).toLocaleTimeString() });
  }

  function fillAccount() {
    const account = state.account;
    if (!account) return;
    $('#settings-email').textContent = account.email;
    $('#settings-account-email').textContent = account.email;
    const form = $('#form-profile');
    form.displayName.value = account.displayName || '';
    form.storageMode.value = account.storageMode || 'device';
    form.syncEndpoint.value = account.syncEndpoint || '';
    $('#encryption-note').textContent = encryptionNote();
    renderSecretSync(state.secretSync);
  }

  async function saveAccount() {
    const form = $('#form-profile');
    try {
      const result = await api.account.updateProfile({
        displayName: form.displayName.value,
        storageMode: form.storageMode.value,
        syncEndpoint: form.syncEndpoint.value.trim() || null,
      });
      state.account = result.account;
      fillAccount();
      toast(t('account.toast.profileSaved'));
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* -------------------------------------------------------------- language */

  function fillLanguages() {
    const select = $('#language-select');
    if (!select) return;
    select.textContent = '';
    for (const option of i18n.localeOptions()) {
      const node = document.createElement('option');
      node.value = option.code;
      node.textContent = option.label;
      node.selected = option.selected;
      select.append(node);
    }
  }

  function setLanguage(code) {
    const applied = i18n.apply(code);
    fillLanguages();
    showTab(state.tab);
    // The whole page was painted by apply(), but anything built from state
    // afterwards has to be rebuilt in the new language.
    fillAccount();
    if (state.tab === 'agents') loadAgents();
    if (state.tab === 'gateway') loadGateway();
    if (state.tab === 'providers') loadProviders();
    renderUpdates(state.updates);
    return applied;
  }

  /* ---------------------------------------------------------------- agents */

  function agentStateLabel(agent) {
    if (agent.added) return t('agents.state.added');
    return agent.installed ? t('agents.state.installed') : t('agents.state.missing');
  }

  /**
   * Says where an agent's own models come from, which is decided by what it
   * costs: a free agent already has them, a paid one gets them with the plan.
   */
  function agentSourceLabel(agent) {
    if (agent.ownModels && agent.ownModels.length) {
      if (agent.subscription) return t('agents.sourceSubscription');
      return agent.ownModelsBilled ? t('agents.sourceOwnBilled') : t('agents.sourceFree');
    }
    if (agent.ownModelsWaiting) return t('agents.sourceNeedsPlan');
    if (agent.subscription) return t('agents.sourceSubscription');
    if (agent.installed && !agent.added && agent.authMethod === null) return t('agents.needLogin');
    return t('agents.sourceRouted');
  }

  /** Sign-in is worth offering when the agent is installed and has no subscription. */
  function needsSignIn(agent) {
    if (agent.kind !== 'cli' || !agent.installed) return false;
    return !agent.subscription;
  }

  async function loadAgents() {
    const list = $('#agent-list');
    if (!list) return;
    list.textContent = '';
    let result;
    try {
      result = await api.agents.list();
    } catch (err) {
      toast(err.message, true);
      return;
    }
    state.agents = result.agents || [];
    $('#agent-empty').hidden = state.agents.length > 0;

    for (const agent of state.agents) {
      const card = document.createElement('div');
      card.className = 'card agent';
      card.dataset.agent = agent.id;

      const head = document.createElement('div');
      head.className = 'provider-head';
      const name = document.createElement('div');
      name.textContent = agent.name;
      const badge = document.createElement('span');
      badge.className = `badge ${agent.added ? 'ok' : ''}`;
      badge.textContent = agentStateLabel(agent);
      head.append(name, badge);

      const source = document.createElement('p');
      source.className = 'hint';
      source.textContent = agentSourceLabel(agent);
      card.append(head, source);

      if (!agent.added) {
        const notYet = document.createElement('p');
        notYet.className = 'hint';
        notYet.dataset.role = 'not-added';
        notYet.textContent = t('agents.notInProfiles');
        card.append(notYet);
      }

      const own = agent.ownModels || [];
      const gatewayModels = agent.gatewayModels || [];
      const choices = own.length ? own : gatewayModels;

      // A model belongs to a profile. An agent you have not added has no
      // profile, so offering the shared gateway list in a dropdown made every
      // card look configured and made Claude Code look the same as anything
      // else. Nothing to choose until it is added.
      if (choices.length && agent.added) {
        const label = document.createElement('label');
        const caption = document.createElement('span');
        caption.textContent = own.length ? t('agents.ownModels') : t('agents.gatewayModels');
        const select = document.createElement('select');
        select.dataset.role = 'model';
        for (const model of choices) {
          const option = document.createElement('option');
          option.value = model;
          option.textContent = model;
          if (agent.model === model) option.selected = true;
          select.append(option);
        }
        // Choosing a model saves it there and then. Leaving it to a separate
        // save step is how a chosen model used to be quietly thrown away.
        select.addEventListener('change', async () => {
          const chosen = select.value;
          select.disabled = true;
          try {
            await api.agents.update(agent.id, { model: chosen });
            toast(t('agents.toast.model', { model: chosen }));
          } catch (err) {
            toast(err.message, true);
            select.value = agent.model || '';
          } finally {
            select.disabled = false;
          }
        });
        label.append(caption, select);
        card.append(label);
      } else {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = own.length ? t('agents.ownModelsEmpty') : t('gateway.noModels');
        card.append(empty);
      }

      const row = document.createElement('div');
      row.className = 'row';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = agent.added ? 'ghost' : 'primary';
      button.dataset.role = agent.added ? 'remove' : 'add';
      button.textContent = agent.added ? t('action.removeAgent') : t('action.addAgent');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          if (agent.added) {
            await api.agents.remove(agent.id);
            toast(t('agents.toast.removed', { name: agent.name }));
          } else {
            const select = card.querySelector('[data-role=model]');
            await api.agents.add(agent.id, select ? { model: select.value } : {});
            toast(t('agents.toast.added', { name: agent.name }));
          }
          await loadAgents();
        } catch (err) {
          toast(err.message, true);
          button.disabled = false;
        }
      });
      row.append(button);
      card.append(row);

      // A subscription's models only appear once the agent is signed in, so the
      // sign-in is offered exactly when the agent reported that it needs it.
      if (needsSignIn(agent)) {
        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.className = 'primary';
        signIn.dataset.role = 'login';
        signIn.textContent = t('agents.signIn');
        signIn.addEventListener('click', async () => {
          signIn.disabled = true;
          signIn.textContent = t('agents.signingIn');
          try {
            const result = await api.agents.login(agent.id);
            if (result.ok) {
              toast(result.pending ? result.reason : t('agents.toast.signedIn', { name: agent.name }));
              await loadAgents();
            } else {
              toast(result.reason, true);
            }
          } catch (err) {
            toast(err.message, true);
          } finally {
            signIn.disabled = false;
            signIn.textContent = t('agents.signIn');
          }
        });
        row.append(signIn);
      }

      if (agent.added && choices.length) {
        const probe = document.createElement('button');
        probe.type = 'button';
        probe.className = 'ghost';
        probe.dataset.role = 'probe';
        probe.textContent = t('gateway.heading');
        probe.addEventListener('click', async () => {
          const select = card.querySelector('[data-role=model]');
          if (!select) return;
          probe.disabled = true;
          try {
            const result = await api.gateway.probe(select.value);
            toast(result.ok ? `${select.value}: ok` : `${select.value}: ${result.kind || 'failed'}`);
          } catch (err) {
            toast(err.message, true);
          } finally {
            probe.disabled = false;
          }
        });
        row.append(probe);
      }

      list.append(card);
    }
  }

  /* --------------------------------------------------------------- gateway */

  async function loadGateway() {
    const summary = $('#gateway-summary');
    if (!summary) return;
    summary.textContent = t('gateway.checking');
    try {
      const settings = await api.settings.get();
      const form = $('#form-gateway');
      form.endpoint.value = (settings.gateway && settings.gateway.endpoint) || '';
      form.autoRepair.checked = !(settings.gateway && settings.gateway.autoRepair === false);
    } catch (err) {
      summary.textContent = err.message;
      return;
    }
    await refreshGateway();
  }

  async function refreshGateway() {
    const summary = $('#gateway-summary');
    if (!summary) return;
    try {
      const status = await api.gateway.status();
      state.gateway = status;
      if (status.httpStatus && status.httpStatus !== 200) {
        summary.textContent = t('gateway.status.http', { status: status.httpStatus });
      } else if (status.models && status.models.length) {
        summary.textContent = t('gateway.working', { count: status.models.length });
      } else {
        summary.textContent = t('gateway.noModels');
      }
    } catch (err) {
      summary.textContent = err.message;
    }
  }

  async function repairGateway() {
    const summary = $('#gateway-summary');
    if (!summary) return;
    summary.textContent = t('gateway.checking');
    try {
      const result = await api.gateway.repair();
      summary.textContent = result.repaired
        ? t('gateway.repaired', { model: result.model })
        : t('gateway.repairFailed');
    } catch (err) {
      summary.textContent = err.message;
    }
  }

  /* ------------------------------------------------------------- providers */

  async function loadProviders() {
    const list = $('#provider-list');
    if (!list) return;
    list.textContent = '';
    let catalog;
    let credentials = { credentials: [] };
    try {
      catalog = await api.providers.catalog();
      credentials = await api.vault.list();
    } catch (err) {
      toast(err.message, true);
      return;
    }
    const keys = new Set((credentials.credentials || []).map((entry) => entry.providerId));
    const all = [...(catalog.local || []), ...(catalog.cloud || [])];

    for (const provider of all) {
      const card = document.createElement('div');
      card.className = 'card provider';
      card.dataset.provider = provider.id;

      const head = document.createElement('div');
      head.className = 'provider-head';
      const name = document.createElement('div');
      name.textContent = provider.name;
      const badge = document.createElement('span');
      badge.className = `badge ${keys.has(provider.id) ? 'ok' : ''}`;
      badge.textContent = keys.has(provider.id) ? t('providers.hasKey') : t('providers.noKey');
      head.append(name, badge);

      const api$ = document.createElement('p');
      api$.className = 'hint';
      api$.textContent = [provider.local ? 'local' : 'cloud', (provider.apis || []).join(', ')].filter(Boolean).join(' · ');
      card.append(head, api$);

      const row = document.createElement('div');
      row.className = 'row';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'ghost';
      save.textContent = t('action.saveKey');
      save.addEventListener('click', async () => {
        const secret = window.prompt(`${t('action.saveKey')} — ${provider.name}`);
        if (!secret) return;
        save.disabled = true;
        try {
          await api.vault.save({ providerId: provider.id, secret });
          await loadProviders();
        } catch (err) {
          toast(err.message, true);
          save.disabled = false;
        }
      });
      row.append(save);

      if (keys.has(provider.id)) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ghost';
        remove.textContent = t('action.removeKey');
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try {
            await api.vault.remove(provider.id);
            await loadProviders();
          } catch (err) {
            toast(err.message, true);
            remove.disabled = false;
          }
        });
        row.append(remove);
      }
      card.append(row);
      list.append(card);
    }
  }

  /* --------------------------------------------------------------- updates */

  function renderUpdates(status) {
    const summary = $('#updates-summary');
    const notes = $('#updates-notes');
    const error = $('#updates-error');
    const install = $('#btn-updates-install');
    const check = $('#btn-updates-check');
    if (!summary) return;

    notes.hidden = true;
    error.hidden = true;
    install.hidden = true;
    if (check) check.disabled = false;
    if (!status) {
      summary.textContent = t('updates.checking');
      return;
    }

    const current = status.currentVersion || 'unknown';
    if (status.busy || status.state === 'downloading' || status.state === 'installing') {
      summary.textContent = status.state === 'downloading'
        ? t('updates.downloading', { version: status.latestVersion, percent: status.progress || 0 })
        : t('updates.installing');
      if (check) check.disabled = true;
      return;
    }

    if (status.updateAvailable) {
      summary.textContent = t('updates.available', { latest: status.latestVersion, version: current });
      install.hidden = false;
      install.textContent = `${t('action.checkUpdates')} ${status.latestVersion}`;
      if (status.notes) {
        notes.textContent = status.notes.slice(0, 2000);
        notes.hidden = false;
      }
      return;
    }
    if (status.state === 'current') return void (summary.textContent = t('updates.current', { version: current }));
    if (status.state === 'ahead') return void (summary.textContent = t('updates.ahead', { version: current, latest: status.latestVersion }));
    if (status.state === 'no-release') return void (summary.textContent = t('updates.noRelease', { version: current }));
    if (status.state === 'incomplete-release') {
      summary.textContent = t('updates.incomplete', { latest: status.latestVersion });
      error.textContent = status.error || '';
      error.hidden = !status.error;
      return;
    }
    summary.textContent = t('updates.unknown', { version: current });
    if (status.error) {
      error.textContent = status.error;
      error.hidden = false;
    }
  }

  async function refreshUpdates(force) {
    try {
      state.updates = await api.updates.check(force);
    } catch (err) {
      state.updates = null;
      const error = $('#updates-error');
      if (error) {
        error.textContent = err.message;
        error.hidden = false;
      }
    }
    renderUpdates(state.updates);
  }

  /* ------------------------------------------------------------------ wire */

  function bind() {
    if (bound) return;
    bound = true;

    for (const tab of $$('#settings-tabs .tab')) {
      tab.addEventListener('click', () => showTab(tab.dataset.tab));
    }

    $('#btn-settings-back').addEventListener('click', async () => {
      // Back goes wherever the work was: the router, when there is one to go to.
      const result = await api.reveal();
      if (!result.revealed) toast(t('toast.routerDidNotOpen', { reason: result.reason || '' }), true);
    });

    $('#form-profile').addEventListener('submit', (event) => {
      event.preventDefault();
      saveAccount();
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
        toast(t('account.toast.passwordReplaced'));
      } catch (err) {
        setError(form, err.message);
      }
    });

    $('#btn-logout').addEventListener('click', async () => {
      await api.auth.logout();
      toast(t('toast.signedOut'));
      if (window.ccrGate) window.ccrGate.onSignedOut();
    });

    $('#btn-delete-account').addEventListener('click', async () => {
      if (!window.confirm(t('account.confirmDelete'))) return;
      try {
        await api.account.remove();
        toast(t('toast.accountDeleted'));
        if (window.ccrGate) window.ccrGate.onSignedOut();
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#language-select').addEventListener('change', (event) => {
      setLanguage(event.target.value);
    });

    $('#btn-share-keys').addEventListener('click', async () => {
      try {
        state.secretSync = await api.sync.pushVault();
        renderSecretSync(state.secretSync);
        toast(state.secretSync.ok ? t('account.secretSyncShared', { count: state.secretSync.shared, time: '' }) : state.secretSync.error, !state.secretSync.ok);
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#btn-take-keys').addEventListener('click', async () => {
      try {
        state.secretSync = await api.sync.pullVault();
        renderSecretSync(state.secretSync);
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#form-gateway').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      setError(form, '');
      try {
        await api.settings.updateGateway({ endpoint: form.endpoint.value.trim() || null, autoRepair: form.autoRepair.checked });
        await refreshGateway();
      } catch (err) {
        setError(form, err.message);
      }
    });

    $('#btn-gateway-refresh').addEventListener('click', refreshGateway);
    $('#btn-gateway-repair').addEventListener('click', repairGateway);
    $('#btn-updates-check').addEventListener('click', () => refreshUpdates(true));

    $('#btn-updates-install').addEventListener('click', async () => {
      const button = $('#btn-updates-install');
      button.disabled = true;
      renderUpdates({ ...(state.updates || {}), state: 'downloading', latestVersion: state.updates && state.updates.latestVersion, progress: 0, busy: true });
      try {
        state.updates = await api.updates.install();
        renderUpdates(state.updates);
        if (state.updates.state === 'failed') toast(state.updates.error || t('updates.failed'), true);
      } catch (err) {
        renderUpdates(state.updates);
        toast(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }

  window.ccrSettings = {
    /** Called by account.js once the session is known and the view is shown. */
    async open(boot, tab) {
      state.account = (boot && boot.account) || null;
      window.ccrSettingsEncryption = boot && boot.encryptionBackend;
      bind();
      fillLanguages();
      fillAccount();
      showTab(tab || 'account');
      try {
        state.updates = await api.updates.state();
      } catch {
        state.updates = null;
      }
      renderUpdates(state.updates);
      return true;
    },
    setLanguage,
    showTab,
    localeCount: () => i18n.LOCALES.length,
  };
})();
