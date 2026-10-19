import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// No worker process or external inference is invoked.
import { goalTools, callGoalTool } from '../plugins/agent-bridge/scripts/goals.mjs';
const CRITERIA = [{ id: 'overall', description: 'The source meets the complete goal.', verification: 'Host reads actual fixture source.', verification_kind: 'source' }];
const PARTICIPANTS = [
  { id: 'implementer', worker: 'claude', provider: 'fixture-provider', model: 'fixture-model', effort: 'high', endpoint: 'http://127.0.0.1:9000', mode: 'edit' },
  { id: 'reviewer', worker: 'claude', provider: 'fixture-provider', model: 'fixture-model', effort: 'high', endpoint: 'http://127.0.0.1:9000', mode: 'plan' },
];
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-goal-adversarial-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'src-other'));
  fs.writeFileSync(path.join(root, 'src/value.txt'), 'before');
  fs.writeFileSync(path.join(root, 'src-other/private.txt'), 'outside');
  const calls = [], jobs = new Map();
  let dispatchFailure = null;
  const bridge = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'task_status' || name === 'task_result') {
      const job = jobs.get(args.job);
      assert.ok(job, 'fixture cannot return status of an unregistered job');
      return structuredClone(job);
    }
    if (name === 'cancel_task') {
      const job = jobs.get(args.job);
      assert.ok(job, 'fixture cannot cancel an unregistered job');
      job.status = 'cancelled';
      return structuredClone(job);
    }
    if (name === 'dispatch_task' || name === 'continue_task') {
      if (dispatchFailure) throw new Error(dispatchFailure);
      const repeated = [...jobs.values()].find(x => x.requestId === args.request_id);
      if (repeated) return { ...structuredClone(repeated), reused: true };
      const id = 'request-' + createHash('sha256').update(args.request_id).digest('hex'), job = path.join(root, '.ai/tasks', id);
      fs.mkdirSync(job, { recursive: true });
      const state = { schema: 1, id, job, project: root, host: process.env.AGENT_BRIDGE_HOST || 'generic',
        worker: args.worker, provider: args.provider, model: args.model, effort: args.effort, mode: args.mode,
        requestId: args.request_id, status: 'ready_for_review', readScope: args.read_scope,
        destination: { provider: args.provider, endpoint: args.endpoint }, taskContract: args.task_contract,
        quality: { contract: 'structured', acceptanceStatus: 'accepted' }, review: { id: 'fixture-review', status: 'accepted', remainingCriteria: [] } };
      fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
      fs.writeFileSync(path.join(job, 'result.md'), 'Synthetic task returned; host accepted.');
      jobs.set(job, state);
      return structuredClone(state);
    }
    throw new Error('Unexpected bridge call ' + name);
  };
  const call = (name, args) => callGoalTool(name, args, bridge);
  const args = { project: root, goal_id: 'adversarial-goal', objective: 'Verify goal boundaries.', context: 'Synthetic tests only.',
    read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: CRITERIA,
    participants: PARTICIPANTS, limits: { max_steps: 8, max_reworks: 4, max_no_progress: 2 } };
  const create = overrides => call('create_goal', { ...structuredClone(args), ...overrides });
  return { root, calls, jobs, args, call, create, setDispatchFailure: value => { dispatchFailure = value; } };
}
const goalFile = goal => path.basename(goal) === 'goal.json' ? goal : path.join(goal, 'goal.json');
const checks = (status = 'passed', evidence = 'Host inspected the complete fixture source.') => [{ criterion_id: 'overall', status, verification_kind: 'source', evidence }];
function protectedState(file) {
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Rejected-operation audit events/timestamps are permitted. Scope, participants,
  // budgets, accepted work and messages are the consequential state boundaries.
  const keys = ['schema', 'goal', 'id', 'goalId', 'goal_id', 'project', 'objective', 'context',
    'read_scope', 'readScope', 'allowed_edits', 'allowedEdits', 'acceptance_criteria', 'acceptanceCriteria',
    'participants', 'limits', 'steps', 'messages', 'reviews', 'review', 'counters', 'budget', 'budgets',
    'stepsUsed', 'reworksUsed', 'noProgressCount', 'noProgress', 'no_progress', 'reworkCount', 'stepCount', 'config', 'contract', 'shared_context'];
  return Object.fromEntries(keys.filter(k => Object.hasOwn(state, k)).map(k => [k, state[k]]));
}
async function rejectWithoutChange(f, goal, name, args) {
  const file = goalFile(goal), before = protectedState(file);
  const inferenceBefore = f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length;
  await assert.rejects(() => f.call(name, { goal, ...args }));
  assert.deepEqual(protectedState(file), before, 'invalid input must not change consequential goal state');
  assert.equal(f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length, inferenceBefore);
}
function execution(f, changes = {}) {
  return { project: f.root, task: 'Perform a bounded synthetic source check.', worker: 'claude', provider: 'fixture-provider',
    model: 'fixture-model', effort: 'high', mode: 'edit', selection_reason: 'Explicit synthetic test participant.',
    read_scope: ['src'], endpoint: 'http://127.0.0.1:9000', prepared_ref: '0'.repeat(32),
    task_contract: { complexity: 'standard', context: 'Fixture only.', allowed_edits: ['src'], preserve: [],
      integration: 'Host accepts actual source.', acceptance_criteria: CRITERIA }, ...changes };
}

