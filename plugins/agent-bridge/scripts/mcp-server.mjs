#!/usr/bin/env node
// MCP stdio transport: one JSON-RPC message per line; stdout is protocol-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostName } from './destination.mjs';

const bridge = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version;
const exec = promisify(execFile);
const text = (description, maxLength = 500) => ({ type: 'string', minLength: 1, maxLength, description });
const project = text('Absolute path to the authorized local project directory.', 4096);
const job = text('Absolute job path returned by dispatch_task.', 4096);
const worker = { type: 'string', enum: ['zcode', 'claude', 'hermes'], description: 'Execution agent chosen by the dispatcher. claude uses local Claude Code with its configured inference provider.' };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const annotations = (readOnlyHint, openWorldHint = false) => ({ readOnlyHint, destructiveHint: false, openWorldHint });
const selection = {
  worker, project, task: text('Short task card: objective, acceptance criteria, allowed edits, existing changes, source entry points and checks. Never include secrets or full conversation history.', 24000),
  provider: text('Exact provider_id from list_models.', 200), model: text('Exact selected model ID.', 200),
  effort: text('Supported reasoning level selected by the host agent.', 80),
  selection_reason: text('Brief operational reason for this selection; no chain of thought.'),
  read_scope: { type: 'array', maxItems: 50, items: text('Existing relative project file or directory; use . for project-wide access.', 4096), description: 'Declared source read scope. Empty means no source reads. Project instructions/task metadata remain readable. This is not OS isolation.' },
  mode: { type: 'string', enum: ['plan', 'edit'], description: 'plan exposes file read/search; edit permits edits and scoped commands for Z Code/Hermes. Claude tests stay with the host. Both modes can send source to the inference provider.' },
  timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600, default: 600 },
};
const requiredSelection = ['worker', 'project', 'task', 'provider', 'model', 'effort', 'selection_reason', 'read_scope', 'mode'];
export const tools = [
  { name: 'list_workers', description: 'List installed worker runtimes and the configured host. Installation does not prove configuration, model entitlement or authorization. The current host agent dispatches and accepts results; workers must not delegate recursively.', inputSchema: schema({}, []), annotations: annotations(true) },
  { name: 'list_models', description: 'Discover provider/model IDs and reasoning levels for one worker without sending an inference prompt. May query its configured provider catalog or create a local discovery session. Catalog source is reported; local config is not proof of entitlement. Reuse within the task.', inputSchema: schema({ worker, project }, ['worker', 'project']), annotations: annotations(false, true) },
  { name: 'prepare_dispatch', description: 'Resolve the selected worker destination from local configuration and bind the task, host, runtime, scope and selection to a 30-minute preparation reference. Sends no inference prompt or catalog request. Returns actual endpoint and task scope for host authorization review. Reference is not user approval.', inputSchema: schema(selection, requiredSelection), annotations: annotations(false) },
  { name: 'dispatch_task', description: 'After prepare_dispatch and direct user authorization for its actual destination and scope, execute the unchanged selection. Supply prepared_ref and its endpoint. Destination changes fail before inference. No defaults, silent fallback, recursive workers or automatic approval. One lock per project. Returns an async job requiring host acceptance.', inputSchema: schema({
    ...selection,
    prepared_ref: { ...text('Reference from prepare_dispatch. This is parameter binding, not proof of approval.', 32), pattern: '^[a-f0-9]{32}$' },
    endpoint: text('Actual inference endpoint returned by prepare_dispatch and authorized by the user.', 4096),
    request_id: { ...text('Unique ID for this intended execution. Reuse it unchanged after a lost response: returns the original job without another model call. Changed task/selection conflicts; intentional retries or new work need a new ID. Scoped to this project; never contains secrets.', 128), pattern: '^[A-Za-z0-9._:-]{1,128}$' },
  }, [...requiredSelection, 'prepared_ref', 'endpoint']), annotations: annotations(false, true) },
  { name: 'task_status', description: 'Read local task status; optionally wait up to 30 seconds. No model call. orphaned means the supervisor died but a worker remains; cancel it before another writer. Avoid frequent polling.', inputSchema: schema({ job, wait_seconds: { type: 'integer', minimum: 0, maximum: 30, default: 0 } }, ['job']), annotations: annotations(true) },
  { name: 'task_result', description: 'Return the saved compact summary, actual model selection and reported usage. ready_for_review requires the calling agent to verify files and tests. No model call.', inputSchema: schema({ job }, ['job']), annotations: annotations(true) },
  { name: 'cancel_task', description: 'Cancel an active bridge task and release its lock. Partial edits remain for review.', inputSchema: schema({ job }, ['job']), annotations: annotations(false) },
  { name: 'recover_result', description: 'Recover an existing saved result from an ended failed/interrupted job without rerunning the model. Cannot override a cancellation or timeout.', inputSchema: schema({ job }, ['job']), annotations: annotations(false) },
];

