// Read-only acceptance of the installed MCP surface; never dispatches inference.
// node verify-installed.mjs CONFIG PROJECT REPORT [EXISTING_JOB...]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const [configPath, project, reportPath, ...jobs] = process.argv.slice(2);
assert(configPath && project && reportPath);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.agent_bridge;
const root = path.dirname(configPath);
const pluginRoot = fs.existsSync(path.join(root, 'scripts')) ? root : path.dirname(root);
const expand = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
const expanded = expand(config.command);
const command = expanded.startsWith('.') ? path.resolve(pluginRoot, expanded) : expanded;
const child = spawn(command, (config.args || []).map(expand), { cwd: path.resolve(pluginRoot, config.cwd || '.'), env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let next = 0;
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const m = JSON.parse(line), p = pending.get(m.id);
  if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout')); }, 55000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, result.content?.[0]?.text);
  return result.structuredContent;
};
try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-acceptance', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await rpc('tools/list', {});
  const tools = listed.tools.map(x => x.name);
  for (const name of ['list_workers', 'list_models', 'prepare_dispatch', 'dispatch_task', 'task_status', 'task_result', 'record_review', 'continue_task', 'cancel_task', 'recover_result']) assert(tools.includes(name));
  const workers = (await call('list_workers', {})).workers;
  const catalogs = [];
  for (const worker of workers) {
    assert.equal(worker.installed, true);
    const catalog = await call('list_models', { worker: worker.worker, project });
    assert.ok(catalog.models.length > 0);
    catalogs.push(catalog);
  }
  const results = [];
  for (const job of jobs) {
    const r = await call('task_result', { job });
    assert.equal(r.status, 'ready_for_review');
    assert.ok(r.summary?.trim());
    results.push({ worker: r.worker, job, status: r.status, provider: r.provider, model: r.model, effort: r.effort, sessionId: r.sessionId });
  }
  const report = { at: new Date().toISOString(), installedConfig: configPath, tools, workers, catalogs, results, inferenceDispatched: false };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, tools, catalogs: catalogs.map(c => ({ worker: c.worker, models: c.models.length })), results, inferenceDispatched: false }));
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  lines.close(); child.stdin.end(); child.kill();
}
