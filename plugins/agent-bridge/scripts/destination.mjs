import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configuredClaude } from './claude-adapter.mjs';
import { entryFor } from './workers.mjs';

export const HOSTS = ['codex', 'claude', 'zcode', 'hermes', 'generic'];
export function hostName() {
  const host = process.env.AGENT_BRIDGE_HOST || 'generic';
  if (!HOSTS.includes(host)) throw new Error('Unsupported AGENT_BRIDGE_HOST');
  return host;
}

export function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Inference destination is unavailable; inspect the worker configuration locally.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('Credential-bearing inference URLs are unsupported');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Remote inference requires HTTPS');
  return url.href.replace(/\/$/, '');
}

export function zcodeDestination(provider, env) {
  const files = [...new Set([env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || path.join(os.homedir(), '.zcode/v2/provider_config.json')].filter(Boolean))];
  const templates = new Map(), providers = new Map();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    let config;
    try { config = JSON.parse(fs.readFileSync(file, 'utf8')).config; } catch { throw new Error('Invalid local Z Code provider configuration; inspect it locally.'); }
    // Unknown per-model routing cannot be safely represented as one destination.
    for (const rules of Object.values(config?.modelConfigRules || {})) {
      if (Array.isArray(rules) && rules.some(r => r.config?.api || r.config?.baseUrl || r.config?.endpoint)) throw new Error('Z Code has per-model routing overrides; destination preflight is unsupported for this configuration.');
    }
    for (const r of config?.providerConfigRules?.templateRules || []) templates.set(r.templateId, { ...templates.get(r.templateId), ...r });
    for (const r of config?.providerConfigRules?.providerRules || []) {
      const previous = providers.get(r.providerId);
      providers.set(r.providerId, { ...previous, ...r, config: { ...previous?.config, ...r.config,
        api: { ...previous?.config?.api, ...r.config?.api } } });
    }
  }
  const selected = providers.get(provider);
  const base = selected?.config?.api?.baseUrl || templates.get(selected?.templateId)?.config?.api?.baseUrl;
  if (!base) throw new Error('Cannot resolve the selected Z Code provider destination from local configuration.');
  return { provider, endpoint: endpoint(base) };
}

export async function destinationFor(worker, provider, env = process.env) {
  let result;
  if (worker === 'claude') {
    let config;
    try { config = configuredClaude(); } catch { throw new Error('Claude inference configuration is unavailable or invalid; inspect the local worker settings.'); }
    result = { provider: config.provider, endpoint: endpoint(config.base) };
  } else if (worker === 'hermes') {
    const adapter = new URL('./hermes-adapter.py', import.meta.url);
    let stdout;
    try { ({ stdout } = await promisify(execFile)(entryFor(worker), [fileURLToPath(adapter), '--destination'], { env, timeout: 10000, maxBuffer: 16384 })); }
    catch { throw new Error('Hermes inference configuration is unavailable or unsupported; inspect the local worker settings.'); }
    const config = JSON.parse(stdout);
    result = { provider: config.provider, endpoint: endpoint(config.endpoint) };
  } else result = zcodeDestination(provider, env);
  if (result.provider !== provider) throw new Error('Selected provider differs from the configured worker destination; refresh discovery.');
  return result;
}
