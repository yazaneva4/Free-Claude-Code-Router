'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const launcher = require('../src/main/routed-launcher');
const { Store } = require('../src/main/store');
const { Settings } = require('../src/main/settings');
const helper = require('../src/main/api-key-helper');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fcr-launch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = { agents: { profiles: {} }, gateway: { endpoint: 'http://127.0.0.1:3456' } };
  for (const id of ['claude-code','codex-cli','codex-app']) settings.agents.profiles[id] = { mode: 'fcr', enabled: true, model: 'test-model' };
  return { home, settings, token: 'ccr-profile-launch-fixture', binary: process.execPath, env: { ...process.env, ANTHROPIC_API_KEY: 'native-secret', OPENAI_API_KEY: 'native-secret' } };
}
test('child process uses routed environment, arguments and status without altering the parent', t => {
  const options = fixture(t);
  const out = path.join(options.home, 'result.json');
  const code = `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({env:process.env,args:process.argv.slice(1)}));process.exit(7)`;
  const status = launcher.launch('claude', ['-e',code,'--'], options);
  assert.equal(status,7);
  const result = JSON.parse(fs.readFileSync(out));
  assert.equal(result.env.ANTHROPIC_MODEL,'test-model');
  assert.equal(result.env.ANTHROPIC_AUTH_TOKEN, options.token);
  assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.ANTHROPIC_API_KEY,'native-secret');
  assert.deepEqual(result.args,['--model','test-model']);
  assert.ok(result.env.CLAUDE_CONFIG_DIR.startsWith(options.home));
  assert.equal(fs.existsSync(path.join(options.home,'.claude')),false);
});
test('Codex config is isolated, contains no token, and preserves native files', t => {
  const options = fixture(t);
  fs.mkdirSync(path.join(options.home,'.codex'));
  const native = path.join(options.home,'.codex','config.toml');
  fs.writeFileSync(native,'native sentinel');
  const plan = launcher.prepare('codex',[],options);
  const config = fs.readFileSync(path.join(plan.env.CODEX_HOME,'config.toml'),'utf8');
  assert.match(config,/wire_api = "responses"/);
  assert.match(config,/base_url = "http:\/\/127.0.0.1:3456\/v1"/);
  assert.ok(!config.includes(options.token));
  assert.equal(plan.env.FCR_GATEWAY_TOKEN,options.token);
  assert.equal(plan.env.OPENAI_API_KEY,undefined);
  assert.equal(fs.readFileSync(native,'utf8'),'native sentinel');
});
test('missing, deleted, native, disabled and model-less profiles cannot launch', t => {
  const o = fixture(t);
  for (const profile of [undefined,{mode:'native',enabled:true,model:'test'}, {mode:'fcr',enabled:false,model:'test'}, {mode:'fcr',enabled:true,model:null}]) {
    o.settings.agents.profiles['claude-code'] = profile;
    assert.throws(() => launcher.prepare('claude',[],o));
  }
});
test('empty providers and deleted profiles stay empty after save, reload and restart', t => {
  const o=fixture(t), store=new Store(o.home), settings=new Settings({store});
  assert.deepEqual(settings.get().providers,{});
  assert.equal(settings.get().routing.preferredProvider,null);
  settings.setProvider('ollama',{enabled:true});
  settings.setAgentProfiles(o.settings.agents.profiles);
  settings.save({...settings.get(),providers:{},agents:{profiles:{}}});
  const restarted = new Settings({store}).get();
  assert.deepEqual(restarted.providers,{});
  assert.deepEqual(restarted.agents.profiles,{});
  assert.deepEqual(restarted.routing.fallbackOrder,[]);
});
test('repair leaves native Claude settings unchanged even with a missing helper', t=>{
  const o=fixture(t), dir=path.join(o.home,'.claude');fs.mkdirSync(dir);
  const file=path.join(dir,'settings.json');const text=JSON.stringify({apiKeyHelper:path.join(o.home,'.claude-code-router','bin','ccr-claude-code-api-key-missing')});
  fs.writeFileSync(file,text);helper.repairHelper({home:o.home});assert.equal(fs.readFileSync(file,'utf8'),text);
});
test('terminal commands quote paths on macOS and Windows, without embedding tokens', t=>{
  const o=fixture(t);
  const mac=launcher.terminalPlan('claude-code',{...o,platform:'darwin',node:"/tmp/a b/it's node"});
  assert.equal(mac.binary,'osascript');assert.ok(mac.args[1].includes('ELECTRON_RUN_AS_NODE=1'));
  assert.ok(!mac.args.join(' ').includes(o.token));
  const win=launcher.terminalPlan('codex-cli',{...o,platform:'win32',node:"C:\\a b\\it's node.exe"});
  const script=Buffer.from(win.args.at(-1),'base64').toString('utf16le');
  assert.ok(script.includes("it''s node.exe"));assert.ok(!script.includes(o.token));
  const linux=launcher.terminalPlan('claude-code',{...o,platform:'linux',which:n=>n==='gnome-terminal'?'/usr/bin/gnome-terminal':null});
  assert.equal(linux.args[0],'--');
  assert.throws(()=>launcher.terminalPlan('claude-code',{...o,platform:'linux',which:()=>null}),/terminal emulator/);
});
test('UI Run waits for successful terminal launch and propagates launcher errors', async t=>{
 const o=fixture(t);let calls=0;
 const ok=await launcher.runProfile('claude-code',{...o,platform:'darwin',execFile:(_b,_a,_o,cb)=>{calls++;cb(null);}});
 assert.equal(ok.launched,true);assert.equal(calls,1);
 await assert.rejects(launcher.runProfile('claude-code',{...o,platform:'darwin',execFile:(_b,_a,_o,cb)=>cb(new Error('Terminal failed'))}),/Terminal failed/);
});
test('Codex desktop gets its own scoped config and unsupported launchers explain why',t=>{
 const o=fixture(t);const p=launcher.prepare('codex-app',[],{...o,platform:'darwin'});
 assert.ok(p.env.CODEX_HOME.endsWith('codex-app'));
 assert.ok(launcher.support('claude-app'));assert.ok(launcher.support('gemini-cli'));
 assert.ok(launcher.support('codex-app','win32'));
});
