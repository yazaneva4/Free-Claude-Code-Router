'use strict';

const GATEWAY_BASE_URL = 'http://127.0.0.1:3456';

const HARNESSES = [
  {
    id: 'claude-app',
    name: 'Claude',
    kind: 'app',
    target: { kind: 'app', name: 'claude' },
    billing: 'required',
    billingLabel: 'Paid Anthropic plan',
    note: 'Traffic is routed through Claude Code Router, so no Anthropic sign-in is collected here.',
    builtInModels: [],
  },
  {
    id: 'codex-app',
    name: 'Codex',
    kind: 'app',
    target: { kind: 'app', name: 'codex' },
    billing: 'required',
    billingLabel: 'Paid OpenAI plan',
    note: 'Traffic is routed through Claude Code Router, so no OpenAI sign-in is collected here.',
    builtInModels: [],
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'cli',
    target: { kind: 'cli', name: 'claudeCode' },
    billing: 'required',
    billingLabel: 'Anthropic Pro or Max',
    note: 'Traffic is routed through Claude Code Router, so no Anthropic sign-in is collected here.',
    builtInModels: [],
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    kind: 'cli',
    target: { kind: 'cli', name: 'codex' },
    billing: 'required',
    billingLabel: 'ChatGPT Plus or Pro',
    note: 'Traffic is routed through Claude Code Router, so no OpenAI sign-in is collected here.',
    builtInModels: [],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    kind: 'cli',
    target: { kind: 'cli', name: 'gemini' },
    billing: 'free',
    billingLabel: 'Free Google AI Studio key',
    note: 'Runs on the free tier, so it keeps its own built-in models.',
    builtInModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
];

const BY_ID = new Map(HARNESSES.map((harness) => [harness.id, harness]));

function getHarness(harnessId) {
  return BY_ID.get(String(harnessId || '').trim()) || null;
}

function publicHarness(harness, state) {
  const current = state || {};
  const builtInModels = harness.builtInModels.slice();
  return {
    id: harness.id,
    name: harness.name,
    kind: harness.kind,
    target: { ...harness.target },
    billing: harness.billing,
    billingLabel: harness.billingLabel,
    note: harness.note,
    builtInModels,
    enabled: Boolean(current.enabled),
    model: current.model || null,
    configPath: current.configPath || null,
  };
}

function catalog(settings) {
  const integrations = (settings && settings.integrations) || {};
  return HARNESSES.map((harness) => {
    const group = integrations[harness.target.kind] || {};
    return publicHarness(harness, group[harness.target.name] || {});
  });
}

function applySelections(settings, selections) {
  const wanted = selections && typeof selections === 'object' ? selections : {};
  const applied = [];
  for (const harness of HARNESSES) {
    const choice = wanted[harness.id];
    if (!choice || typeof choice !== 'object') continue;
    const patch = { baseUrl: GATEWAY_BASE_URL };
    if (typeof choice.enabled === 'boolean') patch.enabled = choice.enabled;
    if (harness.builtInModels.length) {
      const model = String(choice.model || '');
      if (harness.builtInModels.includes(model)) patch.model = model;
    }
    settings.setIntegration(harness.target.kind, harness.target.name, patch);
    applied.push({ id: harness.id, ...patch });
  }
  return { applied, settings: settings.get() };
}

module.exports = { HARNESSES, GATEWAY_BASE_URL, getHarness, publicHarness, catalog, applySelections };
