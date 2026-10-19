import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { callGoalTool } from '../plugins/agent-bridge/scripts/goals.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const selection = { worker: 'claude', provider: 'recovery-fixture', model: 'fixture-model', effort: 'high',
  mode: 'plan', endpoint: 'http://127.0.0.1:9000' };
const criteria = [{ id: 'complete', description: 'The fixture meets the complete goal.',
  verification: 'Host reads the actual fixture source.', verification_kind: 'source' }];
const checks = (status = 'passed', evidence = 'Host inspected the complete fixture.') =>
  [{ criterion_id: 'complete', status, evidence, verification_kind: 'source' }];

function fixture(t, limits = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-goal-recovery-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src/value.txt'), 'unchanged');
  const states = new Map(), calls = [];
  let failure = null, dispatchDelay = 0, launches = 0, statusHook = null;
  const publish = (args, status = 'ready_for_review') => {
    const job = path.join(project, '.ai/tasks/request-' + hash(args.request_id));
    if (states.has(job)) return states.get(job);
    const state = { schema: 1, project, job, requestId: args.request_id, host: process.env.AGENT_BRIDGE_HOST || 'generic',
      worker: args.worker, provider: args.provider, model: args.model, effort: args.effort, mode: args.mode,
      destination: { provider: args.provider, endpoint: args.endpoint }, readScope: args.read_scope,
      taskContract: args.task_contract, status, quality: { acceptanceStatus: 'accepted' },
      review: { id: 'fixture-accepted', status: 'accepted', remainingCriteria: [] } };
    fs.mkdirSync(job, { recursive: true });
    fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
    states.set(job, state); launches++;
    return state;
  };
  const bridge = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'dispatch_task' || name === 'continue_task') {
      if (dispatchDelay) await new Promise(resolve => setTimeout(resolve, dispatchDelay));
      if (failure) {
        const error = new Error(failure.message);
        if (failure.confirmed) error.bridgeCommandExited = true;
        if (failure.reserve) fs.mkdirSync(path.join(project, '.ai/tasks/request-' + hash(args.request_id)), { recursive: true });
        throw error;
      }
      return structuredClone(publish(args));
    }
    const state = states.get(args.job);
    assert.ok(state, name + ' must only reference a published canonical job');
    if (name === 'task_status') {
      if (statusHook) { const hook = statusHook; statusHook = null; await hook(); }
      return structuredClone(state);
    }
    if (name === 'cancel_task') {
      state.status = 'cancelled';
      fs.writeFileSync(path.join(state.job, 'state.json'), JSON.stringify(state));
      return structuredClone(state);
    }
    throw new Error('Unexpected synthetic bridge call: ' + name);
  };
  const call = (name, args) => callGoalTool(name, args, bridge);
  const make = () => call('create_goal', { project, goal_id: 'recovery', objective: 'Verify safe persisted recovery.',
    context: 'Synthetic local fixture; no external worker.', read_scope: ['src'], allowed_edits: ['src'],
    acceptance_criteria: criteria, participants: [{ id: 'implementer', ...selection }],
    limits: { max_steps: 10, max_reworks: 10, max_no_progress: 10, ...limits } });
  const execution = () => ({ ...selection, project, task: 'Inspect the synthetic fixture source.', read_scope: ['src'],
    selection_reason: 'Explicit deterministic fixture.', prepared_ref: 'a'.repeat(32),
    task_contract: { complexity: 'standard', context: 'Synthetic fixture.', allowed_edits: [], preserve: [],
      integration: 'Host verifies and records acceptance.', acceptance_criteria: criteria } });
  const dispatch = (goal, operation_id) => ({ goal, operation_id, action: 'dispatch', participant_id: 'implementer', execution: execution() });
  return { project, states, calls, call, make, dispatch, publish,
    setFailure: value => { failure = value; }, setDelay: value => { dispatchDelay = value; },
    setStatusHook: value => { statusHook = value; },
    launched: () => launches,
    dispatchCalls: () => calls.filter(item => /^(dispatch|continue)_task$/.test(item.name)),
    cancelCalls: () => calls.filter(item => item.name === 'cancel_task'),
    persisted: goal => JSON.parse(fs.readFileSync(path.join(goal, 'goal.json'), 'utf8')) };
}

