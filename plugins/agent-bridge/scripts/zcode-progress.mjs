// Persist compact activity metadata separately from the supervisor's heartbeat.
// Never persist stream text, tool inputs/outputs, or permission request contents.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(value) ? value : null;
const count = value => Number.isFinite(value) && value >= 0 ? value : undefined;
const phases = new Set(['starting', 'waiting_for_model', 'reasoning', 'responding', 'preparing_tool', 'tools', 'blocked', 'collecting', 'completed', 'failed']);

export function createProgressTracker(job, { now = Date.now, intervalMs = 1000 } = {}) {
  const file = path.join(job, 'progress.json');
  const data = { schema: 1, jobId: path.basename(job), source: 'zcode-session-events', monitoring: 'starting',
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
    return { ...data, pendingInteractions: interactions.size, tools };
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
    finish(failed = false) { data.phase = failed ? 'failed' : 'completed'; touch(failed ? 'adapter_error' : 'result_written'); save(true); },
    observe, snapshot, close: flush,
  };
}

export function readProgress(job, now = Date.now()) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(job, 'progress.json'), 'utf8'));
    if (p.schema !== 1 || p.jobId !== path.basename(job) || p.source !== 'zcode-session-events' || !phases.has(p.phase)) return null;
    const at = Date.parse(p.lastActivityAt);
    return { ...p, idleSeconds: Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 1000)) : null };
  } catch { return null; } // Old jobs and other adapters may have no progress file.
}
