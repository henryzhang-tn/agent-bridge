import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = path.join(root, 'plugins/agent-bridge');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const exec = promisify(execFile);

async function connect(t, config, host) {
  const expand = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', plugin);
  const command = expand(config.command);
  const child = spawn(command.startsWith('.') ? path.resolve(plugin, command) : command,
    (config.args || []).map(expand), { cwd: os.tmpdir(), env: { ...process.env, ...config.env, AGENT_BRIDGE_NODE_PATH: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let next = 0;
  const lines = readline.createInterface({ input: child.stdout });
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  child.on('error', fail); child.on('exit', () => fail(new Error('Host server exited')));
  lines.on('line', line => {
    const response = JSON.parse(line), p = pending.get(response.id);
    if (p) { clearTimeout(p.timer); pending.delete(response.id); response.error ? p.reject(new Error(response.error.message)) : p.resolve(response.result); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('Host handshake timed out')); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(() => { fail(new Error('Test ended')); lines.close(); child.stdin.end(); child.kill(); });
  // Client-supplied identity must not overwrite configured host or grant consent.
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'untrusted-other-host', version: '1' } });
  assert.match(init.instructions, new RegExp(host + ' host agent'));
  const tools = (await rpc('tools/list', {})).tools;
  assert.equal(tools.length, 8);
  const listed = await rpc('tools/call', { name: 'list_workers', arguments: {} });
  assert.equal(listed.structuredContent.host, host);
  assert.ok(tools.some(x => x.name === 'prepare_dispatch'));
}

test('Codex, Claude and Z Code package entry points start the shared server from another directory', async t => {
  for (const host of ['codex', 'claude', 'zcode']) {
    const manifest = json(path.join(plugin, `.${host}-plugin/plugin.json`));
    const declared = typeof manifest.mcpServers === 'string' ? json(path.join(plugin, manifest.mcpServers)).mcpServers : manifest.mcpServers;
    await t.test(host, child => connect(child, declared.agent_bridge, host));
  }
});

test('Hermes and generic host configuration is usable and does not mutate host settings', async t => {
  for (const host of ['hermes', 'generic']) {
    const { stdout } = await exec(process.execPath, [path.join(root, 'scripts/host-config.mjs'), host]);
    const generated = JSON.parse(stdout);
    const config = (generated.mcp_servers || generated.mcpServers).agent_bridge;
    if (host === 'hermes') assert.deepEqual(generated.skills.external_dirs, [path.join(plugin, 'skills')]);
    await t.test(host, child => connect(child, config, host));
  }
});