test('confirmed local command rejection with no reservation permits a fresh operation but never replays rejected inference', async t => {
  const f = fixture(t), { goal } = await f.make();
  const rejectedArgs = f.dispatch(goal, 'rejected');
  f.setFailure({ confirmed: true, message: 'Synthetic command exited before reserving a job.' });
  await assert.rejects(() => f.call('advance_goal', rejectedArgs), /command exited/);
  const rejected = await f.call('goal_status', { goal });
  assert.equal(rejected.steps[0].status, 'dispatch_rejected');
  assert.equal(rejected.budget.used.steps, 1);
  assert.equal(rejected.budget.used.no_progress, 1);
  assert.equal(f.launched(), 0);
  f.setFailure(null);
  const replay = await f.call('advance_goal', rejectedArgs);
  assert.equal(replay.reused, true);
  assert.equal(f.dispatchCalls().length, 1);
  const next = await f.call('advance_goal', f.dispatch(goal, 'fresh-after-rejection'));
  assert.equal(next.steps.length, 2);
  assert.equal(f.launched(), 1);
  const accepted = await f.call('record_goal_review', { goal, review_id: 'verified',
    snapshot_fingerprint: next.snapshot_fingerprint, checks: checks() });
  assert.equal(accepted.status, 'completed', 'a proven never-launched attempt is not a child acceptance obligation');
});

test('unclassified lost replies with no job block fresh operations until the original operation is recovered', async t => {
  const f = fixture(t), { goal } = await f.make();
  const uncertain = f.dispatch(goal, 'uncertain');
  f.setFailure({ message: 'Synthetic connection closed with unknown result.' });
  await assert.rejects(() => f.call('advance_goal', uncertain), /unknown result/);
  const status = await f.call('goal_status', { goal });
  assert.equal(status.steps[0].status, 'dispatch_unknown');
  assert.equal(f.persisted(goal).operations.uncertain.done, false);
  f.setFailure(null);
  await assert.rejects(() => f.call('advance_goal', f.dispatch(goal, 'unsafe-replacement')), /uncertain|active|reconcile/i);
  assert.equal(f.dispatchCalls().length, 1);
  assert.equal(f.launched(), 0);
  await f.call('advance_goal', uncertain);
  await f.call('advance_goal', uncertain);
  assert.equal(f.dispatchCalls().length, 2);
  assert.equal(f.launched(), 1);
});

test('a confirmed command exit with an incomplete reservation remains uncertain', async t => {
  const f = fixture(t), { goal } = await f.make();
  f.setFailure({ confirmed: true, reserve: true, message: 'Synthetic exit with an incomplete reservation.' });
  await assert.rejects(() => f.call('advance_goal', f.dispatch(goal, 'reserved')), /incomplete reservation/);
  const status = await f.call('goal_status', { goal });
  assert.equal(status.steps[0].status, 'dispatch_unknown');
  await assert.rejects(() => f.call('advance_goal', f.dispatch(goal, 'replacement')), /uncertain|active|reconcile/i);
  assert.equal(f.dispatchCalls().length, 1);
  assert.equal(f.launched(), 0);
});

test('cancel can be replayed to stop a job that arrives after an unknown dispatch', async t => {
  const f = fixture(t), { goal } = await f.make();
  const uncertain = f.dispatch(goal, 'delayed');
  f.setFailure({ message: 'Synthetic lost reply; job may arrive later.' });
  await assert.rejects(() => f.call('advance_goal', uncertain), /lost reply/);
  const cancellation = { goal, operation_id: 'cancel-delayed', action: 'cancel', reason: 'Host cancelled the goal.' };
  const initial = await f.call('advance_goal', cancellation);
  assert.equal(initial.status, 'cancelled');
  assert.equal(f.persisted(goal).operations['cancel-delayed'].done, false);
  assert.equal(f.cancelCalls().length, 0);
  const lateJob = f.publish(f.dispatchCalls()[0].args, 'running');
  const cancelled = await f.call('advance_goal', cancellation);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.steps[0].status, 'cancelled');
  assert.deepEqual(f.cancelCalls().map(item => item.args.job), [lateJob.job]);
  assert.equal(f.persisted(goal).operations['cancel-delayed'].done, true);
  await f.call('advance_goal', cancellation);
  assert.equal(f.cancelCalls().length, 1, 'completed cancellation replay is idempotent');
  f.setFailure(null);
  await f.call('advance_goal', uncertain);
  assert.equal(f.dispatchCalls().length, 1, 'old dispatch must not relaunch a cancelled job');
});

