// Persist compact activity metadata separately from the supervisor's heartbeat.
// Shared by every worker adapter; never persist stream text, tool inputs/outputs,
// or permission request contents.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const count = value => Number.isFinite(value) && value >= 0 ? value : undefined;
const phases = new Set(['starting', 'waiting_for_model', 'reasoning', 'responding', 'preparing_tool', 'tools', 'blocked', 'collecting', 'completed', 'failed']);
export const PROGRESS_SOURCES = ['zcode-session-events', 'codex-app-server', 'claude-cli', 'hermes-runtime'];

export function createProgressTracker(job, { source = 'zcode-session-events', worker = 'zcode', now = Date.now, intervalMs = 1000, reportIntervalMs = 30000 } = {}) {
  const file = path.join(job, 'progress.json');
  const data = { schema: 1, jobId: path.basename(job), source, worker, monitoring: 'starting',
    sessionId: null, selectedModel: null, phase: 'starting', lastActivityAt: null, lastActivity: null,
    reasoningCharacters: 0, responseCharacters: 0, hostInteractionRequired: false };
  const calls = new Map(), interactions = new Set();
  let lastSeq = -1, timer, dirty = false, lastWriteAt = -Infinity, lastCompleted = null;
  const timestamp = () => new Date(now()).toISOString();
  const active = call => !['completed', 'failed'].includes(call.status);
  function snapshot() {
    const tools = { total: calls.size, active: 0, completed: 0, failed: 0, byName: Object.create(null), current: [], lastCompleted };
    for (const call of calls.values()) {
      const name = call.name || 'unknown';
      const stats = tools.byName[name] ||= { total: 0, completed: 0, failed: 0 };
      stats.total++;
      if (active(call)) { tools.active++; if (tools.current.length < 20) tools.current.push({ ...call }); }
      else { tools[call.status]++; stats[call.status]++; }
    }
    return { ...data, reportedAt: timestamp(), pendingInteractions: interactions.size, tools };
  }
  function flush() {
    clearTimeout(timer); timer = undefined;
    if (!dirty) return;
    const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot()) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    lastWriteAt = now(); dirty = false;
  }
  function save(immediate = false) {
    dirty = true;
    if (immediate || now() - lastWriteAt >= intervalMs) flush();
    else if (!timer) { timer = setTimeout(flush, intervalMs - (now() - lastWriteAt)); timer.unref(); }
  }
  function touch(type, kind, toolName) {
    data.lastActivityAt = timestamp();
    data.lastActivity = { type, ...(kind ? { kind } : {}), ...(toolName ? { toolName } : {}) };
  }
  function phase(value) {
    data.phase = data.hostInteractionRequired || interactions.size ? 'blocked' : value;
  }
  function observe(event) {
    if (event.sessionId !== data.sessionId || !Number.isInteger(event.seq) || event.seq <= lastSeq) return;
    lastSeq = event.seq;
    const p = event.payload || {};
    if (event.type === 'model.streaming') {
      const kind = p.kind;
      if (!['reasoning_start', 'reasoning_delta', 'reasoning_end', 'text_start', 'text_delta', 'text_end',
        'tool_input_start', 'tool_input_delta', 'tool_input_end', 'tool_call'].includes(kind)) return;
      if (kind.startsWith('reasoning_')) {
        phase('reasoning'); if (typeof p.delta === 'string') data.reasoningCharacters += p.delta.length;
      } else if (kind.startsWith('text_')) {
        phase('responding'); if (typeof p.delta === 'string') data.responseCharacters += p.delta.length;
      } else phase('preparing_tool');
      touch(event.type, kind); save();
    } else if (event.type === 'tool.updated') {
      const id = identifier(p.toolCallId), name = identifier(p.toolName);
      if (!id || !['scheduled', 'started', 'progress', 'result', 'error'].includes(p.kind)) return;
      const call = calls.get(id) || { id, name: null, status: 'scheduled' };
      // Late updates must not reopen a completed tool or count it twice.
      if (calls.has(id) && !active(call)) return;
      if (name) call.name = name;
      call.lastActivityAt = timestamp();
      if (p.kind === 'started' || p.kind === 'progress') {
        call.status = 'running'; call.startedAt ||= timestamp();
      }
      for (const key of ['elapsedMs', 'stdoutBytes', 'stderrBytes', 'outputBytes']) {
        if (count(p[key]) !== undefined) call[key] = p[key];
      }
      if (p.kind === 'result' || p.kind === 'error') {
        call.status = p.kind === 'error' || p.result?.success === false ? 'failed' : 'completed';
        if (count(p.duration) !== undefined) call.durationMs = p.duration;
        lastCompleted = { ...call };
      }
      calls.set(id, call);
      phase([...calls.values()].some(active) ? 'tools' : 'waiting_for_model');
      touch(event.type, p.kind, call.name); save(p.kind !== 'progress');
    } else if (['permission.requested', 'userInput.requested', 'permission.resolved', 'userInput.resolved'].includes(event.type)) {
      const id = identifier(p.requestId) || identifier(p.toolCallId);
      if (!id) return;
      if (event.type.endsWith('.requested')) interactions.add(id); else interactions.delete(id);
      phase([...calls.values()].some(active) ? 'tools' : 'waiting_for_model');
      touch(event.type, undefined, identifier(p.toolName)); save(true);
    } else if (event.type === 'turn.started') {
      phase('waiting_for_model'); touch(event.type); save(true);
    }
  }
  // Reporting is adapter liveness, not runtime/task activity. Keep timestamps
  // separate so a live reporter cannot hide a silent model or stuck tool.
  const reporter = setInterval(() => save(true), reportIntervalMs);
  reporter.unref();
  return {
    bindSession(sessionId) { data.sessionId = sessionId; touch('session_ready'); save(true); },
    selectModel(model) { data.selectedModel = model; touch('selected_model'); save(true); },
    monitoring(value) { data.monitoring = value; save(true); },
    state(reason) {
      const next = new Map([['prompt_started', 'waiting_for_model'], ['prompt_completed', 'collecting'], ['prompt_failed', 'failed']]).get(reason);
      if (next) { phase(next); touch(reason); save(true); }
    },
    blocked(method) {
      data.hostInteractionRequired = true; phase('blocked');
      touch('interaction_blocked', identifier(method)); save(true);
    },
    interactionResolved() {
      data.hostInteractionRequired = false;
      phase([...calls.values()].some(active) ? 'tools' : 'waiting_for_model');
      save(true);
    },
    activity(type, kind, toolName) { touch(type, kind, toolName); save(true); },
    phase(value) { if (phases.has(value)) { phase(value); save(true); } },
    finish(failed = false) {
      // A pending host interaction remains visible even at the end: it explains
      // why the task cannot progress without the host.
      data.phase = data.hostInteractionRequired || interactions.size ? 'blocked' : failed ? 'failed' : 'completed';
      touch(failed ? 'adapter_error' : 'result_written'); save(true);
    },
    // Codex app-server item lifecycle: one item id is one tool call observation.
    toolStarted(id, name) {
      const key = identifier(id);
      if (!key) return;
      const call = calls.get(key);
      if (call && !active(call)) return;
      calls.set(key, { ...call, id: key, name: identifier(name) || call?.name || 'unknown', status: 'running', startedAt: call?.startedAt || timestamp(), lastActivityAt: timestamp() });
      phase('tools'); touch('tool_started', undefined, identifier(name)); save(true);
    },
    toolFinished(id, name, failed) {
      const key = identifier(id);
      if (!key) return;
      const call = calls.get(key) || { id: key, name: identifier(name) || 'unknown', status: 'running', startedAt: timestamp() };
      if (!active(call)) return;
      call.status = failed ? 'failed' : 'completed';
      call.lastActivityAt = timestamp();
      calls.set(key, call);
      lastCompleted = { ...call };
      phase([...calls.values()].some(active) ? 'tools' : 'waiting_for_model');
      touch(failed ? 'tool_failed' : 'tool_completed', undefined, call.name); save(true);
    },
    streaming(kind, characters = 0) {
      if (kind === 'reasoning') { phase('reasoning'); if (characters > 0) data.reasoningCharacters += characters; }
      else if (kind === 'response') { phase('responding'); if (characters > 0) data.responseCharacters += characters; }
      else return;
      touch('model_streaming', kind); save();
    },
    report() { save(true); }, observe, snapshot,
    close() { clearInterval(reporter); flush(); },
  };
}