test('goal tools expose strict schemas and the supported protocol only', () => {
  assert.deepEqual(goalTools.map(x => x.name).sort(), ['advance_goal', 'create_goal', 'goal_status', 'read_goal_messages', 'record_goal_review', 'review_goal_design', 'send_goal_message', 'submit_goal_design']);
  for (const tool of goalTools) {
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.length > 0, tool.name);
  }
});

test('traversal and reserved identifiers cannot escape or poison persisted maps', async t => {
  const f = fixture(t);
  for (const goal_id of ['.', '..', '../escape', '/tmp/escape']) {
    await assert.rejects(() => f.create({ goal_id }), 'unsafe path goal ID ' + goal_id);
  }
  // Reserved object keys may either be explicitly rejected or safely supported.
  for (const goal_id of ['__proto__', 'constructor', 'prototype']) {
    let made;
    try { made = await f.create({ goal_id, objective: 'Safe reserved ID ' + goal_id }); } catch { continue; }
    assert.ok(path.isAbsolute(made.goal));
    assert.equal(path.dirname(made.goal), path.join(f.root, '.ai/goals'));
    const status = await f.call('goal_status', { goal: made.goal });
    assert.match(JSON.stringify(status), new RegExp('Safe reserved ID ' + goal_id));
    const repeated = await f.create({ goal_id, objective: 'Safe reserved ID ' + goal_id });
    assert.equal(repeated.goal, made.goal);
  }
  const { goal } = await f.create();
  for (const message_id of ['__proto__', 'constructor', '..']) {
    const message = { goal, message_id, to: 'reviewer', type: 'question', body: 'Reserved-key message ' + message_id };
    try { await f.call('send_goal_message', message); } catch { continue; }
    await f.call('send_goal_message', message);
    const inbox = await f.call('read_goal_messages', { goal, recipient: 'reviewer' });
    assert.ok(JSON.stringify(inbox).includes(message.body));
    await assert.rejects(() => f.call('send_goal_message', { ...message, body: 'Conflicting replacement body.' }));
    assert.ok(!JSON.stringify(await f.call('read_goal_messages', { goal, recipient: 'reviewer' })).includes('Conflicting replacement body.'));
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('create rejects src-other as an edit scope under src and rejects escaping symlinks', async t => {
  const f = fixture(t);
  await assert.rejects(() => f.create({ allowed_edits: ['src-other'] }));
  fs.symlinkSync(path.join(f.root, 'src-other'), path.join(f.root, 'src/linked'));
  await assert.rejects(async () => {
    const { goal } = await f.create();
    await f.call('goal_status', { goal });
  }, 'snapshot must not follow or silently omit an out-of-scope symlink');
});

test('a read-scope root symlink cannot escape the project', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-goal-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'private.txt'), 'External project data.');
  fs.symlinkSync(outside, path.join(f.root, 'alias'));
  await assert.rejects(async () => {
    const { goal } = await f.create({ read_scope: ['alias'], allowed_edits: ['alias'] });
    await f.call('goal_status', { goal });
  });
});

