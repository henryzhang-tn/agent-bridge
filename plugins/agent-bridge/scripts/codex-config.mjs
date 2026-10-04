// Ask Codex to resolve its own configuration. Never read auth files or persist
// configuration/account responses; return only the routing metadata we need.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { entryFor } from './workers.mjs';

export function workerConfigOverrides(config) {
  const overrides = { 'features.multi_agent': false, 'hooks.enabled': false, web_search: 'disabled' };
  const omitNull = value => Array.isArray(value) ? value.filter(v => v !== null).map(omitNull)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, omitNull(v)])) : value;
  // Pass complete tables. RPC config keys split on dots without TOML quote
  // parsing, so quoting names would create extra invalid MCP server entries.
  for (const section of ['mcp_servers', 'plugins', 'apps']) overrides[section] = Object.fromEntries(
    Object.entries(config[section] || {}).map(([name, value]) => [name, { ...omitNull(value), enabled: false }]));
  overrides.apps._default = { ...overrides.apps._default, enabled: false };
  return overrides;
}

export function routingFromConfig(config, account, env = process.env, requestedProvider) {
  const provider = config.model_provider || 'openai';
  if (requestedProvider && requestedProvider !== provider) throw new Error('Selected Codex provider is not the active default; refresh discovery.');
  const configured = config.model_providers?.[provider] || {};
  let base = configured.base_url;
  if (!base && provider === 'openai') {
    base = config.openai_base_url || env.OPENAI_BASE_URL;
    if (!base && account?.type === 'chatgpt') {
      // Codex's effective ChatGPT service base already includes backend-api.
      const service = config.chatgpt_base_url || 'https://chatgpt.com/backend-api';
      base = service.replace(/\/+$/, '').endsWith('/codex') ? service : service.replace(/\/+$/, '') + '/codex';
    } else if (!base && account?.type === 'apiKey') base = 'https://api.openai.com/v1';
  }
  if (!base) throw new Error('Cannot resolve the selected Codex inference destination from its effective configuration and login mode.');
  return { provider, base, authMode: account?.type || null };
}

export async function readCodexConfiguration(project, env = process.env) {
  const entry = entryFor('codex');
  const script = /\.(?:m?js|cjs)$/.test(entry);
  const child = spawn(script ? process.execPath : entry, [...(script ? [entry] : []), 'app-server'], {
    cwd: project, env: { ...env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map(); let nextId = 0, fatal;
  const fail = () => {
    fatal = new Error('Codex configuration is unavailable; inspect the local runtime configuration.');
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(fatal); }
    pending.clear();
  };
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { fail(); return; }
    const p = pending.get(msg.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(msg.id);
    msg.error ? p.reject(new Error('Codex configuration RPC failed.')) : p.resolve(msg.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (fatal) return reject(fatal);
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex configuration RPC timed out.')); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  try {
    await request('initialize', { clientInfo: { name: 'agent-bridge-preflight', version: JSON.parse(fs.readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const { config } = await request('config/read', { cwd: project, includeLayers: false });
    const { account } = await request('account/read', { refreshToken: false });
    return { config, account: account ? { type: account.type } : null };
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear(); lines.close(); child.stdin.end(); child.kill('SIGTERM');
  }
}
