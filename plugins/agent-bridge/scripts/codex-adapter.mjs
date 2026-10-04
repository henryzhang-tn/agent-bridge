#!/usr/bin/env node
// Thin local client for the installed Codex CLI app-server (JSON-RPC over stdio,
// one message per line). No credentials are read here; Codex reuses its own
// configured provider and auth from CODEX_HOME.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { createProgressTracker } from './zcode-progress.mjs';
import { effortEvidence } from './quality.mjs';
import { endpoint } from './destination.mjs';
import { routingFromConfig, workerConfigOverrides } from './codex-config.mjs';
import { entryFor } from './workers.mjs';

const CONTROL_TIMEOUT = 30000;
const catalogOnly = process.argv[2] === '--models';
const job = catalogOnly ? null : process.argv[2];
const resumeThread = !catalogOnly && process.argv[3] === '--resume' ? process.argv[4] : null;
const state = catalogOnly
  ? { project: fs.realpathSync(process.argv[3]), mode: 'plan',
      entry: fs.realpathSync(entryFor('codex')) }
  : JSON.parse(fs.readFileSync(job + '/state.json', 'utf8'));
const prompt = catalogOnly ? null : fs.readFileSync(job + '/prompt.md', 'utf8');
const progress = catalogOnly ? null : createProgressTracker(job, { source: 'codex-app-server', worker: 'codex' });
const nodeEntry = /\.(?:m?js|cjs)$/.test(state.entry);
const child = spawn(nodeEntry ? process.execPath : state.entry, [...(nodeEntry ? [state.entry] : []), 'app-server'], {
  cwd: state.project, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let exiting = false;
const shutdown = code => {
  if (exiting) return;
  exiting = true;
  try { interrupt(); } catch {} // Ask the runtime to stop the turn before the group is killed.
  progress?.close();
  child.kill('SIGTERM');
  // Give the interrupt write a moment to flush; the supervisor escalates later.
  setTimeout(() => process.exit(code), 200);
};
process.once('SIGTERM', () => shutdown(143));
process.once('SIGINT', () => shutdown(130));
child.stderr.on('data', data => fs.writeSync(2, data));
let nextId = 0, threadId = null, turnId = null, turnDone, fatal;
const pending = new Map();
const notes = [];
let usage = null;
const trace = catalogOnly ? null : fs.openSync(job + '/protocol-events.jsonl', 'a', 0o600);
const log = data => { if (trace !== null) fs.writeSync(trace, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n'); };
const send = data => child.stdin.write(JSON.stringify(data) + '\n');
const fail = error => {
  fatal = error;
  for (const p of pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(error); }
  pending.clear();
};
function request(method, params, timeout = CONTROL_TIMEOUT) {
  if (fatal) return Promise.reject(fatal);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    // timeout === null disables the internal timer: running turns are bounded
    // only by an explicit task budget or cancellation from the supervisor.
    const timer = timeout === null ? undefined : setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
function interrupt() {
  if (threadId && turnId && !turnDone) send({ id: ++nextId, method: 'turn/interrupt', params: { threadId, turnId } });
}
child.on('error', fail);
child.on('exit', code => fail(new Error('Codex app-server exited: ' + code)));
child.stdin.on('error', fail);
// A worker must never approve its own interactive requests.
const DENY_REJECTION = { decision: { denied: { rejection: 'Agent Bridge workers cannot approve interactive requests; the host must handle this blocked action.' } } };
const APPROVALS = new Map([
  ['item/commandExecution/requestApproval', () => ({ decision: 'decline' })],
  ['execCommandApproval', () => DENY_REJECTION],
  ['applyPatchApproval', () => DENY_REJECTION],
  ['item/fileChange/requestApproval', () => ({ decision: 'decline' })],
  ['mcpServer/elicitation/request', () => ({ action: 'decline', content: null })],
]);
function serverRequest(msg) {
  notes.push('Host interaction required: ' + msg.method);
  log({ type: 'interaction_blocked', method: msg.method });
  progress?.blocked(msg.method);
  const decision = APPROVALS.get(msg.method);
  if (decision) send({ id: msg.id, result: decision() });
  else send({ id: msg.id, error: { code: -32601, message: 'This worker cannot answer interactive requests. Return the blocker to the host.' } });
}
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) return serverRequest(msg);
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code })); else p.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (!progress) return;
    const p = msg.params || {};
    if (threadId && p.threadId && p.threadId !== threadId) return;
    if (msg.method === 'thread/status/changed') {
      const flags = p.status?.type === 'active' ? p.status.activeFlags || [] : [];
      if (flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) progress.blocked('thread/' + flags[0]);
      else { log({ type: 'thread_status', status: p.status?.type }); progress.interactionResolved(); }
    } else if (msg.method === 'turn/started') {
      turnId = p.turnId || p.turn?.id || turnId;
      progress.activity('turn_started');
    } else if (msg.method === 'turn/completed') {
      turnId = p.turn?.id || turnId;
      turnDone = p.turn;
    } else if (msg.method === 'item/started' || msg.method === 'item/completed') {
      const item = p.item || {};
      if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'localShellCall', 'unifiedExec'].includes(item.type)) {
        if (msg.method === 'item/started') progress.toolStarted(item.id, item.type);
        else progress.toolFinished(item.id, item.type, item.status === 'failed' || item.status === 'declined');
      }
    } else if (msg.method === 'item/agentMessage/delta') {
      progress.streaming('response', typeof p.delta === 'string' ? p.delta.length : 0);
    } else if (msg.method === 'item/reasoning/summaryTextDelta' || msg.method === 'item/reasoning/textDelta') {
      progress.streaming('reasoning', typeof p.delta === 'string' ? p.delta.length : 0);
    } else if (msg.method === 'item/commandExecution/outputDelta' || msg.method === 'item/fileChange/outputDelta') {
      progress.activity(msg.method);
    } else if (msg.method === 'thread/tokenUsage/updated') {
      if (p.tokenUsage) usage = p.tokenUsage;
      progress.activity('token_usage_updated');
    } else if (msg.method === 'error') {
      log({ type: 'turn_error', willRetry: p.willRetry });
      if (!p.willRetry) turnDone = { status: 'failed', error: p.error };
    }
  } catch (e) { fail(new Error('Invalid app-server response: ' + e.message)); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  await request('initialize', { clientInfo: { name: 'agent-bridge-codex-adapter', title: 'Agent Bridge', version: JSON.parse(fs.readFileSync(new URL('../plugin.json', import.meta.url), 'utf8')).version }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
}

async function catalog(provider) {
  const data = []; let cursor;
  do {
    const listed = await request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    data.push(...(listed.data || [])); cursor = listed.nextCursor;
  } while (cursor);
  const models = data.filter(x => !x.hidden).map(x => {
    const levels = (x.supportedReasoningEfforts || []).map(e => e.reasoningEffort).filter(Boolean);
    return { provider_id: provider, model: x.model || x.id, label: x.displayName || x.id,
      reasoning_levels: levels.length ? levels : ['provider-default'],
      default_effort: x.defaultReasoningEffort || undefined,
      description: typeof x.description === 'string' ? x.description.slice(0, 500) : undefined };
  });
  fs.writeSync(1, JSON.stringify({ worker: 'codex', queriedAt: new Date().toISOString(), runtime: 'Codex CLI app-server',
    catalogSource: 'app-server model/list', provider, models,
    note: 'Catalog query sends no task prompt. Quota, entitlement and billing are not measured here.' }) + '\n');
}

async function execute() {
  await connect();
  const { config } = await request('config/read', { cwd: state.project, includeLayers: false });
  if (catalogOnly) return catalog(config.model_provider || 'openai');
  const { account } = await request('account/read', { refreshToken: false });
  const route = routingFromConfig(config, account, process.env, state.provider);
  if (state.destination) {
    if (endpoint(route.base) !== state.destination.endpoint) throw new Error('Inference destination changed before Codex startup; prepare again.');
  }
  const sandbox = state.mode === 'plan' ? 'read-only' : 'workspace-write';
  const base = { cwd: state.project, sandbox, approvalPolicy: 'on-request', approvalsReviewer: 'user', model: state.model, modelProvider: state.provider,
    config: workerConfigOverrides(config), developerInstructions: 'Complete only the assigned Agent Bridge task. Do not delegate, start child agents, invoke skills, or call external services beyond the authorized inference destination. Return approval and input blockers to the host.' };
  let started;
  if (resumeThread) {
    started = await request('thread/resume', { threadId: resumeThread, ...base });
    log({ type: 'thread_resumed', threadId: resumeThread });
  } else {
    started = await request('thread/start', { ...base, allowProviderModelFallback: false });
  }
  threadId = started.thread?.id || started.threadId;
  if (!threadId) throw new Error('app-server returned no thread id');
  // Keep runtime identity bound to the preflighted provider and selection.
  if (started.modelProvider !== state.provider) throw new Error('Codex started with provider "' + started.modelProvider + '" instead of the dispatched "' + state.provider + '"; prepare again.');
  if ((started.model || '').toLowerCase() !== (state.model || '').toLowerCase()) throw new Error('Codex started with model "' + started.model + '" instead of the dispatched "' + state.model + '"; refresh list_models.');
  log({ type: 'session_ready', threadId, resumed: !!resumeThread, modelProvider: started.modelProvider, model: started.model, reasoningEffort: started.reasoningEffort ?? null });
  progress.bindSession(threadId);
  progress.selectModel({ providerId: state.provider, modelId: state.model, options: { reasoningLevel: state.effort } });
  progress.monitoring('subscribed');
  progress.phase('waiting_for_model');
  const turn = await request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], model: state.model,
    ...(state.effort && state.effort !== 'provider-default' ? { effort: state.effort } : {}) }, null);
  turnId = turn.turn?.id || turnId;
  log({ type: 'turn_started', turnId });
  while (!turnDone) {
    if (fatal) throw fatal;
    if (exiting) throw new Error('Interrupted');
    await pause(200);
  }
  if (turnDone.status === 'failed' || turnDone.error) notes.push('Codex turn failed: ' + (turnDone.error?.message || 'turn error'));
  progress.phase('collecting');
  log({ type: 'collecting_snapshot' });
  const read = await request('thread/read', { threadId, includeTurns: true });
  const completed = (read.thread?.turns || []).find(t => t.id === turnId) || turnDone;
  const messages = (completed.items || []).filter(i => i.type === 'agentMessage');
  const response = (messages.filter(m => m.phase === 'final_answer').at(-1) || messages.at(-1) || {}).text || '';
  log({ type: 'snapshot_collected', turns: (read.thread?.turns || []).length, agentMessages: messages.length });
  const error = turnDone.status !== 'completed' || notes.length > 0 || !response;
  const result = { jobId: state.id, worker: 'codex', sessionId: threadId,
    response: response || notes.join('\n') || 'Codex returned without a final agent message.',
    notes, model: { providerId: state.provider, modelId: state.model, options: { reasoningLevel: state.effort } },
    effortEvidence: effortEvidence(state, { parameter: 'turn/start.effort',
      runtimeConfirmed: typeof turn.turn?.reasoningEffort === 'string' ? turn.turn.reasoningEffort : null,
      confirmationSource: typeof turn.turn?.reasoningEffort === 'string' ? 'turn/start.turn.reasoningEffort' : null }),
    providerLabel: 'Codex CLI / configured ' + state.provider,
    usage: usage?.total ? { inputTokens: usage.total.inputTokens, outputTokens: usage.total.outputTokens,
      totalTokens: usage.total.totalTokens, reasoningTokens: usage.total.reasoningOutputTokens,
      cacheReadTokens: usage.total.cachedInputTokens, lastInputTokens: usage.last?.inputTokens, lastOutputTokens: usage.last?.outputTokens } : null,
    projection: { status: error ? 'error' : 'idle', turnStatus: turnDone.status || null } };
  fs.writeFileSync(job + '/adapter-result.json', JSON.stringify(result), { mode: 0o600 });
  fs.writeSync(1, JSON.stringify(result) + '\n');
  log({ type: 'result_written' });
  progress.finish(error || !response);
}
try {
  await execute();
} catch (e) {
  progress?.finish(true);
  log({ type: 'adapter_error', message: e.message });
  fs.writeSync(2, 'Codex adapter: ' + e.message + '\n');
  process.exitCode = 1;
} finally {
  progress?.close();
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
  pending.clear(); child.stdin.end(); child.kill('SIGTERM');
  if (trace !== null) fs.closeSync(trace);
}
