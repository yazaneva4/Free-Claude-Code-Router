'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isForbiddenModelId } = require('./providers');
const { badRequest, cleanBaseUrl, cleanText } = require('./validators');

const GATEWAY_BASE_URL = 'http://127.0.0.1:3456';

const AGENTS = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    harness: 'claude-code',
    kind: 'cli',
    binary: 'claude',
    paid: true,
    billingLabel: 'Uses the plan you already pay for',
    needsLogin: false,
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    harness: 'codex-cli',
    kind: 'cli',
    binary: 'codex',
    paid: true,
    billingLabel: 'Uses the plan you already pay for',
    needsLogin: false,
  },
  {
    id: 'claude-app',
    name: 'Claude',
    harness: 'claude-app',
    kind: 'app',
    appBundle: 'Claude',
    paid: true,
    billingLabel: 'Uses the plan you already pay for',
    needsLogin: false,
  },
  {
    id: 'codex-app',
    name: 'Codex',
    harness: 'codex-app',
    kind: 'app',
    appBundle: 'Codex',
    paid: true,
    billingLabel: 'Uses the plan you already pay for',
    needsLogin: false,
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    harness: 'gemini-cli',
    kind: 'cli',
    binary: 'gemini',
    paid: false,
    billingLabel: 'Free Google AI Studio key',
    needsLogin: false,
  },
];

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

function getAgent(agentId) {
  return BY_ID.get(String(agentId || '').trim().toLowerCase()) || null;
}

function whichBinary(binary, env = process.env) {
  if (!binary) return null;
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function appInstalled(appBundle, home = os.homedir()) {
  if (!appBundle) return false;
  return ['/Applications', path.join(home, 'Applications')].some((dir) => fs.existsSync(path.join(dir, `${appBundle}.app`)));
}

function detect({ env = process.env, home = os.homedir(), exists = fs.existsSync } = {}) {
  return AGENTS.map((agent) => {
    const binaryPath = agent.binary ? whichBinary(agent.binary, env) : null;
    const installed = agent.kind === 'app' ? exists(path.join('/Applications', `${agent.appBundle}.app`)) || appInstalled(agent.appBundle, home) : Boolean(binaryPath);
    return {
      id: agent.id,
      installed,
      path: binaryPath || (agent.kind === 'app' && installed ? `/Applications/${agent.appBundle}.app` : null),
    };
  });
}

/**
 * Asks an agent which models it can use. Nothing here is invented: the binary's
 * own help output has to advertise a listing command before it is run, and a
 * command that needs a sign-in is reported so the user can sign in through the
 * agent itself. A desktop app has no way to be asked, so it reports nothing
 * instead of a guess.
 */
const LISTING_COMMANDS = ['list-models', 'models list', 'model list', 'ls-models', 'models'];
/*
 * Signing in is how a subscription's models become visible: the agent owns the
 * credential and performs its own sign-in, and this app only reads what the
 * agent reports afterwards. No password or token is ever collected or stored
 * here, which is why the only thing these can do is run the command the agent's
 * own help advertises.
 */
const LOGIN_COMMANDS = ['auth login', 'sign-in', 'authenticate', 'login', 'signin', 'auth'];
/*
 * A subscription unlocks the models the agent ships with, and that shows up in
 * the agent's own status rather than in a list it publishes. These are the
 * methods that mean a real Anthropic sign-in, as opposed to being routed through
 * this app's own key helper or a plain API key.
 */
const SUBSCRIPTION_METHODS = /claudeai|claude_ai|claude\.ai|oauth|subscription|account/i;
const ROUTED_METHODS = /api_key_helper|apikeyhelper|api_key|apikey|apiKeyHelper|none|bedrock|vertex|foundry/i;
const AUTH_STATUS_COMMAND = 'auth status';
const REPL_LOGIN_COMMANDS = ['/login', '/signin', '/auth'];
const HELP_TIMEOUT_MS = 8000;
const LIST_TIMEOUT_MS = 12000;
const LOGIN_TIMEOUT_MS = 180000;

function runCommand(binary, args, { env = process.env, timeoutMs = HELP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(binary, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err || null });
    });
  });
}

function looksLikeModel(token) {
  if (token.length < 3 || token.length > 64) return false;
  if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._-]+)?$/i.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (/^(https?|file|utf|ascii|json|yaml|xml|html|css|js|ts|md|txt|log)$/i.test(token)) return false;
  if (/^\d+(\.\d+)*$/.test(token)) return false;
  return true;
}