test('fixed goal identity rejects conflicting content without overwriting the original', async t => {
  const f = fixture(t), { goal } = await f.create();
  const original = fs.readFileSync(goalFile(goal), 'utf8');
  const same = await f.create();
  assert.equal(same.goal, goal);
  await assert.rejects(() => f.create({ objective: 'Conflicting replacement goal.' }));
  assert.equal(fs.readFileSync(goalFile(goal), 'utf8'), original);
  await rejectWithoutChange(f, goal, 'goal_status', { unknown: 'not in schema' });
});

test('unknown recipients, forged source jobs, unknown reply links and sender injection are mutation-free', async t => {
  const f = fixture(t), { goal } = await f.create();
  const base = { message_id: 'forged', to: 'reviewer', type: 'question', body: 'A bounded question.' };
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, to: 'unregistered-agent' });
  await rejectWithoutChange(f, goal, 'read_goal_messages', { recipient: 'unregistered-agent' });
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, source_job: '/tmp/unrelated-job' });
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, reply_to: 'missing-message' });
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, from: 'implementer' });
  const forgedJob = path.join(f.root, '.ai/tasks/unlinked-job');
  fs.mkdirSync(forgedJob, { recursive: true });
  fs.writeFileSync(path.join(forgedJob, 'state.json'), JSON.stringify({ schema: 1, id: 'unlinked-job', job: forgedJob,
    project: f.root, status: 'ready_for_review', host: process.env.AGENT_BRIDGE_HOST || 'generic' }));
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, source_job: forgedJob });
});

test('message artifacts cannot cross lexical or symlink scope boundaries', async t => {
  const f = fixture(t), { goal } = await f.create();
  const base = { message_id: 'bad-artifact', to: 'reviewer', type: 'question', body: 'Inspect source.' };
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, artifact_refs: ['src-other/private.txt'] });
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, artifact_refs: ['src/../src-other/private.txt'] });
  fs.symlinkSync(path.join(f.root, 'src-other'), path.join(f.root, 'src/linked'));
  await rejectWithoutChange(f, goal, 'send_goal_message', { ...base, artifact_refs: ['src/linked/private.txt'] });
});

test('snapshots bind file bytes, deletions and additions and ignore private metadata', async t => {
  const f = fixture(t), { goal } = await f.create({ read_scope: ['.'] });
  const fp = async () => (await f.call('goal_status', { goal })).snapshot_fingerprint;
  const initial = await fp();
  assert.equal(typeof initial, 'string'); assert.ok(initial.length > 20);
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'after!');
  const sameSizeChanged = await fp(); assert.notEqual(sameSizeChanged, initial);
  fs.unlinkSync(path.join(f.root, 'src/value.txt'));
  const deleted = await fp(); assert.notEqual(deleted, sameSizeChanged);
  fs.writeFileSync(path.join(f.root, 'src/new.txt'), 'after!');
  const added = await fp(); assert.notEqual(added, deleted);
  fs.mkdirSync(path.join(f.root, '.git'));
  fs.writeFileSync(path.join(f.root, '.git/HEAD'), 'metadata-only');
  fs.writeFileSync(path.join(f.root, '.ai/unrelated.txt'), 'metadata-only');
  assert.equal(await fp(), added);
  assert.equal(f.calls.length, 0, 'snapshot/status must not launch or consult an absent job');
});