// Advisory only: never triggers cancellation. Missing telemetry is unknown,
// never proof of a stall.
function assess(p, idleSeconds) {
  const base = { advisory: true, automaticAction: 'none' };
  if (p.hostInteractionRequired || p.pendingInteractions > 0) return { ...base, activity: 'blocked',
    attention: 'host_interaction_required', suspectedStall: false,
    note: 'The worker is waiting for a host/user interaction; agent-bridge never approves automatically.' };
  if (p.monitoring !== 'subscribed') return { ...base, activity: 'unknown', suspectedStall: null,
    note: 'Runtime telemetry is missing or unsupported for this worker; silence is not evidence of a stall.' };
  if (idleSeconds === null) return { ...base, activity: 'unknown', suspectedStall: null,
    note: 'No runtime activity timestamp has been observed yet.' };
  if (p.tools.active > 0) return { ...base, activity: 'active', suspectedStall: false,
    note: p.tools.active + ' tool call(s) currently running.' };
  if (idleSeconds <= 120) return { ...base, activity: 'active', suspectedStall: false,
    note: 'Recent runtime activity observed.' };
  return { ...base, activity: 'idle', suspectedStall: true,
    note: 'No runtime activity for ' + idleSeconds + 's (advisory only). Jobs are never killed on silence; verify with the worker and host before cancelling.' };
}

export function readProgress(job, now = Date.now()) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(job, 'progress.json'), 'utf8'));
    if (p.schema !== 1 || p.jobId !== path.basename(job) || !PROGRESS_SOURCES.includes(p.source) || !phases.has(p.phase)) return null;
    const at = Date.parse(p.lastActivityAt);
    const idleSeconds = Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null;
    return { ...p, idleSeconds, assessment: assess(p, idleSeconds) };
  } catch { return null; } // Old jobs and other adapters may have no progress file.
}
