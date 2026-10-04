import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bridge = fileURLToPath(new URL('../plugins/agent-bridge/scripts/bridge.mjs', import.meta.url));

// Reuses the bridge test's synthetic prompt-transport worker (zcode prompt
// transport), which reports activity and can hang on demand.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-timeout-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const entry = path.join(root, 'fake-zcode.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs';
const argv = process.argv.slice(2);
const get = flag => argv[argv.indexOf(flag) + 1];
const prompt = get('--prompt');
const job = prompt.match(/Read the task card at (.+\\/task\\.md)\\. Read/)[1];
const task = fs.readFileSync(job, 'utf8');
if (task.includes('slowbeat')) {
  let beats = 0;
  const timer = setInterval(() => { fs.appendFileSync(get('--cwd') + '/worker-starts.txt', 'beat\\n'); }, 400);
  setTimeout(() => { clearInterval(timer); process.stdout.write(JSON.stringify({sessionId:'sess_slow', response:'Slow but active',usage:{inputTokens:1,outputTokens:1},projection:{status:'idle'}})); }, 2600);
} else if (task.includes('hang')) { setInterval(() => {}, 1000); }
else {
  fs.writeFileSync(get('--cwd') + '/produced.txt', 'worker edit');
  process.stdout.write(JSON.stringify({sessionId:'sess_fixture', response:'Edited produced.txt. Tests not run.',usage:{inputTokens:100,outputTokens:10},projection:{status:'idle'}}));
}
`);
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', config: { api: { baseUrl: 'http://127.0.0.1:9000' } } }] } } }));
  const jobs = [];
  // One explicit env for every invocation: the dispatching host's own
  // AGENT_BRIDGE_HOST/ZCODE_* variables must not leak into fixtures.
  const env = { ...process.env, AGENT_BRIDGE_HOST: 'generic', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config, ZCODE_WORKER_ENTRY: entry, ZCODE_WORKER_TRANSPORT: 'prompt' };
  const invoke = async (...argv) => {
    try {
      const x = await exec(process.execPath, [bridge, ...argv], { env, timeout: 20000 });
      return { code: 0, ...JSON.parse(x.stdout) };
    } catch (e) {
      if (!e.stdout) throw e;
      return { code: e.code, ...JSON.parse(e.stdout) };
    }
  };
  const base = { '--project': project, '--worker': 'zcode', '--provider': 'fixture', '--model': 'GLM-5.3', '--effort': 'low', '--mode': 'edit' };
  const selection = (overrides = {}) => [...Object.entries({ ...base, ...overrides }).flat()];
  const card = content => {
    const file = path.join(root, 'task-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(file, content);
    return file;
  };
  const prepare = async (file, overrides) => JSON.parse((await exec(process.execPath, [bridge, 'prepare', '--task-file', file, ...selection(overrides)], { env })).stdout);
  const submit = async (content, overrides = {}, requestId = null, extra = []) => {
    const file = card(content);
    const prepared = await prepare(file, overrides);
    const x = await invoke('submit', '--task-file', file, ...selection(overrides),
      '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint,
      ...(requestId ? ['--request-id', requestId] : []), ...extra);
    if (x.job) jobs.push(x.job);
    return x;
  };
  t.after(async () => {
    for (const job of jobs) { try { await invoke('cancel', '--job', job); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, env, invoke, submit, selection, card, prepare, track: job => { if (job && !jobs.includes(job)) jobs.push(job); } };
}

test('omitted timeout means no total-time deadline; an explicit budget may exceed one hour', async t => {
  const f = fixture(t);
  // Accelerate the supervisor's clock across the former one-hour boundary, and
  // make any old minute/hour-class kill timer fire during this short fixture.
  // Preflight, client waits and the fake worker continue to use the real clock.
  const clock = path.join(f.root, 'accelerated-clock.mjs');
  fs.writeFileSync(clock, `if (process.argv[2] === '_run') {
    const originalNow = Date.now, started = originalNow(), originalTimer = globalThis.setTimeout;
    Date.now = () => originalNow() + (originalNow() - started >= 500 ? 3601000 : 0);
    globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms >= 600000 ? 250 : ms, ...args);
  }`);
  f.env.NODE_OPTIONS = [f.env.NODE_OPTIONS, '--import', clock].filter(Boolean).join(' ');
  const none = await f.submit('slowbeat task', {}, 'budget-none', ['--wait', '4']);
  assert.equal(none.status, 'ready_for_review', JSON.stringify(none));
  assert.equal(none.timeBudgetSeconds, null, 'no default wall-clock deadline is recorded');
  const stored = JSON.parse(fs.readFileSync(path.join(none.job, 'state.json'), 'utf8'));
  assert.equal(stored.timeout, null);
  assert.ok(stored.finishedAt - stored.createdAt > 3600000, 'the active task crossed one simulated hour');
  assert.ok(fs.readFileSync(path.join(f.project, 'worker-starts.txt'), 'utf8').trim().split('\n').length >= 3);
  // The old hard default (600s) and cap (3600s) are gone; a >1h budget binds.
  const long = await f.submit('slowbeat task again', { '--timeout': 7200 }, 'budget-long', ['--wait', '4']);
  assert.equal(long.status, 'ready_for_review', 'active work is not cut off by a one-hour-class boundary');
  assert.equal(long.timeBudgetSeconds, 7200);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(long.job, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sessionId, 'sess_slow');
  assert.equal(checkpoint.resumeSupport, 'checkpoint'); // prompt transport cannot reopen sessions
  const month = await f.submit('slowbeat with large explicit budget', { '--timeout': 2592000 }, 'budget-month', ['--wait', '4']);
  assert.equal(month.status, 'ready_for_review', 'large budgets do not overflow a Node timer into an immediate kill');
});

test('an explicitly supplied time budget is still enforced', async t => {
  const f = fixture(t);
  const job = await f.submit('hang around past the budget', { '--timeout': 1 }, 'budget-cut', ['--wait', '4']);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.result, null);
});

test('checkpoint-based continuation is labeled and refuses live predecessors or stale identities', async t => {
  const f = fixture(t);
  await exec('git', ['init', '-q', f.project]);
  fs.writeFileSync(path.join(f.project, 'preexisting.txt'), 'PRIVATE_BASELINE_CONTENT');
  const first = await f.submit('Fix a local fixture', {}, 'cont-first', ['--wait', '3']);
  assert.equal(first.status, 'ready_for_review');
  const checkpoint = JSON.parse(fs.readFileSync(path.join(first.job, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sessionId, 'sess_fixture');
  assert.ok(checkpoint.artifacts.summary);
  assert.ok(checkpoint.artifacts.baselineChanges.some(x => x.path === 'preexisting.txt'));
  assert.ok(checkpoint.artifacts.observedChanges.some(x => x.path === 'produced.txt'));
  assert.ok(!checkpoint.artifacts.observedChanges.some(x => x.path.startsWith('.ai/')));
  assert.ok(!JSON.stringify(checkpoint).includes('PRIVATE_BASELINE_CONTENT'));
  const contCard = f.card('Finish the remaining fixture work.');
  const fresh = await f.prepare(contCard);
  // Running predecessor: refused.
  const hanging = await f.submit('hang around', {}, 'cont-hang');
  const live = await f.invoke('continue', '--job', hanging.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'cont-next');
  assert.equal(live.code, 1); assert.match(live.error, /still running|still alive/);
  assert.equal((await f.invoke('cancel', '--job', hanging.job)).status, 'cancelled');
  // Stolen identity: refused; recovery of results is not continuation.
  const stale = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'cont-first');
  assert.equal(stale.code, 1); assert.match(stale.error, /fresh request_id|already/);
  const changed = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection({ '--effort': 'high' }),
    '--prepared-ref', (await f.prepare(contCard, { '--effort': 'high' })).preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'cont-next');
  assert.equal(changed.code, 1); assert.match(changed.error, /original effort/);
  const continued = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'cont-next', '--wait', '3');
  assert.equal(continued.code, 0, JSON.stringify(continued));
  assert.equal(continued.resumeMode, 'checkpoint');
  assert.equal(continued.continuation.mode, 'checkpoint');
  f.track(continued.job);
  const prompt = fs.readFileSync(path.join(continued.job, 'prompt.md'), 'utf8');
  assert.match(prompt, /host-controlled continuation/);
  assert.match(prompt, /checkpoint \(this worker has no native resume/);
  const state = JSON.parse(fs.readFileSync(path.join(continued.job, 'state.json'), 'utf8'));
  assert.equal(state.resume.previousJob, first.job);
  assert.equal((await f.invoke('status', '--job', continued.job)).status, 'ready_for_review');
  // The ended original is untouched and recover_result still never resumes execution.
  const original = await f.invoke('status', '--job', first.job);
  assert.equal(original.status, 'ready_for_review');
});

test('jobs without a usable checkpoint cannot be continued', async t => {
  const f = fixture(t);
  const first = await f.submit('Fix a local fixture', {}, 'cont-nocheckpoint', ['--wait', '3']);
  fs.rmSync(path.join(first.job, 'checkpoint.json'));
  const contCard = f.card('Try continuing without a checkpoint.');
  const fresh = await f.prepare(contCard);
  const refused = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'cont-any');
  assert.equal(refused.code, 1); assert.match(refused.error, /No usable checkpoint/);
});