test('old snapshot cannot accept changed source and a completed goal loses acceptance after source changes', async t => {
  const f = fixture(t), { goal } = await f.create();
  const old = await f.call('goal_status', { goal });
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'after!');
  await rejectWithoutChange(f, goal, 'record_goal_review', { review_id: 'old-source', snapshot_fingerprint: old.snapshot_fingerprint, checks: checks() });
  const current = await f.call('goal_status', { goal });
  const completed = await f.call('record_goal_review', { goal, review_id: 'accepted', snapshot_fingerprint: current.snapshot_fingerprint, checks: checks() });
  assert.equal(completed.status, 'completed');
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'other!');
  const stale = await f.call('goal_status', { goal });
  assert.notEqual(stale.status, 'completed');
  assert.notEqual(stale.snapshot_fingerprint, current.snapshot_fingerprint);
});

test('whole-goal review requires every criterion exactly once and disallows host impersonation', async t => {
  const f = fixture(t), { goal } = await f.create();
  const s = await f.call('goal_status', { goal });
  for (const invalid of [[], [...checks(), ...checks()], [{ ...checks()[0], criterion_id: 'unknown' }], [{ ...checks()[0], verification_kind: 'runtime' }]]) {
    await rejectWithoutChange(f, goal, 'record_goal_review', { review_id: 'invalid-review', snapshot_fingerprint: s.snapshot_fingerprint, checks: invalid });
  }
  const original = process.env.AGENT_BRIDGE_HOST;
  process.env.AGENT_BRIDGE_HOST = original === 'claude' ? 'codex' : 'claude';
  try {
    await rejectWithoutChange(f, goal, 'record_goal_review', { review_id: 'wrong-host', snapshot_fingerprint: s.snapshot_fingerprint, checks: checks() });
  } finally {
    if (original === undefined) delete process.env.AGENT_BRIDGE_HOST; else process.env.AGENT_BRIDGE_HOST = original;
  }
});

test('execution must preserve registered participant, project, mode, endpoint and exact scope boundaries', async t => {
  const f = fixture(t), { goal } = await f.create();
  const badExecutions = [
    execution(f, { project: path.dirname(f.root) }),
    execution(f, { worker: 'zcode' }),
    execution(f, { provider: 'another-provider' }),
    execution(f, { model: 'another-model' }),
    execution(f, { effort: 'low' }),
    execution(f, { endpoint: 'https://other.example.test' }),
    execution(f, { read_scope: ['src-other'] }),
    execution(f, { task_contract: { ...execution(f).task_contract, allowed_edits: ['src-other'] } }),
  ];
  for (const invalid of badExecutions) {
    await rejectWithoutChange(f, goal, 'advance_goal', { operation_id: 'invalid-dispatch', action: 'dispatch', participant_id: 'implementer', execution: invalid });
  }
  await rejectWithoutChange(f, goal, 'advance_goal', { operation_id: 'unknown-participant', action: 'dispatch', participant_id: 'unknown', execution: execution(f) });
  await rejectWithoutChange(f, goal, 'advance_goal', { operation_id: 'escalate-reviewer', action: 'dispatch', participant_id: 'reviewer', execution: execution(f) });
  assert.equal(f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length, 0);
});

test('rewritten evidence for the same failed source outcome cannot reset the no-progress budget', async t => {
  const f = fixture(t), { goal } = await f.create({ limits: { max_steps: 20, max_reworks: 20, max_no_progress: 2 } });
  for (let i = 0; i < 3; i++) {
    try {
      await f.call('advance_goal', { goal, operation_id: 'unchanged-step-' + i, action: 'dispatch', participant_id: 'implementer', execution: execution(f) });
    } catch (error) {
      assert.match(error.message, /budget|progress|limit/i);
      break;
    }
    const { snapshot_fingerprint } = await f.call('goal_status', { goal });
    await f.call('record_goal_review', { goal, review_id: 'same-outcome-' + i, snapshot_fingerprint,
      checks: checks('failed', 'Equivalent failure described with new prose, report number ' + i) });
  }
  const before = f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length;
  assert.ok(before >= 1, 'at least one valid inference-free fixture step must have ended');
  await assert.rejects(() => f.call('advance_goal', { goal, operation_id: 'after-no-progress', action: 'dispatch', participant_id: 'implementer', execution: execution(f) }),
    'Repeated ended steps on unchanged source must exhaust max_no_progress despite changing evidence text');
  assert.equal(f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length, before);
});