function findModelsIn(text) {
  const found = [];
  for (const raw of String(text || '').split(/\s+/)) {
    const token = raw.replace(/^[\"'`([{]+|[\"'`)\]},;:]+$/g, '');
    if (!looksLikeModel(token)) continue;
    if (isForbiddenModelId(token)) continue;
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

function findListingCommand(helpText) {
  const text = String(helpText || '');
  if (!text.trim()) return null;
  for (const command of LISTING_COMMANDS) {
    const pattern = new RegExp(`(^|[\\s\\|])${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\|]|$)`, 'im');
    if (pattern.test(text)) return command;
  }
  return null;
}

function findLoginCommand(helpText) {
  const text = String(helpText || '');
  if (!text.trim()) return null;
  for (const command of LOGIN_COMMANDS) {
    const pattern = new RegExp(`(^|[\\s\\|])${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s\\|]|$)`, 'im');
    if (pattern.test(text)) return { mode: 'command', command };
  }
  for (const command of REPL_LOGIN_COMMANDS) {
    // A slash command is only real if something quotes it, as help output does.
    const quoted = new RegExp(`[(\\s"']${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s)"']|$)`, 'im');
    if (quoted.test(text)) return { mode: 'session', command };
  }
  return null;
}

/** Quotes a path for a shell, so a detected binary can never inject a command. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function terminalLauncher(binaryPath, args) {
  return ['osascript', ['-e', `tell application "Terminal" to do script ${shellQuote(`${binaryPath} ${args.join(' ')}`)}`, '-e', 'tell application "Terminal" to activate']];
}

function needsSignIn(result) {
  const text = `${result.stdout} ${result.stderr}`.toLowerCase();
  return /not (logged in|signed in)|please (log ?in|sign ?in|authenticate)|unauthori[sz]ed|api key|login required|authentication/.test(text);
}

async function discoverModels(agentId, options = {}) {
  const agent = getAgent(agentId);
  if (!agent) return { models: [], source: 'unknown-agent', reason: 'That agent profile does not exist.' };
  if (agent.kind !== 'cli') {
    return {
      models: [],
      source: 'not-askable',
      reason: `${agent.name} is a desktop app and does not publish a model list.`,
    };
  }

  const env = options.env || process.env;
  const binaryPath = options.binaryPath || whichBinary(agent.binary, env);
  if (!binaryPath) {
    return { models: [], source: 'not-installed', reason: `${agent.name} is not installed on this device.` };
  }

  const run = options.run || runCommand;
  const help = await run(binaryPath, ['--help'], { env, timeoutMs: options.helpTimeoutMs || HELP_TIMEOUT_MS });
  if (!help.ok && !help.stdout) {
    return { models: [], source: 'unavailable', reason: `${agent.name} did not answer --help.` };
  }

  const helpAll = `${help.stdout}\n${help.stderr}`;
  const command = findListingCommand(helpAll);
  if (!command) {
    /*
     * No published list, so what the agent can use comes down to what it costs.
     *
     * A free agent already has its built-in models: that is what the free plan
     * is, and they need no sign-in, so its own catalogue is the answer. A paid
     * agent's models come with the subscription, so they stay hidden until a
     * subscription is actually signed in, and the names used are the ones its
     * help advertises.
     */
    const status = await readAuthStatus(agent, { env, binaryPath, run, helpTimeoutMs: options.helpTimeoutMs });
    const builtIn = Array.isArray(options.builtInModels) ? options.builtInModels.filter((m) => !isForbiddenModelId(m)) : [];

    if (status && status.subscription) {
      const aliases = readModelAliases(helpAll);
      const models = aliases.length ? aliases : builtIn;
      if (models.length) return { models, source: 'subscription', auth: status, billed: true };
      return {
        models: [],
        source: 'subscription',
        auth: status,
        billed: true,
        reason: `${agent.name} is signed in to a Claude subscription but did not name any models.`,
      };
    }

    if (builtIn.length) {
      return { models: builtIn.slice(), source: 'built-in', auth: status || null, billed: false };
    }

    if (!agent.paid) {
      return {
        models: [],
        source: 'not-published',
        auth: status || null,
        billed: false,
        reason: `${agent.name} is free but does not publish a model list, so it has no built-in models to offer.`,
      };
    }

    return {
      models: [],
      source: 'needs-subscription',
      auth: status || null,
      billed: true,
      reason: `${agent.name} is free to run but its built-in models come with the plan you pay for, so sign in to that plan to see them.`,
    };
  }

  const listed = await run(binaryPath, command.split(' '), { env, timeoutMs: options.listTimeoutMs || LIST_TIMEOUT_MS });
  if (needsSignIn(listed)) {
    return {
      models: [],
      source: 'needs-sign-in',
      reason: `${agent.name} only lists its models once you sign in. A subscription's models are not visible until then.`,
    };
  }

  const models = findModelsIn(`${listed.stdout}\n${listed.stderr}`);
  if (!models.length) {
    return { models: [], source: 'empty', reason: `${agent.name} did not name any models.` };
  }
  return { models, source: 'agent', command };
}

/**
 * Signs the user in to an agent so a subscription's models become visible.
 *
 * The agent runs its own sign-in, so the credential stays with the agent and
 * nothing is collected or stored here. Afterwards the model list is read again
 * and that result is what gets kept.
 *
 * Two shapes are handled. When the agent advertises a `login` subcommand it is
 * run directly, because those open a browser or print a link. When the only
 * sign-in it documents is a `/login` command typed inside a session, the user
 * is given a Terminal window to do it themselves rather than this app typing
 * into someone's account.
 */
async function startLogin(agentId, options = {}) {
  const agent = getAgent(agentId);
  if (!agent) return { ok: false, reason: 'That agent profile does not exist.' };
  if (agent.kind !== 'cli') {
    return { ok: false, reason: `${agent.name} is a desktop app, so sign in from the app itself and this will pick it up.` };
  }

  const env = options.env || process.env;
  const binaryPath = options.binaryPath || whichBinary(agent.binary, env);
  if (!binaryPath) return { ok: false, reason: `${agent.name} is not installed on this device.` };

  const run = options.run || runCommand;
  const help = await run(binaryPath, ['--help'], { env, timeoutMs: options.helpTimeoutMs || HELP_TIMEOUT_MS });
  if (!help.ok && !help.stdout) return { ok: false, reason: `${agent.name} did not answer --help.` };

  let login = options.login || findLoginCommand(`${help.stdout}\n${help.stderr}`);
  // `auth` on its own is a menu, not a sign-in. The command that signs in is
  // named by the auth help, so it is read from there rather than assumed.
  if (login && login.mode === 'command' && login.command === 'auth') {
    const authHelp = await run(binaryPath, ['auth', '--help'], { env, timeoutMs: options.helpTimeoutMs || HELP_TIMEOUT_MS });
    const authText = `${authHelp.stdout || ''}\n${authHelp.stderr || ''}`;
    login = /(^|[\s|])login([\s|]|$)/im.test(authText) ? { mode: 'command', command: 'auth login' } : login;
  }
  if (!login) {
    return {
      ok: false,
      reason: `${agent.name} does not document a sign-in command this app can run. Sign in with ${agent.binary} yourself and it will be picked up.`,
    };
  }

  if (login.mode === 'session') {
    const launch = options.launch || terminalLauncher;
    try {
      const [command, args] = launch(binaryPath, []);
      await new Promise((resolve, reject) => {
        execFile(command, args, { env, timeout: 20000 }, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      return { ok: false, reason: `A Terminal window could not be opened for the sign-in: ${err && err.message ? err.message : err}` };
    }
    return {
      ok: true,
      pending: true,
      mode: 'session',
      reason: `A Terminal window opened ${agent.name}. Type ${login.command} there and finish signing in, then check for models again.`,
    };
  }

  const attempt = await run(binaryPath, login.command.split(' '), {
    env,
    timeoutMs: options.loginTimeoutMs || LOGIN_TIMEOUT_MS,
  });
  const said = `${attempt.stdout}\n${attempt.stderr}`;
  if (!attempt.ok && !said.trim()) {
    return { ok: false, reason: `${agent.name} could not start its sign-in. Run \`${agent.binary} auth login\` yourself and it will be picked up.` };
  }

  const found = await discoverModels(agentId, { ...options, env, binaryPath, run });
  if (found.models && found.models.length) {
    return { ok: true, mode: 'command', models: found.models, source: found.source, auth: found.auth || null, reason: `${agent.name} now offers ${found.models.length} model(s).` };
  }
  if (found.source === 'needs-sign-in') {
    return {
      ok: false,
      reason: `${agent.name} still asks for a sign-in. Finish it in the window that opened, then check for models again.`,
    };
  }
  // The command ran but no subscription showed up. Saying so plainly is more
  // use than repeating that the agent has no models, because the sign-in is
  // what needs attention.
  if (found.auth && found.auth.loggedIn && !found.auth.subscription) {
    return {
      ok: false,
      signedInOnlyLocally: true,
      reason: `${agent.name} is still only reachable through this app, so no subscription models appeared. Finish the sign-in it opened, then check again.`,
    };
  }
  return { ok: false, reason: found.reason || `${agent.name} did not name any models after signing in.` };
}

/**
 * Reads the agent's own sign-in state.
 *
 * `auth status` is JSON, which is the only place an agent says whether a person
 * signed in to their account or is merely being routed through this app's key
 * helper. A router token is not a subscription, and treating it as one would
 * offer models the person cannot actually use.
 */
function parseAuthStatus(text) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || '').trim());
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const method = String(parsed.authMethod || parsed.auth_method || '');
  const source = String(parsed.apiKeySource || parsed.api_key_source || '');
  const loggedIn = Boolean(parsed.loggedIn || parsed.logged_in);
  const routed = ROUTED_METHODS.test(method) || ROUTED_METHODS.test(source);
  const subscribed = loggedIn && !routed && SUBSCRIPTION_METHODS.test(method || source);
  return { loggedIn, method: method || null, source: source || null, subscription: subscribed };
}

/**
 * The model names the agent's own help advertises, read out of its `--model`
 * description rather than written down here. Claude Code for instance lists its
 * aliases and one full name in that line. Nothing is added that the agent did
 * not print itself.
 */
function readModelAliases(helpText) {
  const lines = String(helpText || '').split('\n');
  const at = lines.findIndex((entry) => /^\s*--model\b/.test(entry));
  if (at < 0) return [];
  // Help wraps a long description onto following lines, so the paragraph is
  // read up to the next option rather than only the first line of it.
  const paragraph = [lines[at]];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^\s{0,3}\S/.test(lines[i]) || /^\s*--/.test(lines[i])) break;
    paragraph.push(lines[i]);
  }
  const line = paragraph.join(' ');
  const quoted = [...line.matchAll(/['"`]([A-Za-z0-9][\w.:-]{1,40})['"`]/g)].map((m) => m[1]);
  const out = [];
  for (const name of quoted) {
    if (isForbiddenModelId(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Asks the agent who it thinks it is. Only runs when the agent advertises an
 * `auth` command, so nothing is invoked that the agent does not document.
 */
async function readAuthStatus(agent, { env, binaryPath, run, helpTimeoutMs = HELP_TIMEOUT_MS, statusTimeoutMs = LIST_TIMEOUT_MS } = {}) {
  const run2 = run || runCommand;
  try {
    const authHelp = await run2(binaryPath, ['auth', '--help'], { env, timeoutMs: helpTimeoutMs });
    if (!/status/i.test(`${authHelp.stdout || ''}${authHelp.stderr || ''}`)) return null;
    const status = await run2(binaryPath, AUTH_STATUS_COMMAND.split(' '), { env, timeoutMs: statusTimeoutMs });
    return parseAuthStatus(`${status.stdout || ''}${status.stderr || ''}`);
  } catch {
    return null;
  }
}

function profileState(settings) {
  const section = settings && settings.agents ? settings.agents : {};
  const profiles = section.profiles && typeof section.profiles === 'object' ? section.profiles : {};
  return profiles;
}

function publicAgent(agent, settings, { knownModels = null, discovered = null, builtInModels = null } = {}) {
  const profiles = profileState(settings);
  const saved = profiles[agent.id] || null;
  /*
   * A free agent's models are the ones the free plan includes, so they are
   * listed whether or not anything was asked of a binary, and whether or not the
   * agent is installed yet. A paid agent's are not listed here, because they
   * come with the plan rather than with the agent.
   */
  let found = discovered || null;
  if ((!found || !found.models || !found.models.length) && !agent.paid) {
    const catalog = builtInModels && Array.isArray(builtInModels[agent.id]) ? builtInModels[agent.id] : [];
    if (catalog.length) found = { models: catalog.slice(), source: 'built-in', billed: false };
  }
  return {
    id: agent.id,
    name: agent.name,
    harness: agent.harness,
    kind: agent.kind,
    paid: agent.paid,
    billingLabel: agent.billingLabel,
    needsLogin: agent.needsLogin,
    added: Boolean(saved),
    enabled: Boolean(saved && saved.enabled),
    model: saved && saved.model ? saved.model : 'auto',
    baseUrl: saved && saved.baseUrl ? saved.baseUrl : GATEWAY_BASE_URL,
    ownModels: found && Array.isArray(found.models) ? found.models.slice() : [],
    ownModelsSource: found ? found.source : 'not-checked',
    ownModelsReason: found ? found.reason || null : null,
    subscription: Boolean(found && found.auth && found.auth.subscription),
    authMethod: found && found.auth ? found.auth.method || null : null,
    // Whether this agent's own models need a plan you pay for, which is what
    // decides if they are here now or after signing up.
    ownModelsBilled: Boolean(found && found.billed),
    ownModelsWaiting: Boolean(found && found.source === 'needs-subscription'),
    gatewayModels: knownModels ? knownModels.slice() : [],
  };
}

function listAgents(settings, options = {}) {
  return AGENTS.map((agent) => publicAgent(agent, settings, { ...options, discovered: (options.discovered || {})[agent.id] }));
}

/**
 * Checks a model name against what the router can actually use.
 *
 * An empty list is treated as "nothing is on offer", not as "no information":
 * when the gateway is down the list comes back empty, and treating that as a
 * blank cheque let any plausible looking name be written into a profile. Only
 * 'auto' survives that, which is the right answer anyway, since 'auto' means
 * the router picks whatever is working. Passing no list at all still skips the
 * check, for the paths that genuinely have nothing to compare against.
 */
function validateModel(model, knownModels) {
  const value = String(model == null ? 'auto' : model).trim();
  if (!value || value === 'auto') return 'auto';
  if (isForbiddenModelId(value)) throw badRequest('forbidden_model', `${value} is not a model this router will use.`);
  if (Array.isArray(knownModels)) {
    if (!knownModels.includes(value)) {
      throw badRequest(
        'unknown_model',
        knownModels.length
          ? `${value} is not a model the gateway offers.`
          : `No models are on offer right now, so ${value} cannot be used yet. Leave it on automatic, or check again once the gateway is answering.`,
      );
    }
  }
  return value;
}

function validateBaseUrl(value) {
  if (value === undefined || value === null || value === '') return GATEWAY_BASE_URL;
  return cleanBaseUrl(value, { allowOnlyLoopbackOrGateway: true });
}

function addProfile(settings, agentId, patch = {}, options = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw badRequest('unknown_agent', 'That agent profile does not exist.');
  const current = profileState(settings);
  const existing = current[agent.id] || {};
  const next = {
    ...existing,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : existing.enabled !== false,
    model: patch.model === undefined ? existing.model || 'auto' : validateModel(patch.model, options.knownModels),
    baseUrl: patch.baseUrl === undefined ? existing.baseUrl || GATEWAY_BASE_URL : validateBaseUrl(patch.baseUrl),
    addedAt: existing.addedAt || new Date().toISOString(),
    label: patch.label === undefined ? existing.label : cleanText(patch.label, 60),
  };
  return { ...current, [agent.id]: next };
}

function updateProfile(settings, agentId, patch = {}, options = {}) {
  const agent = getAgent(agentId);
  if (!agent) throw badRequest('unknown_agent', 'That agent profile does not exist.');
  const current = profileState(settings);
  if (!current[agent.id]) throw badRequest('profile_not_added', `Add ${agent.name} to your profiles first.`);
  return addProfile(settings, agentId, patch, options);
}

function removeProfile(settings, agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw badRequest('unknown_agent', 'That agent profile does not exist.');
  const current = profileState(settings);
  if (!current[agent.id]) return current;
  const next = { ...current };
  delete next[agent.id];
  return next;
}

module.exports = {
  AGENTS,
  GATEWAY_BASE_URL,
  getAgent,
  whichBinary,
  appInstalled,
  detect,
  discoverModels,
  findLoginCommand,
  parseAuthStatus,
  readModelAliases,
  shellQuote,
  startLogin,
  profileState,
  publicAgent,
  listAgents,
  validateModel,
  validateBaseUrl,
  addProfile,
  updateProfile,
  removeProfile,
};
