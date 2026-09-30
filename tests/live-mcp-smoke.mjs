// Explicit opt-in live check; excluded from *.test.mjs offline tests.
// Usage: node live-mcp-smoke.mjs INSTALLED_MCP_CONFIG PROJECT REPORT PROVIDER MODEL EFFORT WORKER [REQUEST_ID] [TASK_FILE]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const [configPath, project, reportPath, provider, model, effort, worker, requestId, taskFile] = process.argv.slice(2);
assert(configPath && project && reportPath && provider && model && effort && worker, 'All arguments are required; model configuration is explicit.');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')).mcpServers.agent_bridge;
const root = path.dirname(configPath);
const pluginRoot = fs.existsSync(path.join(root, 'scripts')) ? root : path.dirname(root);
const expand = value => value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
const cwd = path.resolve(pluginRoot, config.cwd || '.');
const expanded = expand(config.command);
const command = expanded.startsWith('.') ? path.resolve(pluginRoot, expanded) : expanded;
const child = spawn(command, (config.args || []).map(expand), { cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
let next = 0, job;
const pending = new Map();
const lines = readline.createInterface({ input: child.stdout });
lines.on('line', line => {
  const m = JSON.parse(line); const p = pending.get(m.id);
  if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
child.on('error', e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); });
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++next;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timed out: ' + method)); }, 55000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
};
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-bridge-validation', version: '0.2.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list', {});
  assert.ok(list.tools.some(x => x.name === 'list_workers'));
  const runtimes = await call('list_workers', {});
  assert(runtimes.workers.some(x => x.worker === worker && x.installed), 'Selected worker runtime must be installed');
  const catalog = await call('list_models', { worker, project });
  const selected = catalog.models.find(x => x.provider_id === provider && x.model === model);
  assert(selected?.reasoning_levels.includes(effort), 'Explicit selection must be available');
  const selection_reason = taskFile
    ? 'Bounded synthetic function repair with explicit tests and one allowed file; choose Flash and low effort, then independently validate.'
    : 'This is a bounded connection-marker task with no implementation; choose the available Flash model and low effort to limit overhead.';
  const request = {
    worker, project, provider, model, effort, mode: taskFile ? 'edit' : 'plan', selection_reason, timeout_seconds: 90,
    read_scope: taskFile ? ['.'] : [],
    ...(requestId ? { request_id: requestId } : {}),
    task: taskFile ? fs.readFileSync(taskFile, 'utf8') : 'Synthetic MCP connectivity check only. Do not read or modify project files, run commands, use tools, or contact any other service. Return exactly AGENT_BRIDGE_PLUGIN_CONNECTED as your final answer.',
  };
  const { request_id, ...preview } = request;
  const prepared = await call('prepare_dispatch', preview);
  // Explicitly invoked live script: caller must already authorize this destination and task scope.
  request.prepared_ref = prepared.preparedRef;
  request.endpoint = prepared.destination.endpoint;
  const submitted = await call('dispatch_task', request);
  job = submitted.job;
  if (requestId) {
    assert.equal(submitted.reused, false, 'Use a new request ID for a new live acceptance run.');
    const repeated = await call('dispatch_task', request);
    assert.equal(repeated.job, job); assert.equal(repeated.reused, true);
  }
  let status = submitted;
  const deadline = Date.now() + 120000;
  while (['queued', 'running', 'cancelling', 'orphaned'].includes(status.status) && Date.now() < deadline) {
    status = await call('task_status', { job, wait_seconds: 30 });
  }
  assert.equal(status.status, 'ready_for_review');
  const result = await call('task_result', { job });
  assert.equal(result.summary.trim(), 'AGENT_BRIDGE_PLUGIN_CONNECTED');
  assert.equal(result.model, model); assert.equal(result.provider, provider); assert.equal(result.effort, effort);
  assert.equal(result.selectionReason, selection_reason);
  assert.equal(result.selectedModel.modelId, model);
  assert.equal(result.selectedModel.options.reasoningLevel, effort);
  if (requestId) {
    const repeated = await call('dispatch_task', request);
    assert.equal(repeated.job, job); assert.equal(repeated.reused, true);
    assert.deepEqual((await call('task_result', { job })).usage, result.usage);
  }
  const report = { at: new Date().toISOString(), installedConfig: configPath, server: init.serverInfo,
    tools: list.tools.map(x => x.name), catalog, result, duplicateRequestReused: !!requestId };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ report: reportPath, status: result.status, model, effort, job, summary: result.summary.trim(), usage: result.usage }));
} catch (e) {
  if (job) { try { await call('cancel_task', { job }); } catch {} }
  throw e;
} finally {
  for (const p of pending.values()) clearTimeout(p.timer);
  lines.close(); child.stdin.end(); child.kill();
}