for (const stop of ['pause', 'cancel']) {
  test(stop + ' prevents an uncertain pending dispatch from being replayed into a new worker', async t => {
    const f = fixture(t), { goal } = await f.create();
    const pending = { goal, operation_id: 'uncertain-dispatch', action: 'dispatch', participant_id: 'implementer', execution: execution(f) };
    f.setDispatchFailure('Synthetic transport failure before worker launch; outcome is uncertain.');
    try { await f.call('advance_goal', pending); } catch {}
    const attempts = () => f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length;
    assert.equal(attempts(), 1, 'valid first request must reach the bridge stub');
    await f.call('advance_goal', { goal, operation_id: 'stop-pending', action: stop, reason: 'Host explicitly stops new work.' });
    f.setDispatchFailure(null);
    try { await f.call('advance_goal', pending); } catch {}
    assert.equal(attempts(), 1, stop + ' must be checked before retrying saved pending operation');
    assert.equal(f.jobs.size, 0);
  });
}

test('a later failed or unverified whole-goal review revokes completed status on unchanged source', async t => {
  for (const outcome of ['failed', 'unverified']) {
    const f = fixture(t), { goal } = await f.create();
    const { snapshot_fingerprint } = await f.call('goal_status', { goal });
    const passed = await f.call('record_goal_review', { goal, review_id: 'initial-pass', snapshot_fingerprint, checks: checks() });
    assert.equal(passed.status, 'completed');
    const revised = await f.call('record_goal_review', { goal, review_id: 'corrected-evidence', snapshot_fingerprint,
      checks: checks(outcome, 'Host corrected an earlier acceptance mistake.') });
    assert.notEqual(revised.status, 'completed', outcome + ' evidence cannot coexist with completed goal');
    assert.notEqual((await f.call('goal_status', { goal })).status, 'completed');
  }
});

test('repeated unchanged goal reviews alone cannot evade no-progress by rewriting evidence', async t => {
  const f = fixture(t), { goal } = await f.create({ limits: { max_steps: 20, max_reworks: 20, max_no_progress: 2 } });
  const { snapshot_fingerprint } = await f.call('goal_status', { goal });
  for (let i = 0; i < 4; i++) {
    await f.call('record_goal_review', { goal, review_id: 'rewritten-review-' + i, snapshot_fingerprint,
      checks: checks('failed', 'Unchanged outcome restated with arbitrary evidence prose ' + i) });
  }
  await assert.rejects(() => f.call('advance_goal', { goal, operation_id: 'after-review-spin', action: 'dispatch', participant_id: 'implementer', execution: execution(f) }));
  assert.equal(f.calls.filter(x => /^(dispatch|continue)_task$/.test(x.name)).length, 0);
});

test('deletions and new source files also invalidate completed acceptance', async t => {
  for (const mutation of ['delete', 'add']) {
    const f = fixture(t), { goal } = await f.create();
    const { snapshot_fingerprint } = await f.call('goal_status', { goal });
    const completed = await f.call('record_goal_review', { goal, review_id: 'accepted', snapshot_fingerprint, checks: checks() });
    assert.equal(completed.status, 'completed');
    if (mutation === 'delete') fs.unlinkSync(path.join(f.root, 'src/value.txt'));
    else fs.writeFileSync(path.join(f.root, 'src/new.txt'), 'A newly introduced source file.');
    const changed = await f.call('goal_status', { goal });
    assert.notEqual(changed.snapshot_fingerprint, snapshot_fingerprint, mutation + ' must change source version');
    assert.notEqual(changed.status, 'completed', mutation + ' must invalidate accepted evidence');
  }
});
