import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { endpoint, zcodeDestination } from '../plugins/agent-bridge/scripts/destination.mjs';

const exec = promisify(execFile);
const bridge = fileURLToPath(new URL('../plugins/agent-bridge/scripts/bridge.mjs', import.meta.url));

test('Z Code destination follows local template and provider override, refusing unknown routing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-destination-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builtin = path.join(root, 'builtin.json'), personal = path.join(root, 'personal.json');
  const config = { config: { providerConfigRules: {
    templateRules: [{ templateId: 'custom', config: { api: { baseUrl: 'https://example.com/inference' } } }],
    providerRules: [{ providerId: 'provider-1', templateId: 'custom', config: { access: { apiKey: 'PRIVATE_SECRET' } } }],
  } } };
  fs.writeFileSync(builtin, JSON.stringify(config));
  fs.writeFileSync(personal, JSON.stringify({ config: {} }));
  const env = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal };
  assert.deepEqual(zcodeDestination('provider-1', env), { provider: 'provider-1', endpoint: 'https://example.com/inference' });
  fs.writeFileSync(personal, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'provider-1', config: { api: { baseUrl: 'https://other.example.com' } } }] } } }));
  assert.equal(zcodeDestination('provider-1', env).endpoint, 'https://other.example.com');
  assert.throws(() => zcodeDestination('missing', env), /Cannot resolve/);
  config.config.modelConfigRules = { modelRules: [{ config: { api: { baseUrl: 'https://hidden.example.com' } } }] };
  fs.writeFileSync(builtin, JSON.stringify(config));
  assert.throws(() => zcodeDestination('provider-1', env), /routing overrides/);
  for (const url of ['https://user:PRIVATE_SECRET@example.com', 'https://example.com?key=PRIVATE_SECRET', 'http://example.com', 'file:///tmp']) assert.throws(() => endpoint(url));
});

test('Claude preflight and CLI missing-reference guard never start the worker or expose credentials', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-claude-preview-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = path.join(root, 'settings.json'), entry = path.join(root, 'worker.mjs'), card = path.join(root, 'card.md');
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'PRIVATE_SECRET' } }));
  fs.writeFileSync(entry, 'throw new Error("worker must not start");'); fs.writeFileSync(card, 'Synthetic task. No source reads.');
  const env = { ...process.env, AGENT_BRIDGE_HOST: 'hermes', CLAUDE_WORKER_SETTINGS: settings, CLAUDE_WORKER_ENTRY: entry };
  const args = ['--project', root, '--task-file', card, '--worker', 'claude', '--provider', 'zhipu', '--model', 'glm-5.3', '--effort', 'high', '--read-scope', '[]', '--mode', 'plan'];
  await assert.rejects(exec(process.execPath, [bridge, 'submit', ...args], { env }), error => { assert.match(error.stdout, /Run prepare first/); return true; });
  assert.equal(fs.existsSync(path.join(root, '.ai')), false);
  const prepared = JSON.parse((await exec(process.execPath, [bridge, 'prepare', ...args], { env })).stdout);
  assert.equal(prepared.host, 'hermes'); assert.equal(prepared.inferenceDispatched, false);
  assert.equal(prepared.destination.endpoint, 'https://open.bigmodel.cn/api/anthropic');
  assert.ok(!JSON.stringify(prepared).includes('PRIVATE_SECRET'));
  assert.ok(!fs.readFileSync(path.join(root, '.ai/preparations', prepared.preparedRef + '.json'), 'utf8').includes('PRIVATE_SECRET'));
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'PRIVATE_SECRET' } }));
  await assert.rejects(exec(process.execPath, [bridge, 'submit', ...args, '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint], { env }), error => { assert.match(error.stdout, /destination changed/); return true; });
  assert.equal(fs.existsSync(path.join(root, '.ai/tasks')), false);
});
