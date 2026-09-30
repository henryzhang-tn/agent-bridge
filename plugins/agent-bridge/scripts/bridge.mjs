#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WORKERS, entryFor, workers } from './workers.mjs';
import { hostName, destinationFor, endpoint } from './destination.mjs';

const SELF = fileURLToPath(import.meta.url);
const ACTIVE = new Set(['queued', 'running', 'cancelling', 'orphaned']);
const LIMIT = 16 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const exists = file => fs.existsSync(file);
function atomic(file, data) {
  const tmp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(-pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const hash = value => createHash('sha256').update(value).digest('hex');
function args(argv) {
  const result = { command: argv.shift() || 'help' };
  const valid = new Set(['project', 'task-file', 'mode', 'timeout', 'job', 'wait', 'model', 'effort', 'provider', 'selection-reason', 'worker', 'request-id', 'read-scope', 'prepared-ref', 'endpoint']);
  while (argv.length) {
    const key = argv.shift();
    if (!key?.startsWith('--') || !valid.has(key.slice(2)) || !argv.length) throw new Error('Invalid argument: ' + key);
    if (result[key.slice(2)] !== undefined) throw new Error('Duplicate argument: ' + key);
    result[key.slice(2)] = argv.shift();
  }
  return result;
}
function seconds(value, fallback, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid seconds value: ' + value);
  return n;
}
function directory(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Expected a real directory: ' + dir);
}
function jobDir(value) {
  if (!value) throw new Error('--job is required');
  const dir = fs.realpathSync(value);
  const s = readJSON(path.join(dir, 'state.json'));
  if (s.schema !== 1 || s.job !== dir || path.dirname(dir) !== path.join(s.project, '.ai', 'tasks')) throw new Error('Invalid job directory');
  return dir;
}
function release(s) {
  const lock = path.join(s.project, '.ai', 'zcode-worker.lock');
  try {
    if (readJSON(path.join(lock, 'owner.json')).id !== s.id) return;
    fs.unlinkSync(path.join(lock, 'owner.json'));
    fs.rmdirSync(lock);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function getState(dir) {
  const s = readJSON(path.join(dir, 'state.json'));
  const stale = s.status === 'orphaned' || Date.now() - s.updatedAt > 10000;
  if (ACTIVE.has(s.status) && stale && !alive(s.runnerPid) && !(s.status === 'queued' && alive(s.launcherPid))) {
    if (alive(s.childPid) || groupAlive(s.childPid)) {
      // A detached worker may survive its supervisor. Keep the project locked
      // until it exits or an explicit cancel stops the recorded process group.
      if (s.status !== 'orphaned') {
        s.status = 'orphaned'; s.error = 'Supervisor exited but the worker process group is still running. Cancel this job before starting another writer.';
        s.updatedAt = Date.now(); atomic(path.join(dir, 'state.json'), s);
      }
    } else {
      const cancelled = exists(path.join(dir, 'cancel.request'));
      s.status = cancelled ? 'cancelled' : 'interrupted';
      s.error = cancelled ? 'Cancellation requested and worker processes ended; inspect partial edits before retrying.' : 'Supervisor and worker are no longer running; inspect saved results and edits before retrying.';
      s.finishedAt = Date.now(); s.updatedAt = Date.now(); atomic(path.join(dir, 'state.json'), s); release(s);
    }
  }
  // A supervisor can die after saving its terminal state but before unlinking
  // its project lock. Reclaim only after both it and its worker group are gone.
  if (!ACTIVE.has(s.status) && !alive(s.runnerPid) && !alive(s.childPid) && !groupAlive(s.childPid)) release(s);
  return s;
}
function brief(s) {
  return { id: s.id, job: s.job, host: s.host || 'generic', worker: s.worker || 'zcode', status: s.status, mode: s.mode, sessionId: s.sessionId || null,
    destination: s.destination || null, readScope: s.readScope || null,
    requestId: s.requestId || null,
    elapsedSeconds: Math.round(((s.finishedAt || Date.now()) - s.createdAt) / 1000),
    exitCode: s.exitCode ?? null, usage: s.usage ?? null, error: s.error ?? null,
    model: s.model, effort: s.effort, provider: s.provider || s.selectedModel?.providerId || null,
    selectionReason: s.selectionReason || null, selectedModel: s.selectedModel || null,
    result: exists(path.join(s.job, 'result.md')) ? path.join(s.job, 'result.md') : null };
}
async function reuseRequest(job, requestId, fingerprint, wait) {
  if (fs.lstatSync(job).isSymbolicLink() || !fs.statSync(job).isDirectory()) throw new Error('Invalid request reservation directory');
  const deadline = Date.now() + 5000;
  while (!exists(path.join(job, 'state.json')) && Date.now() < deadline) await sleep(50);
  if (!exists(path.join(job, 'state.json'))) throw new Error('Request reservation is incomplete; inspect ' + job + '. It will not be resubmitted automatically.');
  jobDir(job);
  const s = getState(job);
  if (s.requestId !== requestId || s.requestFingerprint !== fingerprint) throw new Error('request_id conflicts with an existing task or execution configuration. Use a new request_id for intentional new work.');
  if (wait) await waitFor(job, wait);
  return output({ ...brief(getState(job)), reused: true });
}
function redact(text) {
  return text.replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
}
function promptFor(s) {
  return `You are the ${s.worker || 'zcode'} implementation worker for one task assigned by the ${s.host || 'current'} host agent.\n` +
    `Work only in this project: ${s.project}\n` +
    `Declared source read scope (relative to the project): ${JSON.stringify(s.readScope || ['.'])}. Do not read source outside this scope. Task metadata and relevant project instructions may be read.\n` +
    `Read the task card at ${path.join(s.job, 'task.md')}. Read relevant project instructions and only the source needed for that task.\n` +
    `Preserve existing user changes. Do not modify .ai task metadata. Do not start other agents or delegate back to the host. ` +
    `Do not commit, push, deploy, install dependencies, modify global configuration, or contact external services unless the task explicitly includes that action.\n` +
    (s.mode === 'plan' ? `This is an analysis-only task: do not edit project files.\n` : '') +
    `If a permission or missing requirement prevents progress, report it; do not bypass it.\n` +
    `End with a concise summary (aim for 1500 characters): outcome, changed file paths, checks actually run and results, blockers or remaining risks. ` +
    `The host agent will independently review the changes. Do not write a long transcript or paste entire files.\n`;
}
export function workerEnv(entry) {
  const env = { ...process.env, NO_COLOR: '1' };
  // The macOS Desktop bundle stores provider metadata beside glm/, whereas
  // its standalone CLI resolver expects a different directory layout.
  const bundled = path.resolve(path.dirname(entry), '../config/provider/zcode-builtin.json');
  if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && exists(bundled)) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = bundled;
    const plist = path.resolve(path.dirname(entry), '../../Info.plist');
    if (process.platform === 'darwin' && exists(plist)) {
      const version = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
      env.ZCODE_APP_VERSION ||= version;
      const platform = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64';
      const root = path.join(os.homedir(), '.zcode/v2/runtime/provider', platform, version);
      const cached = exists(root) ? fs.readdirSync(root).map(p => path.join(root, p, 'zcode-builtin.json')).filter(exists) : [];
      const personal = path.join(os.homedir(), '.zcode/v2/provider_config.json');
      if (cached.length === 1 && exists(personal)) {
        // Reuse Desktop's active metadata without inspecting or copying credentials.
        env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = cached[0];
        env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = bundled;
        env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||= personal;
      }
    }
  }
  return env;
}
function selection(o) {
  if (!o.project || !path.isAbsolute(o.project) || !o['task-file']) throw new Error('prepare/submit requires an absolute --project and --task-file');
  const project = fs.realpathSync(o.project);
  if (!fs.statSync(project).isDirectory()) throw new Error('Project is not a directory');
  const task = fs.readFileSync(o['task-file'], 'utf8');
  if (!task.trim() || task.length > 24000) throw new Error('Task must contain 1–24000 characters; use file references for large context.');
  const mode = o.mode || 'edit';
  if (!['edit', 'plan', 'build'].includes(mode)) throw new Error('Supported modes: edit, plan, build. Permission bypass modes are not supported.');
  const timeout = seconds(o.timeout, 600, 3600);
  const worker = o.worker;
  if (!WORKERS.includes(worker)) throw new Error('Unknown worker: ' + worker);
  const model = o.model;
  const effort = o.effort;
  if (!model?.trim() || !effort?.trim() || !o.provider?.trim()) throw new Error('Explicit --provider, --model and --effort are required; no default selection.');
  if (model.length > 200 || effort.length > 80 || (o.provider?.length || 0) > 200) throw new Error('Invalid model configuration length');
  const selectionReason = o['selection-reason'] || null;
  if (selectionReason && selectionReason.length > 500) throw new Error('Keep the selection reason within 500 characters');
  const transport = worker === 'zcode' ? process.env.ZCODE_WORKER_TRANSPORT || 'app-server' : worker;
  if (!['app-server', 'prompt', 'claude', 'hermes'].includes(transport)) throw new Error('Unsupported worker transport');
  let readScope;
  try { readScope = JSON.parse(o['read-scope'] || '["."]'); } catch { throw new Error('--read-scope must be a JSON array of relative project paths'); }
  if (!Array.isArray(readScope) || readScope.length > 50) throw new Error('Invalid read scope');
  readScope = [...new Set(readScope.map(p => {
    if (typeof p !== 'string' || !p.trim() || p.length > 4096 || path.isAbsolute(p)) throw new Error('Read scope requires relative project paths');
    const relative = path.relative(project, path.resolve(project, p));
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Read scope escapes the project');
    return relative || '.';
  }))].sort();
  return { project, task, worker, model, effort, provider: o.provider, mode, timeout, transport, selectionReason, readScope, host: hostName() };
}
const selectionFingerprint = s => hash(JSON.stringify({ task: s.task, worker: s.worker, model: s.model, effort: s.effort,
  provider: s.provider, mode: s.mode, timeout: s.timeout, transport: s.transport, readScope: s.readScope, host: s.host }));
function scopeTargets(project, readScope) {
  return readScope.map(p => {
    const resolved = fs.realpathSync(path.join(project, p));
    const relative = path.relative(project, resolved);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Read scope escapes the project');
    return relative || '.';
  });
}

async function prepare(o) {
  const selected = selection(o);
  const entry = selected.worker === 'hermes' ? path.resolve(entryFor(selected.worker)) : fs.realpathSync(entryFor(selected.worker));
  if (!exists(entry)) throw new Error('Worker runtime is not installed: ' + selected.worker);
  const destination = await destinationFor(selected.worker, selected.provider, selected.worker === 'zcode' ? workerEnv(entry) : process.env);
  const readTargets = scopeTargets(selected.project, selected.readScope);
  const preparedRef = randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 30 * 60 * 1000;
  directory(path.join(selected.project, '.ai')); directory(path.join(selected.project, '.ai', 'preparations'));
  const record = { schema: 1, preparedRef, expiresAt, fingerprint: selectionFingerprint(selected), entry, destination, readTargets };
  atomic(path.join(selected.project, '.ai', 'preparations', preparedRef + '.json'), record);
  output({ ...record, host: selected.host, worker: selected.worker, project: selected.project, provider: selected.provider,
    model: selected.model, effort: selected.effort, mode: selected.mode, timeoutSeconds: selected.timeout,
    readScope: selected.readScope, task: selected.task, inferenceDispatched: false,
    authorization: 'Host must verify direct user authorization for this destination and scope. A prepared reference is not approval.',
    scopeEnforcement: 'Declared worker instructions, not an OS sandbox; project instructions and task metadata are also readable.' });
}

async function verifyPreparation(o, selected, entry) {
  if (!/^[a-f0-9]{32}$/.test(o['prepared-ref'] || '') || !o.endpoint) throw new Error('Run prepare first, verify user authorization, then submit with --prepared-ref and --endpoint.');
  const dir = path.join(selected.project, '.ai', 'preparations');
  for (const d of [path.join(selected.project, '.ai'), dir]) if (fs.lstatSync(d).isSymbolicLink() || !fs.statSync(d).isDirectory()) throw new Error('Invalid preparation directory');
  const file = path.join(dir, o['prepared-ref'] + '.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid preparation reference');
  const record = readJSON(file);
  if (record.schema !== 1 || record.preparedRef !== o['prepared-ref'] || !Number.isInteger(record.expiresAt) || record.expiresAt < Date.now()) throw new Error('Preparation expired or invalid; prepare again.');
  if (record.fingerprint !== selectionFingerprint(selected) || record.entry !== entry) throw new Error('Task, host, scope or runtime changed since preparation; prepare again.');
  if (JSON.stringify(record.readTargets) !== JSON.stringify(scopeTargets(selected.project, selected.readScope))) throw new Error('Read scope targets changed since preparation; prepare again.');
  const actual = await destinationFor(selected.worker, selected.provider, selected.worker === 'zcode' ? workerEnv(entry) : process.env);
  if (record.destination?.provider !== actual.provider || record.destination?.endpoint !== actual.endpoint || endpoint(o.endpoint) !== actual.endpoint) throw new Error('Inference destination changed since preparation; prepare again and verify authorization.');
  return { destination: actual, readTargets: record.readTargets };
}

async function submit(o) {
  const selected = selection(o);
  const { project, task, worker, model, effort, mode, timeout, transport, selectionReason, host, readScope } = selected;
  const wait = o.wait === undefined ? 0 : seconds(o.wait, 1, 55);
  const requestId = o['request-id'] || null;
  if (o['request-id'] !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(o['request-id'])) throw new Error('request_id must contain 1–128 letters, digits, dots, underscores, colons or hyphens.');
  const fingerprint = requestId ? hash(selectionFingerprint(selected) + '\n' + (o.endpoint || '')) : null;
  const id = requestId ? 'request-' + hash(requestId) : new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomBytes(4).toString('hex');
  const job = path.join(project, '.ai', 'tasks', id);
  if (requestId && exists(job)) return reuseRequest(job, requestId, fingerprint, wait);
  const lock = path.join(project, '.ai', 'zcode-worker.lock');
  if (exists(lock) && exists(path.join(lock, 'owner.json'))) {
    const owner = readJSON(path.join(lock, 'owner.json')); getState(jobDir(owner.job));
    if (exists(lock)) throw new Error('A worker already owns this project: ' + owner.job);
  }
  // Keep the Python venv path: resolving its symlink would lose installed dependencies.
  const entry = worker === 'hermes' ? path.resolve(entryFor(worker)) : fs.realpathSync(entryFor(worker));
  if (!exists(entry)) throw new Error('Worker runtime is not installed: ' + worker);
  const { destination, readTargets } = await verifyPreparation(o, selected, entry);
  directory(path.join(project, '.ai')); directory(path.join(project, '.ai', 'tasks'));
  // The deterministic request directory is an exclusive, durable reservation.
  // Concurrent retries can inspect it but can never launch a second supervisor.
  try { fs.mkdirSync(job, { mode: 0o700 }); }
  catch (e) {
    if (requestId && e.code === 'EEXIST') return reuseRequest(job, requestId, fingerprint, wait);
    throw e;
  }
  let child, ownsLock = false;
  const s = { schema: 1, id, job, project, worker, mode, model, effort, provider: o.provider, selectionReason, transport, timeout, entry,
    host, readScope, readTargets, destination, preparedRef: o['prepared-ref'],
    requestId, requestFingerprint: fingerprint, launcherPid: process.pid,
    status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), runnerPid: null, childPid: null };
  try {
    atomic(path.join(job, 'task.md'), task);
    atomic(path.join(job, 'state.json'), s);
    if (exists(lock)) {
      const deadline = Date.now() + 5000;
      while (exists(lock) && !exists(path.join(lock, 'owner.json')) && Date.now() < deadline) await sleep(50);
      if (exists(lock)) {
        const owner = readJSON(path.join(lock, 'owner.json'));
        getState(jobDir(owner.job));
        if (exists(lock)) throw new Error('A worker already owns this project: ' + owner.job);
      }
    }
    try { fs.mkdirSync(lock, { mode: 0o700 }); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('A worker already owns this project; inspect the active job before retrying.'); throw e; }
    ownsLock = true;
    atomic(path.join(lock, 'owner.json'), { id, job });
    const fd = fs.openSync(path.join(job, 'supervisor.log'), 'a', 0o600);
    try {
      child = spawn(process.execPath, [SELF, '_run', '--job', job], { detached: true, cwd: project, stdio: ['ignore', fd, fd] });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (!child?.pid) {
      s.status = 'failed'; s.error = redact(e.message); s.finishedAt = Date.now(); s.updatedAt = Date.now();
      atomic(path.join(job, 'state.json'), s);
      if (ownsLock) {
        if (exists(path.join(lock, 'owner.json'))) release(s);
        else fs.rmdirSync(lock);
      }
    }
    throw e;
  }
  // Wait for startup acknowledgement, so a caller never mistakes a queued record for a running worker.
  const deadline = Date.now() + 5000;
  while (getState(job).status === 'queued' && Date.now() < deadline) await sleep(100);
  if (wait) await waitFor(job, wait);
  output({ ...brief(getState(job)), reused: false });
}
async function waitFor(dir, duration) {
  const until = Date.now() + duration * 1000;
  while (ACTIVE.has(getState(dir).status) && Date.now() < until) await sleep(250);
}
async function cancelOrphan(s) {
  // Called only after detecting a dead supervisor. Never signal an arbitrary
  // shell process: the recorded worker owns a dedicated process group.
  const signal = sig => {
    if (!Number.isInteger(s.childPid) || s.childPid <= 1) throw new Error('Missing worker process group');
    try { process.kill(-s.childPid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 3000;
  while (groupAlive(s.childPid) && Date.now() < deadline) await sleep(100);
  if (groupAlive(s.childPid)) {
    signal('SIGKILL');
    const killDeadline = Date.now() + 2000;
    while (groupAlive(s.childPid) && Date.now() < killDeadline) await sleep(100);
  }
  if (alive(s.childPid) || groupAlive(s.childPid)) throw new Error('Worker process group has not exited; the project remains locked.');
  s.status = 'cancelled'; s.error = 'Orphaned worker stopped; inspect partial edits before retrying.';
  s.finishedAt = Date.now(); s.updatedAt = Date.now(); atomic(path.join(s.job, 'state.json'), s); release(s);
}
function parseResult(raw) {
  try { return JSON.parse(raw.trim()); } catch {}
  for (const line of raw.trim().split('\n').reverse()) {
    try { const x = JSON.parse(line); if (typeof x.response === 'string') return x; } catch {}
  }
  throw new Error('Worker did not return a recognized JSON result; inspect output.json and stderr.log.');
}
function acceptResult(s, result) {
  if (typeof result.response !== 'string' || !result.response.trim()) throw new Error('Worker returned an empty response.');
  if (result.jobId && result.jobId !== s.id) throw new Error('Result does not match this job');
  s.sessionId = result.sessionId || null;
  s.selectedModel = result.model || null; s.providerLabel = result.providerLabel || null;
  s.usage = result.usage || null; s.projection = result.projection || null;
  s.notes = result.notes || [];
  s.status = /error|fail|cancel|permission|blocked/i.test(result.projection?.status || '') ? 'needs_attention' : 'ready_for_review';
  s.error = s.status === 'needs_attention' ? s.notes.join('; ') || 'Worker reported an incomplete or failed task.' : null;
  const response = redact(result.response);
  atomic(path.join(s.job, 'result.md'), response.slice(0, 12000) + (response.length > 12000 ? '\n\n[Summary truncated; full response is in adapter-result.json or output.json.]\n' : '\n') + (s.notes.length ? '\nBlockers: ' + s.notes.join('; ') + '\n' : ''));
}
async function run(dir) {
  let s = readJSON(path.join(dir, 'state.json'));
  let child, timer, heartbeat, killTimer, reason, total = 0;
  const events = fs.openSync(path.join(dir, 'events.jsonl'), 'a', 0o600);
  const stdout = fs.openSync(path.join(dir, 'output.json'), 'w', 0o600);
  const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'w', 0o600);
  const save = () => { s.updatedAt = Date.now(); atomic(path.join(dir, 'state.json'), s); };
  const event = data => fs.writeSync(events, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
  const signalGroup = sig => {
    if (!child?.pid) return;
    try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') event({ type: 'signal_error', message: e.message }); }
  };
  const stop = why => {
    if (reason) return;
    reason = why; s.status = 'cancelling'; save(); event({ type: 'stop_requested', reason });
    signalGroup('SIGTERM'); killTimer = setTimeout(() => signalGroup('SIGKILL'), 3000);
  };
  const interrupted = () => stop('cancelled');
  process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
  try {
    s.runnerPid = process.pid; s.status = 'running'; save();
    if (exists(path.join(dir, 'cancel.request'))) { reason = 'cancelled'; throw new Error('Cancelled before startup'); }
    if (s.readTargets && JSON.stringify(s.readTargets) !== JSON.stringify(scopeTargets(s.project, s.readScope))) throw new Error('Read scope targets changed before worker startup; prepare again.');
    if (s.destination) {
      const actual = await destinationFor(s.worker, s.provider, s.worker === 'zcode' ? workerEnv(s.entry) : process.env);
      if (actual.endpoint !== s.destination.endpoint) throw new Error('Inference destination changed before worker startup; prepare again.');
    }
    const prompt = promptFor(s);
    atomic(path.join(dir, 'prompt.md'), prompt);
    const argv = [s.entry, '--cwd', s.project, '--mode', s.mode, '--json', '--no-color', '--surface', 'terminal',
      '--disallowed-tools', 'Agent,Task,TaskCreate,TaskUpdate,TaskList,TaskGet', '--prompt', prompt];
    if (process.env.ZCODE_WORKER_DEBUG === '1') argv.push('--verbose');
    const adapter = { 'app-server': 'zcode-protocol.mjs', claude: 'claude-adapter.mjs', hermes: 'hermes-adapter.py' }[s.transport];
    const command = adapter ? [path.join(path.dirname(SELF), adapter), dir] : argv;
    child = spawn(s.worker === 'hermes' ? s.entry : process.execPath, command, { cwd: s.project, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: s.worker === 'zcode' || !s.worker ? workerEnv(s.entry) : { ...process.env, NO_COLOR: '1' } });
    s.childPid = child.pid || null; save(); event({ type: 'started', mode: s.mode, childPid: s.childPid, entry: s.entry });
    const capture = fd => chunk => {
      total += chunk.length;
      if (total <= LIMIT) fs.writeSync(fd, chunk);
      else stop('output_limit');
    };
    child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
    timer = setTimeout(() => stop('timed_out'), s.timeout * 1000);
    heartbeat = setInterval(() => {
      if (exists(path.join(dir, 'cancel.request'))) stop('cancelled');
      save();
    }, 500);
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    s.exitCode = exit.code; s.signal = exit.signal;
    event({ type: 'exited', ...exit, reason: reason || null });
    if (reason) { s.status = reason; s.error = 'Execution stopped; partial project edits may remain.'; }
    else if (exit.code !== 0) {
      s.status = 'failed'; s.error = 'Worker exited unsuccessfully. Inspect stderr.log for details.';
    } else {
      // Durable result files survive app-server stream shutdown and avoid relying
      // on stdout forwarding from a detached desktop process tree.
      const resultFile = s.transport !== 'prompt' ? 'adapter-result.json' : 'output.json';
      acceptResult(s, parseResult(fs.readFileSync(path.join(dir, resultFile), 'utf8')));
    }
  } catch (e) {
    signalGroup('SIGKILL'); s.status = reason || 'failed'; s.error = redact(e.message);
    event({ type: 'error', message: s.error });
  } finally {
    clearTimeout(timer); clearTimeout(killTimer); clearInterval(heartbeat);
    // Clean up descendants after exit/cancellation; the child has a dedicated process group.
    signalGroup('SIGKILL');
    process.off('SIGTERM', interrupted); process.off('SIGINT', interrupted);
    s.finishedAt = Date.now(); save();
    for (const fd of [stdout, stderr, events]) fs.closeSync(fd);
    release(s);
  }
}
async function main() {
  const o = args(process.argv.slice(2));
  if (o.command === 'help') return output({ commands: {
    workers: '(list installed worker runtimes)',
    models: '--worker zcode|claude|hermes --project DIR (model catalog; no inference prompt)',
    prepare: '--worker WORKER --project DIR --task-file FILE --provider ID --model MODEL --effort LEVEL [--read-scope JSON] [--mode plan|edit] (local destination preview; no inference)',
    submit: 'Same selection as prepare, plus --prepared-ref REF --endpoint URL [--request-id ID] [--selection-reason TEXT] [--timeout 600] [--wait 1..55]. Host authorization is required.',
    status: '--job DIR [--wait 1..55]', result: '--job DIR', collect: '--job DIR (recover an existing saved adapter result without model calls)', cancel: '--job DIR' },
    note: 'One worker per project across all adapters. ready_for_review means worker returned, not acceptance passed. Each worker reuses its own configured provider.' });
  if (o.command === 'submit') return submit(o);
  if (o.command === 'prepare') return prepare(o);
  if (o.command === 'workers') return output({ host: hostName(), workers: workers() });
  if (o.command === 'models') {
    if (!o.project || !path.isAbsolute(o.project)) throw new Error('models requires an absolute --project directory');
    const project = fs.realpathSync(o.project);
    if (!fs.statSync(project).isDirectory()) throw new Error('Project is not a directory');
    const worker = o.worker || 'zcode';
    if (!WORKERS.includes(worker)) throw new Error('Unknown worker: ' + worker);
    const adapter = { zcode: 'zcode-protocol.mjs', claude: 'claude-adapter.mjs', hermes: 'hermes-adapter.py' }[worker];
    const { stdout } = await promisify(execFile)(worker === 'hermes' ? entryFor(worker) : process.execPath, [path.join(path.dirname(SELF), adapter), '--models', project], { timeout: 45000, maxBuffer: 1024 * 1024 });
    return output(JSON.parse(stdout));
  }
  if (!['_run', 'status', 'result', 'collect', 'cancel'].includes(o.command)) throw new Error('Unknown command: ' + o.command);
  const dir = jobDir(o.job);
  if (o.command === '_run') return run(dir);
  if (o.command === 'collect') {
    const s = getState(dir);
    if (s.transport === 'prompt' || ACTIVE.has(s.status)) throw new Error('collect requires an ended adapter job');
    if (!['failed', 'interrupted', 'ready_for_review', 'needs_attention'].includes(s.status)) throw new Error('Cannot override a cancelled or timed-out job');
    const result = readJSON(path.join(dir, 'adapter-result.json'));
    if (s.transport === 'app-server') {
      const log = fs.readFileSync(path.join(dir, 'protocol-events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      if (!result.sessionId || !log.some(x => x.sessionId === result.sessionId && ['session_ready', 'selected_model'].includes(x.type))) throw new Error('Saved result does not match the dispatched session');
    } else if (!result.sessionId || result.jobId !== s.id || result.worker !== s.worker) throw new Error('Saved result does not match the dispatched job');
    s.recoveredFromStatus = s.status; acceptResult(s, result); s.updatedAt = Date.now();
    atomic(path.join(dir, 'state.json'), s); return output(brief(s));
  }
  if (o.command === 'cancel') {
    const s = getState(dir);
    if (s.status === 'orphaned') {
      atomic(path.join(dir, 'cancel.request'), 'cancel\n');
      await cancelOrphan(s);
    }
    else if (ACTIVE.has(s.status)) atomic(path.join(dir, 'cancel.request'), 'cancel\n');
    await waitFor(dir, 5); return output(brief(getState(dir)));
  }
  if (o.wait !== undefined) await waitFor(dir, seconds(o.wait, 1, 55));
  const s = getState(dir);
  if (o.command === 'result') return output({ ...brief(s), summary: exists(path.join(dir, 'result.md')) ? fs.readFileSync(path.join(dir, 'result.md'), 'utf8') : null });
  output(brief(s));
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch(e => { output({ error: redact(e.message) }); process.exitCode = 1; });
}