test('elapsed goal time survives pause/resume and still permits final verification of ended work', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { timeout_seconds: 1 }), { goal } = await f.make();
  await f.call('advance_goal', f.dispatch(goal, 'before-timeout'));
  await f.call('advance_goal', { goal, operation_id: 'pause', action: 'pause' });
  now += 2000;
  await f.call('advance_goal', { goal, operation_id: 'resume', action: 'resume' });
  const expired = await f.call('goal_status', { goal });
  assert.equal(expired.status, 'budget_exhausted');
  assert.ok(expired.budget.exhausted.includes('timeout_seconds'));
  assert.equal(expired.budget.used.seconds, 2);
  await assert.rejects(() => f.call('advance_goal', f.dispatch(goal, 'after-timeout')), /budget|timeout/i);
  assert.equal(f.dispatchCalls().length, 1);
  const completed = await f.call('record_goal_review', { goal, review_id: 'finish-after-timeout',
    snapshot_fingerprint: expired.snapshot_fingerprint, checks: checks() });
  assert.equal(completed.status, 'completed');
});

test('context, messages, status reconciliation and pause/resume do not replenish no-progress budget', async t => {
  const f = fixture(t, { max_no_progress: 2 }), { goal } = await f.make();
  const first = await f.call('advance_goal', f.dispatch(goal, 'unchanged-source'));
  for (let i = 0; i < 2; i++) await f.call('record_goal_review', { goal, review_id: 'same-failure-' + i,
    snapshot_fingerprint: first.snapshot_fingerprint, checks: checks('failed', 'Same failure, wording ' + i) });
  const exhausted = await f.call('goal_status', { goal });
  assert.ok(exhausted.budget.used.no_progress >= 2);
  const nextContext = { facts: ['Source has not changed.'], decisions: ['Preserve existing work.'],
    open_questions: ['Which criterion needs another approach?'], summary: 'Fresh prose must not reset progress.' };
  const updated = await f.call('advance_goal', { goal, operation_id: 'context', action: 'set_context', context: nextContext });
  assert.equal(updated.context_version, exhausted.context_version + 1);
  await f.call('send_goal_message', { goal, message_id: 'discussion', to: 'implementer', type: 'note', body: 'More discussion is not source progress.' });
  const inbox = await f.call('read_goal_messages', { goal, recipient: 'implementer', after_sequence: 0 });
  assert.deepEqual(inbox.context, nextContext);
  assert.equal(inbox.messages.length, 1);
  await f.call('advance_goal', { goal, operation_id: 'pause', action: 'pause' });
  await f.call('advance_goal', { goal, operation_id: 'resume', action: 'resume' });
  const restored = await f.call('goal_status', { goal });
  assert.equal(restored.budget.used.no_progress, exhausted.budget.used.no_progress);
  assert.equal(restored.budget.used.steps, exhausted.budget.used.steps);
  await assert.rejects(() => f.call('advance_goal', f.dispatch(goal, 'after-discussion')), /budget|progress/i);
  assert.equal(f.dispatchCalls().length, 1);
});

test('concurrent exact operation requests acquire one execution and one cumulative step', async t => {
  const f = fixture(t), { goal } = await f.make();
  f.setDelay(40);
  const args = f.dispatch(goal, 'same-concurrent-operation');
  const results = await Promise.all([f.call('advance_goal', args), f.call('advance_goal', structuredClone(args))]);
  assert.equal(f.dispatchCalls().length, 1);
  assert.equal(f.launched(), 1);
  assert.equal(results.filter(result => result.reused).length, 1);
  assert.ok(results.every(result => result.steps.length === 1 && result.budget.used.steps === 1));
  assert.equal(fs.existsSync(path.join(goal, 'mutation.lock')), false);
});

