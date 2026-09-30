#!/usr/bin/env node
// Thin local client for the installed Z Code app-server. No model/API credentials are read here.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { workerEnv } from './bridge.mjs';
import { zcodeDestination } from './destination.mjs';

const catalogOnly = process.argv[2] === '--models';
const job = catalogOnly ? null : process.argv[2];
const state = catalogOnly ? {
  project: fs.realpathSync(process.argv[3]), mode: 'plan',
  entry: fs.realpathSync(process.env.ZCODE_WORKER_ENTRY || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
} : JSON.parse(fs.readFileSync(job + '/state.json', 'utf8'));
const prompt = catalogOnly ? null : fs.readFileSync(job + '/prompt.md', 'utf8');
const child = spawn(process.execPath, [state.entry, 'app-server', '--stdio', '--cwd', state.project], {
  cwd: state.project, env: workerEnv(state.entry), stdio: ['pipe', 'pipe', 'pipe'],
});
process.once('SIGTERM', () => { child.kill('SIGTERM'); process.exit(143); });
process.once('SIGINT', () => { child.kill('SIGTERM'); process.exit(130); });
child.stderr.on('data', data => fs.writeSync(2, data));
let nextId = 0, terminalReason, sessionId, fatal;
const pending = new Map();
const notes = [];
const trace = catalogOnly ? null : fs.openSync(job + '/protocol-events.jsonl', 'a', 0o600);
const log = data => { if (trace !== null) fs.writeSync(trace, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n'); };
const send = data => child.stdin.write(JSON.stringify(data) + '\n');
const fail = error => {
  fatal = error;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
};
function request(method, params, timeout = 30000) {
  if (fatal) return Promise.reject(fatal);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}
child.on('error', fail);
child.on('exit', code => fail(new Error('Z Code app-server exited: ' + code)));
child.stdin.on('error', fail);
readline.createInterface({ input: child.stdout }).on('line', line => {
  try {
    const msg = JSON.parse(line);
    if (msg.method && msg.id !== undefined) {
      if (msg.method === 'session/requestRuntimePreferences') {
        send({ id: msg.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false } });
      } else {
        // A worker cannot approve its own permission requests or answer on the user's behalf.
        notes.push('Host interaction required: ' + msg.method);
        log({ type: 'interaction_blocked', method: msg.method });
        send({ id: msg.id, error: { code: -32601, message: 'This worker cannot authorize interactive requests. Return the blocker to the host.' } });
      }
    } else if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    } else if (msg.method === 'state.updated') {
      const p = msg.params || {};
      log({ type: 'state', reason: p.reason, sessionId: p.sessionId });
      if (p.sessionId === sessionId && ['prompt_completed', 'prompt_failed'].includes(p.reason)) terminalReason = p.reason;
    }
  } catch (e) { fail(new Error('Invalid app-server response: ' + e.message)); }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  const parts = message.parts || message.content || [];
  if (!Array.isArray(parts)) return '';
  return parts.filter(p => p.type === 'text').map(p => p.text || p.content || '').join('\n');
}
async function execute() {
  const tools = state.mode === 'plan' ? ['Read', 'Glob', 'Grep'] : ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'];
  const collectSession = process.argv[3] === '--collect' ? process.argv[4] : null;
  const initial = await request(collectSession ? 'session/resume' : 'session/create', {
    workspace: { workspacePath: state.project, workspaceKey: state.project },
    ...(collectSession ? { sessionId: collectSession } : { mode: state.mode, titleGenerationEnabled: false }),
    mcpServers: [], toolAllowlist: tools,
    offPeakToolEnabled: false, dynamicWorkflowEnabled: false,
  });
  sessionId = initial.session?.sessionId;
  if (!sessionId) throw new Error('app-server returned no session ID');
  log({ type: 'session_ready', sessionId, collectOnly: !!collectSession });
  const available = initial.settings?.model?.available || [];
  const currentProvider = initial.settings?.model?.current?.providerId;
  if (catalogOnly) {
    fs.writeSync(1, JSON.stringify({ worker: 'zcode', queriedAt: new Date().toISOString(), currentProvider,
      models: available.map(x => ({ provider_id: x.ref.providerId, model: x.ref.modelId,
        label: x.label || x.ref.modelId, provider_label: x.providerLabel,
        reasoning_levels: (x.reasoning?.levels || []).map(level => level.value),
        description: typeof x.description === 'string' ? x.description.slice(0, 500) : undefined })),
      note: 'Configured availability; no inference prompt sent. Scheduler must choose an explicit provider, model and supported effort. Quota and actual billing are not measured.' }) + '\n');
    return;
  }
  const matches = available.filter(x => x.ref.modelId.toLowerCase() === state.model.toLowerCase() && (!state.provider || x.ref.providerId === state.provider));
  const selected = matches.length === 1 ? matches[0] : null;
  if (!selected) throw new Error('Requested model is unavailable or provider is ambiguous: ' + state.model);
  if (!selected.reasoning?.levels?.some(x => x.value === state.effort)) throw new Error('Unsupported reasoning effort: ' + state.effort);
  const selection = { ...selected.ref, options: { reasoningLevel: state.effort } };
  if (collectSession) terminalReason = initial.session?.status === 'error' ? 'prompt_failed' : 'prompt_completed';
  else {
    if (state.destination && zcodeDestination(state.provider, workerEnv(state.entry)).endpoint !== state.destination.endpoint) throw new Error('Inference destination changed before sending the task; prepare again.');
    await request('session/setModel', { sessionId, model: selection, persistAsWorkspaceLastUsed: false });
    log({ type: 'selected_model', sessionId, model: selection, providerLabel: selected.providerLabel });
    await request('session/send', { sessionId, content: prompt, modelSelection: selection }, state.timeout * 1000);
    log({ type: 'send_acknowledged' });
  }
  while (!terminalReason) {
    if (fatal) throw fatal;
    await pause(200);
  }
  log({ type: 'collecting_snapshot' });
  const snapshot = await request('session/read', { sessionId, messageLimit: 30 });
  log({ type: 'snapshot_collected', messages: snapshot.messages?.length });
  let usage = null;
  try { usage = await request('session/usage', { sessionId }, 5000); } catch (e) { log({ type: 'usage_unavailable', message: e.message }); }
  const assistant = (snapshot.messages || []).filter(m => (m.info?.role || m.role) === 'assistant');
  const response = assistant.map(textOf).filter(Boolean).at(-1) || '';
  const error = terminalReason === 'prompt_failed' || notes.length > 0;
  const result = { sessionId, response: response || notes.join('\n') || 'Worker returned without a final text response.',
    usage, model: selection, providerLabel: selected.providerLabel,
    projection: { ...snapshot.projection, status: error || !response ? 'error' : snapshot.projection?.status || 'idle' }, notes };
  fs.writeFileSync(job + '/adapter-result.json', JSON.stringify(result), { mode: 0o600 });
  fs.writeSync(1, JSON.stringify(result) + '\n');
  log({ type: 'result_written' });
}
try {
  await execute();
} catch (e) {
  log({ type: 'adapter_error', message: e.message });
  fs.writeSync(2, 'Z Code protocol adapter: ' + e.message + '\n');
  process.exitCode = 1;
} finally {
  if (sessionId && !fatal) {
    try { await request('session/close', { sessionId }, 5000); } catch (e) { log({ type: 'close_error', message: e.message }); }
  }
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear(); child.stdin.end(); child.kill('SIGTERM');
  if (trace !== null) fs.closeSync(trace);
}
