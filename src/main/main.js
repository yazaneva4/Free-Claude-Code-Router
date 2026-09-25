'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const electron = require('electron');
const { app, Menu, ipcMain, safeStorage, shell } = electron;

const CCR_APP = process.env.CCR_APP_PATH || '/Applications/Claude Code Router.app';
const CCR_RESOURCES = path.join(CCR_APP, 'Contents/Resources');
const ORIGINAL_ASAR = path.join(CCR_RESOURCES, 'app-original.asar');
const INSTALLED_ASAR = path.join(CCR_RESOURCES, 'app.asar');
const ROUTER_ASAR = fs.existsSync(ORIGINAL_ASAR) ? ORIGINAL_ASAR : INSTALLED_ASAR;
const CCR_MAIN_DIR = path.join(ROUTER_ASAR, 'dist', 'main');
const CCR_MAIN = path.join(CCR_MAIN_DIR, 'main.js');
const ROUTER_PRELOAD = path.join(CCR_MAIN_DIR, 'preload.js');
const ROUTER_HOME = path.join(ROUTER_ASAR, 'dist', 'renderer', 'pages', 'home', 'index.html');
const ACCOUNT_PAGE = path.join(__dirname, '..', 'renderer', 'index.html');
const ACCOUNT_URL = pathToFileURL(ACCOUNT_PAGE).toString();
const ROUTER_URL = pathToFileURL(ROUTER_HOME).toString();
const CHAINED_PRELOAD = path.join(__dirname, '..', 'preload', 'chained.js');
const HOME_DIR = os.homedir();
const CCR_HOME = path.join(HOME_DIR, '.claude-code-router');
const AUTH_DIR = process.env.CCR_AUTH_DIR || path.join(CCR_HOME, 'auth');
const LOG_FILE = path.join(CCR_HOME, 'gate.log');
const SELFTEST = process.env.CCR_SELFTEST === '1';
const SELFTEST_FILE = path.join(CCR_HOME, 'selftest.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(CCR_HOME, { recursive: true, mode: 0o700 });
    fs.appendFileSync(LOG_FILE, line, { mode: 0o600 });
  } catch {}
  process.stdout.write(line);
}

app.setName('Claude Code Router');
try {
  app.setPath('userData', process.env.CCR_USER_DATA || path.join(CCR_HOME, 'app-data'));
} catch {}

const { Store } = require('./store');
const { createCrypto } = require('./crypto');
const { AccountService } = require('./accounts');
const { Vault } = require('./vault');
const { Settings } = require('./settings');
const { registerIpc, result, failure } = require('./ipc');

let accounts = null;
let vault = null;
let settings = null;
let crypto = null;
let mainWindow = null;
let currentPage = null;
let authenticated = false;

function createServices() {
  const store = new Store(AUTH_DIR);
  crypto = createCrypto({ safeStorage, keyFile: store.file('.devicekey') });
  vault = new Vault({ store, crypto });
  accounts = new AccountService({ store, crypto, purge: (id) => vault.deleteAllForAccount(id) });
  settings = new Settings({ store });
  return { store, crypto, accounts, vault, settings };
}

function isPageUrl(url) {
  const bare = String(url || '').split('#')[0].split('?')[0];
  return bare === ACCOUNT_URL || bare === ROUTER_URL;
}

function adoptRouterWindow(win) {
  mainWindow = win;
  const real = {
    loadURL: win.loadURL.bind(win),
    loadFile: win.loadFile.bind(win),
    show: win.show.bind(win),
    focus: win.focus.bind(win),
  };
  win.ccrInternals = { real };

  win.loadURL = (url, options) => {
    if (authenticated) {
      currentPage = 'router';
      return real.loadURL(url, options);
    }
    log(`router page blocked while signed out: ${String(url).slice(0, 90)}`);
    return showAccountPage();
  };

  win.loadFile = (file, options) => {
    if (String(file) === ACCOUNT_PAGE) {
      currentPage = 'account';
      return real.loadFile(file, options);
    }
    if (authenticated) {
      currentPage = 'router';
      return real.loadFile(file, options);
    }
    return showAccountPage();
  };

  win.show = () => (authenticated ? real.show() : showAccountPage());
  win.focus = () => {
    if (authenticated) real.focus();
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isPageUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    currentPage = null;
    log('router window closed');
  });

  log('adopted the router window for the account gate');
  return win;
}

function showAccountPage(hash) {
  const win = mainWindow;
  if (!win || win.isDestroyed() || !win.ccrInternals) return Promise.resolve(false);
  const target = hash || '';
  if (currentPage === 'account' && !target) {
    win.ccrInternals.real.show();
    win.ccrInternals.real.focus();
    return Promise.resolve(true);
  }
  log(`account page requested${target ? ` (${target})` : ''}`);
  currentPage = 'account';
  return win.ccrInternals.real
    .loadFile(ACCOUNT_PAGE, target ? { hash: target } : undefined)
    .then(() => {
      win.ccrInternals.real.show();
      win.ccrInternals.real.focus();
      return true;
    })
    .catch((err) => {
      log(`account page failed: ${err && err.message ? err.message : err}`);
      return false;
    });
}

