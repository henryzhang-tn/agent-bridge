#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { entryFor } from './workers.mjs';

export function configuredClaude() {
  const settingsPath = process.env.CLAUDE_WORKER_SETTINGS || path.join(os.homedir(), '.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // Reuse only the configured inference credentials in memory. Do not import
  // global hooks, permission bypass settings or unrelated plugin configuration.
  const env = settings.env || {};
  const base = env.ANTHROPIC_BASE_URL;
  const secret = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (!base || !secret) throw new Error('Claude Code third-party inference is not configured in settings.json');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) throw new Error('Unsupported credential-bearing inference URL');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Remote inference requires HTTPS');
  const provider = ['open.bigmodel.cn', 'api.z.ai'].includes(url.hostname) ? 'zhipu' : url.hostname;
  const configuredModels = [...new Set(Object.entries(env).filter(([k]) => /(?:_MODEL|_MODEL_OPTION)$/.test(k)).map(([, v]) => v).filter(v => typeof v === 'string' && v.trim()))];
  return { base: base.replace(/\/$/, ''), secret, provider, configuredModels };
}

export async function catalog(config) {
  let models = config.configuredModels, source = 'local-config', catalogStatus = null;
  try {
    const response = await fetch(config.base + '/v1/models', {
      headers: { Authorization: 'Bearer ' + config.secret, 'x-api-key': config.secret, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    catalogStatus = response.status;
    if (response.ok) {
      const body = await response.json();
      const remote = (Array.isArray(body.data) ? body.data : []).map(x => x.id).filter(x => typeof x === 'string');
      if (remote.length) { models = remote; source = 'provider-catalog'; }
    }
  } catch { catalogStatus = 'unavailable'; }
  return { worker: 'claude', runtime: 'Claude Code', provider: config.provider, catalogSource: source, catalogStatus,
    models: models.map(model => ({ provider_id: config.provider, model,
      reasoning_levels: /glm-5\.3/i.test(model) ? ['low', 'high', 'max'] : ['provider-default'] })),
    effortTransport: 'Explicit levels use output_config.effort; provider-default leaves unverified older-model controls at the provider default.',
    note: 'Model IDs are discovered without inference. Local-config entries are not proof of account entitlement. This runs a new Claude Code session, not an existing Desktop conversation.' };
}

export function claudeInvocation(state, config, prompt) {
  const tools = state.mode === 'plan' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write';
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|MAX_THINKING_TOKENS$)/.test(key)) delete env[key];
  Object.assign(env, { ANTHROPIC_BASE_URL: config.base, ANTHROPIC_API_KEY: config.secret, ANTHROPIC_AUTH_TOKEN: config.secret,
    ANTHROPIC_MODEL: state.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: state.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: state.model, ANTHROPIC_DEFAULT_OPUS_MODEL: state.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_AUTO_COMPACT: '1', NO_COLOR: '1',
  });
  if (state.effort !== 'provider-default') Object.assign(env, {
    CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1', CLAUDE_CODE_EFFORT_LEVEL: state.effort,
    ANTHROPIC_CUSTOM_MODEL_OPTION: state.model,
    ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: 'effort,max_effort,thinking',
  });
  const args = ['--bare', '--print', '--output-format', 'json', '--no-session-persistence',
    '--setting-sources', '', '--settings', JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--no-chrome',
    '--model', state.model, ...(state.effort === 'provider-default' ? [] : ['--effort', state.effort]),
    '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', tools,
    '--max-turns', '24', '--append-system-prompt', prompt];
  return { args, env };
}

async function main() {
  const config = configuredClaude();
  const redact = value => value.split(config.secret).join('[redacted]');
  if (process.argv[2] !== '--models') {
    const state = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'state.json'), 'utf8'));
    if (state.destination && (state.destination.provider !== config.provider || state.destination.endpoint !== new URL(config.base).href.replace(/\/$/, ''))) throw new Error('Inference destination changed before Claude startup; prepare again.');
  }
  const available = await catalog(config);
  if (process.argv[2] === '--models') { fs.writeSync(1, JSON.stringify(available) + '\n'); return; }
  const job = process.argv[2];
  const state = JSON.parse(fs.readFileSync(path.join(job, 'state.json'), 'utf8'));
  const selected = available.models.find(x => x.provider_id === state.provider && x.model === state.model);
  if (!selected || !selected.reasoning_levels.includes(state.effort)) throw new Error('Claude model/provider/effort is unavailable; refresh list_models.');
  const prompt = fs.readFileSync(path.join(job, 'prompt.md'), 'utf8');
  const { args, env } = claudeInvocation(state, config, prompt);
  const entry = state.entry || entryFor('claude');
  const child = spawn(/\.(?:m?js|cjs)$/.test(entry) ? process.execPath : entry,
    /\.(?:m?js|cjs)$/.test(entry) ? [entry, ...args] : args,
    { cwd: state.project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  process.once('SIGTERM', () => { child.kill('SIGTERM'); process.exit(143); });
  let stdout = '', stderr = '', size = 0;
  const capture = target => data => {
    size += data.length;
    if (size > 16 * 1024 * 1024) { child.kill('SIGTERM'); return; }
    if (target === 'out') stdout += data; else stderr += data;
  };
  child.stdout.on('data', capture('out')); child.stderr.on('data', capture('err'));
  child.stdin.on('error', () => {});
  child.stdin.end('Complete the assigned task:\n\n' + fs.readFileSync(path.join(job, 'task.md'), 'utf8'));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (stderr) fs.writeSync(2, redact(stderr).slice(-12000));
  let raw;
  try { raw = JSON.parse(stdout.trim()); } catch { throw new Error('Claude returned no valid JSON result; inspect local stderr.log.'); }
  const notes = [];
  if (exitCode !== 0 || raw.is_error) notes.push('Claude failed: ' + (raw.subtype || 'nonzero exit'));
  if (raw.permission_denials?.length) notes.push('Claude denied ' + raw.permission_denials.length + ' tool request(s); the host must handle the blocked actions.');
  const actualModels = Object.keys(raw.modelUsage || {});
  if (actualModels.some(x => x.toLowerCase() !== state.model.toLowerCase())) notes.push('Claude reported a different model: ' + actualModels.join(', '));
  const response = typeof raw.result === 'string' && raw.result.trim() ? raw.result : '';
  if (!response) notes.push('Claude returned no final text.');
  const result = { jobId: state.id, worker: 'claude', sessionId: raw.session_id || state.id,
    response: redact(response || notes.join('; ')), notes,
    model: { providerId: state.provider, modelId: state.model, options: { reasoningLevel: state.effort } },
    providerLabel: 'Claude Code / configured ' + config.provider,
    usage: raw.usage ? { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens,
      cacheReadTokens: raw.usage.cache_read_input_tokens, cacheCreationTokens: raw.usage.cache_creation_input_tokens,
      modelUsage: Object.fromEntries(Object.entries(raw.modelUsage || {}).map(([model, x]) => [model, {
        inputTokens: x.inputTokens, outputTokens: x.outputTokens, cacheReadTokens: x.cacheReadInputTokens,
        cacheCreationTokens: x.cacheCreationInputTokens,
      }])), turns: raw.num_turns } : null,
    projection: { status: notes.length ? 'error' : 'idle' } };
  fs.writeFileSync(path.join(job, 'adapter-result.json'), JSON.stringify(result), { mode: 0o600 });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { fs.writeSync(2, 'Claude adapter: ' + e.message + '\n'); process.exitCode = 1; });
}