function validate(tool, args) {
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Arguments must be an object');
  const s = tool.inputSchema;
  for (const key of s.required) if (!Object.hasOwn(args, key)) throw new Error('Missing required argument: ' + key);
  for (const [key, value] of Object.entries(args)) {
    const p = s.properties[key];
    if (!p) throw new Error('Unknown argument: ' + key);
    if (p.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length > (p.maxLength || Infinity))) throw new Error('Invalid string: ' + key);
    if (p.pattern && !new RegExp(p.pattern).test(value)) throw new Error('Invalid string: ' + key);
    if (p.type === 'integer' && (!Number.isInteger(value) || value < p.minimum || value > p.maximum)) throw new Error('Invalid integer: ' + key);
    if (p.type === 'array' && (!Array.isArray(value) || value.length > p.maxItems || value.some(x => typeof x !== 'string' || !x.trim() || x.length > p.items.maxLength))) throw new Error('Invalid array: ' + key);
    if (p.enum && !p.enum.includes(value)) throw new Error('Unsupported ' + key);
  }
  for (const key of ['project', 'job']) if (args[key] && !path.isAbsolute(args[key])) throw new Error(key + ' must be an absolute path');
}

async function run(args) {
  try {
    const { stdout } = await exec(process.execPath, [bridge, ...args], {
      timeout: 55000, maxBuffer: 1024 * 1024,
      env: { ...process.env, ZCODE_WORKER_TRANSPORT: 'app-server' },
    });
    return JSON.parse(stdout);
  } catch (e) {
    let error;
    try { error = JSON.parse(e.stdout).error; } catch {}
    // Do not reflect raw stderr, provider logs or credential-bearing config.
    throw new Error(error || 'Bridge command failed; inspect the local job logs if a job was created.');
  }
}

export async function callTool(name, args) {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error('Unknown tool: ' + name);
  validate(tool, args);
  if (name === 'list_workers') return run(['workers']);
  if (name === 'list_models') return run(['models', '--worker', args.worker, '--project', args.project]);
  if (name === 'prepare_dispatch' || name === 'dispatch_task') {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-card-'));
    fs.chmodSync(temp, 0o700);
    const card = path.join(temp, 'task.md');
    try {
      fs.writeFileSync(card, args.task, { mode: 0o600, flag: 'wx' });
      return await run([name === 'prepare_dispatch' ? 'prepare' : 'submit', '--worker', args.worker, '--project', args.project, '--task-file', card,
        '--provider', args.provider, '--model', args.model, '--effort', args.effort,
        '--selection-reason', args.selection_reason, '--mode', args.mode,
        '--read-scope', JSON.stringify(args.read_scope), '--timeout', String(args.timeout_seconds ?? 600),
        ...(args.prepared_ref ? ['--prepared-ref', args.prepared_ref, '--endpoint', args.endpoint] : []),
        ...(args.request_id ? ['--request-id', args.request_id] : [])]);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const command = { task_status: 'status', task_result: 'result', cancel_task: 'cancel', recover_result: 'collect' }[name];
  return run([command, '--job', args.job, ...(name === 'task_status' && args.wait_seconds ? ['--wait', String(args.wait_seconds)] : [])]);
}

const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } });
  }
  if (message.id === undefined) return; // No server-initiated requests; notifications need no response.
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') {
    const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
    const requested = message.params?.protocolVersion;
    return reply({ protocolVersion: supported.includes(requested) ? requested : '2025-11-25', capabilities: { tools: {} },
      serverInfo: { name: 'agent-bridge', version },
      instructions: `The ${hostName()} host agent chooses workers/models and accepts results. Discover, prepare_dispatch, verify user authorization for the actual endpoint and scope, then dispatch_task. A preparation reference or client identity is not approval. Workers must not recursively delegate.` });
  }
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method === 'tools/call') {
    try {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) { process.stderr.write('MCP input limit exceeded\n'); process.exit(1); }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      void handle(parsed).catch(() => send({ jsonrpc: '2.0', id: parsed?.id ?? null, error: { code: -32603, message: 'Internal error' } }));
    }
  });
}