function revealApp() {
  const session = accounts && accounts.session();
  if (!session) return { revealed: false, reason: 'signed_out' };
  if (!accounts.onboarding().complete) return { revealed: false, reason: 'onboarding_incomplete' };
  const win = mainWindow;
  if (!win || win.isDestroyed() || !win.ccrInternals) return { revealed: false, reason: 'no_window' };
  authenticated = true;
  currentPage = 'router';
  return win.ccrInternals.real
    .loadURL(ROUTER_URL)
    .then(() => {
      win.ccrInternals.real.show();
      win.ccrInternals.real.focus();
      log(`router revealed for ${session.account.email}`);
      return { revealed: true, account: session.account };
    })
    .catch((err) => {
      authenticated = false;
      log(`router reveal failed: ${err && err.message ? err.message : err}`);
      return { revealed: false, reason: 'load_failed' };
    });
}

function lockApp() {
  if (accounts) accounts.logout();
  authenticated = false;
  currentPage = null;
  log('locked: session cleared, account page shown');
  return showAccountPage();
}

function toTemplate(items) {
  return items.map((item) => {
    const entry = {};
    if (item.type && item.type !== 'normal') entry.type = item.type;
    if (item.label) entry.label = item.label;
    if (item.role) entry.role = item.role;
    if (item.accelerator) entry.accelerator = item.accelerator;
    if (typeof item.enabled === 'boolean') entry.enabled = item.enabled;
    if (typeof item.visible === 'boolean') entry.visible = item.visible;
    if (typeof item.checked === 'boolean') entry.checked = item.checked;
    if (typeof item.click === 'function') entry.click = item.click;
    if (item.submenu) entry.submenu = toTemplate(item.submenu.items);
    return entry;
  });
}

function addGateMenu() {
  const existing = Menu.getApplicationMenu();
  const template = existing ? toTemplate(existing.items) : [];
  const gateItems = [
    { label: 'Account…', accelerator: 'Cmd+,', click: () => showAccountPage('#account') },
    { label: 'Lock and Sign Out', accelerator: 'Cmd+Shift+L', click: () => lockApp() },
    { type: 'separator' },
  ];
  if (!template.length) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ label: 'Claude Code Router', submenu: [...gateItems, { role: 'quit' }] }])
    );
    return;
  }
  const first = template[0];
  if (!first.submenu) first.submenu = [];
  if (first.submenu.some((item) => item.label === 'Lock and Sign Out')) return;
  first.submenu.splice(1, 0, ...gateItems);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function whenWindow(timeoutMs = 15000) {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        clearInterval(poll);
        resolve(mainWindow);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error('the router never opened a window'));
      }
    }, 40);
  });
}

const OriginalBrowserWindow = electron.BrowserWindow;

function isRouterPreload(preload) {
  return typeof preload === 'string' && preload.replace(/\\/g, '/').endsWith('/dist/main/preload.js');
}

class GatedRouterWindow extends OriginalBrowserWindow {
  constructor(options = {}) {
    const incoming = { ...options };
    const webPreferences = { ...(incoming.webPreferences || {}) };
    const routerPreload = webPreferences.preload;
    const routerWindow = isRouterPreload(routerPreload);
    if (routerWindow) {
      webPreferences.sandbox = false;
      webPreferences.preload = CHAINED_PRELOAD;
      webPreferences.additionalArguments = [
        ...(webPreferences.additionalArguments || []),
        `--ccr-router-preload=${routerPreload}`,
      ];
      incoming.webPreferences = webPreferences;
    }
    super(incoming);
    if (routerWindow) adoptRouterWindow(this);
  }
}

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function loadForRouter(request, parent, isMain) {
  const loaded = originalLoad.call(this, request, parent, isMain);
  const fromRouter = parent && typeof parent.filename === 'string' && parent.filename.startsWith(ROUTER_ASAR);
  if (request === 'electron' && fromRouter) {
    return new Proxy(loaded, {
      get(target, property) {
        if (property === 'BrowserWindow') return GatedRouterWindow;
        return Reflect.get(target, property, target);
      },
    });
  }
  return loaded;
};

log(`bootstrap starting (router asar: ${ROUTER_ASAR})`);
if (!fs.existsSync(CCR_MAIN)) {
  log(`fatal: router main missing at ${CCR_MAIN}`);
  app.quit();
}
require(CCR_MAIN);
log('router main loaded');

ipcMain.handle('gate:reveal', async () => {
  try {
    return result(await revealApp());
  } catch (err) {
    return failure(err);
  }
});

async function bootstrap() {
  const services = createServices();
  registerIpc({ ipcMain, ...services });

  let win;
  try {
    win = await whenWindow();
  } catch (err) {
    log(`fatal: ${err.message}`);
    app.quit();
    return;
  }

  const session = accounts.session();
  if (session && accounts.onboarding().complete) {
    authenticated = true;
    log(`existing session for ${session.account.email} - router allowed`);
  } else if (session) {
    authenticated = false;
    log(`session for ${session.account.email} but setup is incomplete - account page required`);
    await showAccountPage();
  } else {
    authenticated = false;
    log('signed out - router held back, account page shown');
    await showAccountPage();
  }

  addGateMenu();

  if (SELFTEST) {
    const { runSelfTest } = require('./selftest');
    await runSelfTest({ app, window: win, revealApp, lockApp, showAccountPage, logFile: SELFTEST_FILE });
  }
}

app.whenReady().then(bootstrap);

app.on('window-all-closed', () => {
  if (!authenticated) app.quit();
});

app.on('activate', () => {
  if (authenticated && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.gate.real.show();
    mainWindow.gate.real.focus();
  } else {
    showAccountPage();
  }
});

module.exports = { revealApp, lockApp, showAccountPage, bootstrap };
