'use strict';

/**
 * Translations for the gate pages: sign in, setup, and settings.
 *
 * English is the source of truth. Every other table may be partial, and any
 * string it is missing falls back to the English one, so a half-finished
 * language shows English rather than a raw key or an empty label. Adding a
 * language means adding one entry to LOCALES and one table below.
 */
window.ccrI18n = (() => {
  const STORAGE_KEY = 'ccr.locale';

  const LOCALES = [
    { code: 'en', label: 'English', dir: 'ltr' },
    { code: 'ar', label: 'العربية', dir: 'rtl' },
    { code: 'bn', label: 'বাংলা', dir: 'ltr' },
    { code: 'zh-CN', label: '简体中文', dir: 'ltr' },
    { code: 'zh-TW', label: '繁體中文', dir: 'ltr' },
    { code: 'nl', label: 'Nederlands', dir: 'ltr' },
    { code: 'fr', label: 'Français', dir: 'ltr' },
    { code: 'de', label: 'Deutsch', dir: 'ltr' },
    { code: 'hi', label: 'हिन्दी', dir: 'ltr' },
    { code: 'id', label: 'Bahasa Indonesia', dir: 'ltr' },
    { code: 'it', label: 'Italiano', dir: 'ltr' },
    { code: 'ja', label: '日本語', dir: 'ltr' },
    { code: 'ko', label: '한국어', dir: 'ltr' },
    { code: 'pl', label: 'Polski', dir: 'ltr' },
    { code: 'pt', label: 'Português (Brasil)', dir: 'ltr' },
    { code: 'ru', label: 'Русский', dir: 'ltr' },
    { code: 'es', label: 'Español', dir: 'ltr' },
    { code: 'tr', label: 'Türkçe', dir: 'ltr' },
    { code: 'uk', label: 'Українська', dir: 'ltr' },
    { code: 'vi', label: 'Tiếng Việt', dir: 'ltr' },
  ];

  const en = {
    'app.name': 'Claude Code Router',
    'app.account': 'Account',
    'app.settings': 'Settings',

    'progress.account': '1. Account',
    'progress.sync': '2. Sync',
    'progress.harnesses': '3. Harnesses',

    'auth.subtitle.login': 'Sign in to open your router. Guest access is not available.',
    'auth.subtitle.signup': 'Create an account to use your router. Guest access is not available.',
    'auth.tab.login': 'Sign in',
    'auth.tab.signup': 'Create account',
    'field.email': 'Email',
    'field.password': 'Password',
    'field.displayName': 'Display name',
    'field.currentPassword': 'Current password',
    'field.newPassword': 'New password',
    'auth.passwordHint': 'Passwords are hashed with scrypt and secrets are encrypted. Nothing is stored in the clear.',
    'action.signIn': 'Sign in',
    'action.createAccount': 'Create account',
    'toast.accountCreated': 'Account created',
    'toast.signedIn': 'Signed in',
    'toast.signedOut': 'Signed out',
    'toast.accountDeleted': 'Account deleted',
    'toast.routerDidNotOpen': 'The router did not open: {reason}',

    'sync.title': 'Where should this account live?',
    'sync.subtitle': 'You are asked this once on every device you sign in from.',
    'sync.device': 'This device only',
    'sync.deviceHint': 'Secrets stay encrypted on this Mac. Nothing is uploaded.',
    'sync.synced': 'Synced across devices',
    'sync.syncedHint': 'Needs an https:// sync endpoint you control.',
    'sync.endpoint': 'Sync endpoint',
    'action.continue': 'Continue',

    'harness.title': 'Pick your harnesses',
    'harness.subtitle': 'Harnesses that need a paid plan are routed through your router instead, so no third-party login is collected. The ones that run free keep their own built-in models.',
    'harness.billing.free': 'No payment',
    'harness.billing.paid': 'Payment required',
    'harness.enable': 'Enable for this device',
    'harness.builtInModel': 'Built-in model',
    'harness.noBuiltIn': 'No built-in models: requests are routed to the providers you configure.',
    'action.finishSetup': 'Finish setup',

    'settings.title': 'Settings',
    'settings.back': 'Back',
    'settings.tab.account': 'Account',
    'settings.tab.language': 'Language',
    'settings.tab.agents': 'Agents',
    'settings.tab.gateway': 'Gateway',
    'settings.tab.providers': 'Providers',
    'settings.tab.updates': 'Updates',

    'account.heading': 'Account',
    'account.profile': 'Profile',
    'account.storage': 'Credential storage',
    'account.storageDevice': 'This device only',
    'account.storageSynced': 'Synced across devices',
    'account.endpoint': 'Sync endpoint',
    'account.encryptionKeychain': 'Secrets on this account are encrypted with the macOS keychain.',
    'account.encryptionDevice': 'Secrets on this account are encrypted with a key stored on this device only.',
    'account.encryptionShared': 'API keys you save are sealed with your account password, so every device signed in to {email} can use them. The sync endpoint only ever holds the sealed copy.',
    'account.shareKeys': 'Share my API keys',
    'account.takeKeys': 'Use keys from my other devices',
    'account.secretSyncShared': 'Shared {count} key(s) at {time}.',
    'account.secretSyncEmpty': 'No keys have been shared from another device yet.',
    'account.secretSyncTaken': 'Brought in {count} key(s) at {time}.',
    'account.toast.profileSaved': 'Profile saved',
    'account.toast.passwordReplaced': 'Password replaced',
    'account.password': 'Password',
    'action.save': 'Save',
    'action.saveProfile': 'Save profile',
    'action.replacePassword': 'Replace password',
    'action.signOut': 'Sign out',
    'account.danger': 'Danger zone',
    'account.dangerHint': 'Deleting the account signs you out and erases its stored secrets on this device.',
    'action.deleteAccount': 'Delete account',
    'account.confirmDelete': 'Delete this account and its stored secrets on this device?',

    'language.heading': 'Language',
    'language.hint': 'Applies to the sign-in and settings pages. The router keeps its own language setting.',
    'language.restartHint': 'The change is applied right away.',

    'agents.heading': 'Agents',
    'agents.hint': 'An agent is only used once you add it. Paid agents are routed through your gateway, so no agent login is ever collected.',
    'agents.empty': 'No agents found on this device.',
    'agents.state.installed': 'Installed, not connected',
    'agents.state.missing': 'Not installed',
    'agents.state.added': 'In your profiles',
    'agents.needLogin': 'Sign in to this agent on this device first, then add it.',
    'agents.ownModels': 'Models this agent offers',
    'agents.gatewayModels': 'Routed through your gateway',
    'agents.ownModelsEmpty': 'This agent did not list any models.',
    'agents.toast.added': 'Added {name}.',
    'agents.toast.removed': 'Removed {name}.',
    'agents.toast.model': 'Model changed to {model}.',
    'agents.signIn': 'Sign in',
    'agents.signingIn': 'Signing in…',
    'agents.toast.signedIn': '{name} is signed in.',
    'agents.sourceSubscription': 'From your Claude subscription.',
    'agents.sourceFree': 'Free plan, already available.',
    'agents.sourceOwnBilled': 'From the plan you pay for.',
    'agents.sourceNeedsPlan': 'Sign in to your plan to see its models.',
    'action.addAgent': 'Add',
    'action.removeAgent': 'Remove',
    'agents.model': 'Model',
    'agents.source': 'Where these models come from',
    'agents.sourceRouted': 'Routed through your gateway, so no agent login is needed.',
    'agents.sourceOwn': 'Listed by the agent itself, read from this device without any login.',
    'agents.sourceNone': 'The agent could not be asked, so only your gateway models are offered.',

    'gateway.heading': 'Gateway',
    'gateway.endpoint': 'Endpoint',
    'gateway.autoRepair': 'Repair a broken model automatically',
    'action.refresh': 'Refresh',
    'action.repair': 'Repair',
    'gateway.checking': 'Checking the gateway\u2026',
    'gateway.working': 'The gateway is answering on {count} model(s).',
    'gateway.noModels': 'The gateway is not offering any model right now.',
    'gateway.status.http': 'The gateway answered HTTP {status}.',
    'gateway.repaired': 'Repaired the profile to use {model}.',
    'gateway.repairFailed': 'No working model was found, so nothing was changed.',

    'providers.heading': 'Providers',
    'providers.hint': 'A provider is refused unless the router can actually use it. Keys are stored encrypted.',
    'providers.hasKey': 'Key saved',
    'providers.noKey': 'No key',
    'action.saveKey': 'Save key',
    'action.removeKey': 'Remove key',

    'updates.heading': 'Updates',
    'updates.checking': 'Checking for a newer build\u2026',
    'updates.current': 'You are on {version}, which is the newest build.',
    'updates.ahead': 'You are on {version}, which is newer than the published {latest}.',
    'updates.available': 'Version {latest} is ready. You are on {version}.',
    'updates.noRelease': 'You are on {version}. No build has been published yet.',
    'updates.incomplete': 'Version {latest} was published without a build this app can install.',
    'updates.unknown': 'You are on {version}.',
    'updates.downloading': 'Downloading {version}\u2026 {percent}%',
    'updates.installing': 'Installing and restarting\u2026',
    'updates.failed': 'The update did not finish.',
    'action.checkUpdates': 'Check for updates',
  };

  const TABLES = { en };

  const byCode = new Map(LOCALES.map((locale) => [locale.code, locale]));

  function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{(\w+)\}/g, (match, name) => (
      Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
        ? String(vars[name])
        : match
    ));
  }

  function lookup(code, key) {
    const table = TABLES[code];
    if (table && Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    return null;
  }

  function t(key, vars) {
    const code = current();
    const found = lookup(code, key) !== null ? lookup(code, key) : lookup('en', key);
    // An unknown key shows as itself rather than as nothing, so a gap is visible.
    return interpolate(found === null ? key : found, vars);
  }

  function current() {
    return active;
  }

  let active = 'en';

  function detect() {
    let stored = null;
    try {
      stored = window.localStorage.getItem(STORAGE_KEY);
    } catch {}
    if (stored && byCode.has(stored)) return stored;
    for (const wanted of navigator.languages || [navigator.language || 'en']) {
      const tag = String(wanted || '').trim();
      if (!tag) continue;
      if (byCode.has(tag)) return tag;
      const base = tag.split('-')[0].toLowerCase();
      const match = LOCALES.find((locale) => locale.code.toLowerCase() === base || locale.code.toLowerCase().startsWith(`${base}-`));
      if (match) return match.code;
    }
    return 'en';
  }

  function dirFor(code) {
    const locale = byCode.get(code);
    return (locale && locale.dir) || 'ltr';
  }

  /**
   * Switches language and repaints the page in place. Markup is translated by
   * `data-i18n`, and `data-i18n-attr` carries attribute text such as a
   * placeholder, so nothing is left half in one language.
   */
  function apply(code) {
    const next = byCode.has(code) ? code : 'en';
    active = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {}
    document.documentElement.lang = next;
    document.documentElement.dir = dirFor(next);
    paint();
    return next;
  }

  function paint() {
    for (const node of document.querySelectorAll('[data-i18n]')) {
      node.textContent = t(node.dataset.i18n);
    }
    for (const node of document.querySelectorAll('[data-i18n-attr]')) {
      // "placeholder:settings.sync.endpoint;title:settings.title"
      for (const pair of node.dataset.i18nAttr.split(';')) {
        const [attr, key] = pair.split(':').map((part) => (part || '').trim());
        if (attr && key) node.setAttribute(attr, t(key));
      }
    }
    for (const node of document.querySelectorAll('[data-i18n-title]')) {
      node.title = t(node.dataset.i18nTitle);
    }
  }

  function localeOptions(selected) {
    return LOCALES.map((locale) => ({
      code: locale.code,
      label: locale.label,
      dir: locale.dir,
      selected: locale.code === (selected || active),
    }));
  }

  return {
    LOCALES,
    t,
    apply,
    paint,
    detect,
    dirFor,
    localeOptions,
    current,
    register(code, table) {
      if (!byCode.has(code) || !table || typeof table !== 'object') return false;
      TABLES[code] = Object.assign({}, TABLES[code], table);
      return true;
    },
    coverage(code) {
      const table = TABLES[code];
      if (!table) return 0;
      const total = Object.keys(en).length;
      const have = Object.keys(en).filter((key) => Object.prototype.hasOwnProperty.call(table, key)).length;
      return total ? have / total : 0;
    },
  };
})();
