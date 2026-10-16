'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');
const agents = require('./agents');
const { currentToken } = require('./api-key-helper');
const { badRequest } = require('./validators');

const ALIASES = { claude: 'claude-code', codex: 'codex-cli', 'codex-app': 'codex-app' };
function readSettings(home, env) {
  const file = path.join(env.CCR_AUTH_DIR || path.join(home, '.claude-code-router', 'auth'), 'settings.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw badRequest('not_configured', 'Open the router and manually add a routed agent profile first.'); }
}
function support(agentId, platform = process.platform) {
  if (['claude-code', 'codex-cli'].includes(agentId)) return null;
  if (agentId === 'codex-app' && platform === 'darwin') return null;
  return agentId === 'codex-app' ? 'Codex desktop Run currently supports macOS.' : 'This app does not expose a supported isolated router launcher.';
}
function prepare(agentId, args = [], options = {}) {
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const env = { ...(options.env || process.env) };
  require('./agent-env').ensureAgentPath(env, home);
  const agent = agents.getAgent(ALIASES[agentId] || agentId);
  if (!agent) throw badRequest('unknown_agent', 'Use fcr claude, fcr codex, or fcr codex-app.');
  const settings = options.settings || readSettings(home, env);
  const profile = agents.profileState(settings)[agent.id];
  if (!profile || profile.mode !== 'fcr' || profile.enabled === false) throw badRequest('not_configured', 'Manually add and enable this agent in FCR mode before running it.');
  if (support(agent.id, platform)) throw badRequest('unsupported_launcher', support(agent.id, platform));
  if (!profile.model) throw badRequest('model_required', 'Choose and save a model for this profile before running it.');
  const token = options.token || currentToken(home);
  if (!token) throw badRequest('gateway_not_configured', 'Configure the router gateway before running this profile.');
  const endpoint = agents.validateBaseUrl(profile.baseUrl || settings.gateway?.endpoint);
  const root = path.join(home, '.claude-code-router', 'sessions', agent.id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  delete env.ELECTRON_RUN_AS_NODE;
  let binary;
  let launchArgs = args.slice();
  if (agent.id === 'claude-code') {
    env.CLAUDE_CONFIG_DIR = root;
    env.ANTHROPIC_BASE_URL = endpoint;
    env.ANTHROPIC_AUTH_TOKEN = token;
    env.ANTHROPIC_MODEL = profile.model;
    delete env.ANTHROPIC_API_KEY;
    for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    binary = options.binary || agents.whichBinary('claude', env);
    launchArgs.push('--model', profile.model);
  } else {
    env.CODEX_HOME = root;
    env.FCR_GATEWAY_TOKEN = token;
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    // A separate user-level config keeps the native Codex profile untouched.
    const config = `model = ${JSON.stringify(profile.model)}\nmodel_provider = "fcr"\n[model_providers.fcr]\nname = "FCR"\nbase_url = ${JSON.stringify(endpoint.replace(/\/$/, '') + '/v1')}\nenv_key = "FCR_GATEWAY_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\n`;
    fs.writeFileSync(path.join(root, 'config.toml'), config, { mode: 0o600 });
    if (agent.id === 'codex-app') {
      launchArgs.unshift('--user-data-dir=' + path.join(root, 'app-data'));
      const bundles = [path.join(home, 'Applications', 'Codex.app'), '/Applications/Codex.app'];
      binary = options.binary || bundles.map(p => path.join(p, 'Contents', 'MacOS', 'Codex')).find(p => fs.existsSync(p));
    } else binary = options.binary || agents.whichBinary('codex', env);
  }
  if (!binary) throw badRequest('not_installed', `${agent.name} is not installed or is not on PATH.`);
  return { binary, args: launchArgs, env, agentId: agent.id };
}
function psQuote(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }
function powershellCommand(binary, args) { return '& ' + [binary, ...args].map(psQuote).join(' '); }
function launch(agentId, args = [], options = {}) {
  const plan = prepare(agentId, args, options);
  const platform = options.platform || process.platform;
  let result;
  // Windows npm shims need a command interpreter. PowerShell receives a literal
  // encoded script, never an interpolated cmd.exe command string.
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(plan.binary)) {
    const encoded = Buffer.from(powershellCommand(plan.binary, plan.args) + '; exit $LASTEXITCODE', 'utf16le').toString('base64');
    result = (options.spawn || spawnSync)('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], { env: plan.env, stdio: 'inherit', shell: false });
  } else result = (options.spawn || spawnSync)(plan.binary, plan.args, { env: plan.env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  return result.status === null ? 1 : result.status;
}
function terminalPlan(agentId, options = {}) {
  const platform = options.platform || process.platform;
  const env = { ...(options.env || process.env), ELECTRON_RUN_AS_NODE: '1' };
  const node = options.node || process.execPath;
  const cli = path.join(__dirname, '..', '..', 'scripts', 'fcr-cli.js');
  const command = [node, cli, agentId];
  if (platform === 'darwin') {
    const vars = ['ELECTRON_RUN_AS_NODE=1', ...(env.CCR_AUTH_DIR ? [`CCR_AUTH_DIR=${env.CCR_AUTH_DIR}`] : [])];
    const script = ['/usr/bin/env', ...vars, ...command].map(agents.shellQuote).join(' ');
    return { binary: 'osascript', args: ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'], env, wait: true };
  }
  if (platform === 'win32') {
    const vars = "$env:ELECTRON_RUN_AS_NODE='1'; " + (env.CCR_AUTH_DIR ? `$env:CCR_AUTH_DIR=${psQuote(env.CCR_AUTH_DIR)}; ` : '');
    const script = vars + powershellCommand(node, [cli, agentId]);
    return { binary: 'powershell.exe', args: ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env };
  }
  const which = options.which || agents.whichBinary;
  for (const [name, flag] of [['x-terminal-emulator','-e'], ['gnome-terminal','--'], ['konsole','-e'], ['xfce4-terminal','-x'], ['xterm','-e']]) {
    const binary = which(name, env);
    if (binary) return { binary, args: [flag, ...command], env };
  }
  throw badRequest('terminal_unavailable', 'Install a terminal emulator or run fcr in your terminal.');
}
async function runProfile(agentId, options = {}) {
  const plan = prepare(agentId, [], options); // Validate before opening a window.
  if (plan.agentId === 'codex-app') {
    await new Promise((resolve, reject) => {
      const child = (options.spawnAsync || spawn)(plan.binary, plan.args, { env: plan.env, detached: true, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  } else {
    const terminal = terminalPlan(plan.agentId, options);
    if (terminal.wait) await new Promise((resolve, reject) => (options.execFile || execFile)(terminal.binary, terminal.args, { env: terminal.env, timeout: 20000 }, err => err ? reject(err) : resolve()));
    else await new Promise((resolve, reject) => {
      const child = (options.spawnAsync || spawn)(terminal.binary, terminal.args, { env: terminal.env, detached: true, stdio: 'ignore' });
      child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  return { launched: true, note: `Opened routed ${agents.getAgent(plan.agentId).name}.` };
}
module.exports = { prepare, launch, terminalPlan, runProfile, support, readSettings, psQuote };