test('a mutation lock from an exited process is reclaimed without resetting goal state', async t => {
  const f = fixture(t), { goal } = await f.make();
  const exited = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(exited.status, 0);
  assert.ok(Number.isInteger(exited.pid) && exited.pid > 1);
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  fs.writeFileSync(path.join(goal, 'mutation.lock'), JSON.stringify({ pid: exited.pid, token: 'stale-fixture-lock' }), { mode: 0o600 });
  const restored = await f.call('goal_status', { goal });
  assert.equal(restored.goal, goal);
  assert.equal(restored.budget.used.steps, 0);
  assert.equal(restored.budget.used.no_progress, 0);
  assert.equal(f.dispatchCalls().length, 0);
  assert.equal(fs.existsSync(path.join(goal, 'mutation.lock')), false);
});

test('goal acceptance rejects source changed while awaiting child task status', async t => {
  const f = fixture(t), { goal } = await f.make();
  const ended = await f.call('advance_goal', f.dispatch(goal, 'ended'));
  f.setStatusHook(async () => {
    await Promise.resolve();
    fs.writeFileSync(path.join(f.project, 'src/value.txt'), 'changed while task_status was awaited');
  });
  await assert.rejects(() => f.call('record_goal_review', { goal, review_id: 'raced-review',
    snapshot_fingerprint: ended.snapshot_fingerprint, checks: checks() }), /snapshot|changed/i);
  const current = await f.call('goal_status', { goal });
  assert.notEqual(current.snapshot_fingerprint, ended.snapshot_fingerprint);
  assert.notEqual(current.status, 'completed');
  const accepted = await f.call('record_goal_review', { goal, review_id: 'current-review',
    snapshot_fingerprint: current.snapshot_fingerprint, checks: checks() });
  assert.equal(accepted.status, 'completed');
});

test('a rejected continuation cannot supersede its unaccepted predecessor', async t => {
  const f = fixture(t), { goal } = await f.make();
  const ended = await f.call('advance_goal', f.dispatch(goal, 'unaccepted-predecessor'));
  const predecessor = ended.steps[0].job;
  f.states.get(predecessor).quality.acceptanceStatus = 'changes_requested';
  f.states.get(predecessor).review.status = 'changes_requested';
  const continuation = f.dispatch(goal, 'rejected-continuation');
  continuation.action = 'continue';
  continuation.execution.job = predecessor;
  f.setFailure({ confirmed: true, message: 'Synthetic continuation rejected before job reservation.' });
  await assert.rejects(() => f.call('advance_goal', continuation), /rejected before job/);
  const status = await f.call('goal_status', { goal });
  assert.equal(status.steps[0].review_status, 'changes_requested');
  assert.equal(status.steps[1].status, 'dispatch_rejected');
  await assert.rejects(() => f.call('record_goal_review', { goal, review_id: 'cannot-skip-predecessor',
    snapshot_fingerprint: status.snapshot_fingerprint, checks: checks() }), /accepted child/i);
  assert.notEqual((await f.call('goal_status', { goal })).status, 'completed');
  assert.equal(f.launched(), 1);
});

test('an uncertain operation with no job cannot start its first worker after the goal deadline', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { timeout_seconds: 1 }), { goal } = await f.make();
  const pending = f.dispatch(goal, 'pending-before-deadline');
  f.setFailure({ message: 'Synthetic unknown transport error before any reservation appeared.' });
  await assert.rejects(() => f.call('advance_goal', pending), /unknown transport/);
  assert.equal(f.launched(), 0);
  now += 2000;
  f.setFailure(null);
  const expired = await f.call('goal_status', { goal });
  assert.ok(expired.budget.exhausted.includes('timeout_seconds'));
  await assert.rejects(() => f.call('advance_goal', pending), /budget|timeout|deadline/i);
  assert.equal(f.dispatchCalls().length, 1, 'deadline must prevent retry from launching absent work');
  assert.equal(f.launched(), 0);
});

test('two processes reclaiming the same dead owner preserve both messages and existing budgets', { timeout: 15000 }, async t => {
  const f = fixture(t), { goal } = await f.make();
  const baseline = await f.call('advance_goal', f.dispatch(goal, 'existing-ended-step'));
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.equal(dead.status, 0);
  assert.throws(() => process.kill(dead.pid, 0), { code: 'ESRCH' });
  fs.writeFileSync(path.join(goal, 'mutation.lock'), JSON.stringify({ pid: dead.pid, token: 'shared-stale-owner' }), { mode: 0o600 });
  const gate = path.join(f.project, '.ai/recovery-test-gate');
  fs.mkdirSync(gate);
  const moduleUrl = new URL('../plugins/agent-bridge/scripts/goals.mjs', import.meta.url).href;
  const childSource = `
    import fs from 'node:fs';
    import path from 'node:path';
    const [moduleUrl, goal, messageId, deadPidText, gate] = process.argv.slice(1);
    const { callGoalTool } = await import(moduleUrl);
    const deadPid = Number(deadPidText);
    const nativeRead = fs.readFileSync;
    const waitForFile = file => {
      const until = Date.now() + 8000;
      while (!fs.existsSync(file)) {
        if (Date.now() >= until) throw new Error('Synthetic process barrier timed out: ' + path.basename(file));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    };
    let observedStale = false;
    fs.readFileSync = function(file, ...args) {
      const contents = nativeRead.call(this, file, ...args);
      if (!observedStale && String(file) === path.join(goal, 'mutation.lock')) {
        let owner;
        try { owner = JSON.parse(String(contents)); } catch {}
        if (owner?.pid === deadPid) {
          observedStale = true;
          fs.writeFileSync(path.join(gate, 'observed-' + messageId), 'ready');
          // Delay each stale observation until both independent processes hold it.
          waitForFile(path.join(gate, 'release-stale-observers'));
        }
      }
      return contents;
    };
    fs.writeFileSync(path.join(gate, 'ready-' + messageId), 'ready');
    waitForFile(path.join(gate, 'start'));
    const bridge = async (name, args) => {
      if (name === 'task_status') return JSON.parse(nativeRead(path.join(args.job, 'state.json'), 'utf8'));
      throw new Error('No inference is allowed in concurrent message fixture: ' + name);
    };
    try {
      const result = await callGoalTool('send_goal_message', {
        goal, message_id: messageId, to: 'implementer', type: 'note', body: 'Message from ' + messageId
      }, bridge);
      process.stdout.write(JSON.stringify({ message: result.message.message_id }) + '\\n');
    } finally { fs.readFileSync = nativeRead; }
  `;
  const children = ['process-one', 'process-two'].map(messageId => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource, moduleUrl, goal, messageId, String(dead.pid), gate],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    t.after(() => { if (child.exitCode === null && !child.killed) child.kill('SIGKILL'); });
    return { messageId, child, done };
  });
  const waitForMarkers = async prefix => {
    const deadline = Date.now() + 8000;
    while (!children.every(({ messageId }) => fs.existsSync(path.join(gate, prefix + messageId)))) {
      assert.ok(children.every(({ child }) => child.exitCode === null), 'both fixture children must reach the barrier');
      assert.ok(Date.now() < deadline, 'fixture processes must reach ' + prefix + ' barrier');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await waitForMarkers('ready-');
  fs.writeFileSync(path.join(gate, 'start'), 'go');
  await waitForMarkers('observed-');
  fs.writeFileSync(path.join(gate, 'release-stale-observers'), 'go');
  const results = await Promise.all(children.map(({ done }) => done));
  for (const result of results) assert.equal(result.code, 0, result.stderr || result.stdout);
  const inbox = await f.call('read_goal_messages', { goal, recipient: 'implementer' });
  assert.deepEqual(inbox.messages.map(message => message.message_id).sort(), ['process-one', 'process-two']);
  assert.deepEqual(inbox.messages.map(message => message.sequence), [1, 2]);
  const final = await f.call('goal_status', { goal });
  assert.equal(final.budget.used.steps, baseline.budget.used.steps);
  assert.equal(final.budget.used.no_progress, baseline.budget.used.no_progress);
  assert.equal(final.message_count, 2);
  assert.equal(f.launched(), 1, 'only the initial synthetic task was published');
  assert.equal(fs.existsSync(path.join(goal, 'mutation.lock')), false);
  assert.equal(fs.existsSync(path.join(goal, 'lock-recovery')), false);
});
