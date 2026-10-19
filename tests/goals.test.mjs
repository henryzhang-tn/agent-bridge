import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { callGoalTool } from '../plugins/agent-bridge/scripts/goals.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const criteria = [{ id: 'works', description: 'source is correct', verification: 'host reads it', verification_kind: 'source' }];
const checks = [{ criterion_id: 'works', status: 'passed', verification_kind: 'source', evidence: 'Host independently read and compared the source.' }];
const select = { worker: 'claude', provider: 'fixture', model: 'glm-5.3', effort: 'high', endpoint: 'https://example.com/inference', mode: 'plan' };
function fixture(t, limits = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'goal-reference-')));
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/a.txt'), 'initial');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  let launched = 0; let loseReply = false;
  const states = new Map();
  const bridge = async (name, args) => {
    if (name === 'dispatch_task' || name === 'continue_task') {
      const job = path.join(project, '.ai/tasks/request-' + hash(args.request_id));
      if (!states.has(job)) {
        launched++; fs.mkdirSync(job, { recursive: true }); fs.writeFileSync(path.join(job, 'state.json'), '{}');
        states.set(job, { job, requestId: args.request_id, worker: args.worker, provider: args.provider, model: args.model,
          status: 'ready_for_review', quality: { acceptanceStatus: 'accepted' } });
      }
      if (loseReply) { loseReply = false; throw new Error('lost reply'); }
      return states.get(job);
    }
    if (name === 'task_status') return states.get(args.job);
    if (name === 'cancel_task') { const state = states.get(args.job); state.status = 'cancelled'; return state; }
    throw new Error('unexpected bridge call ' + name);
  };
  const call = (name, args) => callGoalTool(name, args, bridge);
  const make = () => call('create_goal', { project, goal_id: 'test-goal', objective: 'Complete fixture', context: 'bounded fixture',
    read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria,
    participants: ['impl', 'reviewer'].map(id => ({ id, ...select })), limits: { max_steps: 4, max_reworks: 1, max_no_progress: 4, ...limits } });
  const execution = task => ({ ...select, project, read_scope: ['src'], task, selection_reason: 'Explicit test selection', prepared_ref: 'a'.repeat(32),
    task_contract: { complexity: 'standard', context: 'fixture', allowed_edits: [], preserve: [], integration: 'host validation', acceptance_criteria: criteria } });
  return { project, call, make, execution, states, launchCount: () => launched, loseReply: () => { loseReply = true; } };
}
test('create, dispatch, relay, rework and completion bind exact source content', async t => {
  const f = fixture(t); const created = await f.make(); const goal = created.goal;
  assert.equal((await f.make()).reused, true);
  const firstArgs = { goal, action: 'dispatch', operation_id: 'first', participant_id: 'impl', execution: f.execution('propose') };
  const first = await f.call('advance_goal', firstArgs);
  assert.equal((await f.call('advance_goal', firstArgs)).reused, true); assert.equal(f.launchCount(), 1);
  await f.call('send_goal_message', { goal, message_id: 'question', source_job: first.steps[0].job, to: 'reviewer', type: 'question', body: 'Please verify', artifact_refs: ['src/a.txt'] });
  assert.equal((await f.call('read_goal_messages', { goal, recipient: 'reviewer' })).messages[0].from, 'impl');
  const second = await f.call('advance_goal', { goal, action: 'dispatch', operation_id: 'second', participant_id: 'reviewer', execution: f.execution('review') });
  const reviewArgs = { goal, review_id: 'failure', snapshot_fingerprint: second.snapshot_fingerprint, checks: [{ ...checks[0], status: 'failed' }] };
  await f.call('record_goal_review', reviewArgs);
  const third = await f.call('advance_goal', { goal, action: 'continue', operation_id: 'third', participant_id: 'impl', execution: { ...f.execution('fix'), job: first.steps[0].job } });
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'changed');
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'stale', snapshot_fingerprint: third.snapshot_fingerprint, checks }), /changed/);
  const status = await f.call('goal_status', { goal });
  const done = await f.call('record_goal_review', { goal, review_id: 'done', snapshot_fingerprint: status.snapshot_fingerprint, checks });
  assert.equal(done.status, 'completed');
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'another');
  assert.notEqual((await f.call('goal_status', { goal })).status, 'completed');
  assert.equal(f.launchCount(), 3);
});
test('lost replies reconcile existing execution and replays never dispatch twice', async t => {
  const f = fixture(t); const { goal } = await f.make(); f.loseReply();
  const args = { goal, action: 'dispatch', operation_id: 'first', participant_id: 'impl', execution: f.execution('propose') };
  await assert.rejects(f.call('advance_goal', args), /lost reply/);
  const reconciled = await f.call('goal_status', { goal });
  assert.equal(reconciled.steps[0].status, 'ready_for_review'); assert.equal(f.launchCount(), 1);
  await f.call('advance_goal', args); assert.equal(f.launchCount(), 1);
  await assert.rejects(f.call('advance_goal', { ...args, execution: f.execution('changed') }), /conflicts/);
});
test('freeze scope, endpoint and cumulative budgets; messages and restart do not replenish', async t => {
  const f = fixture(t, { max_steps: 1 }); const { goal } = await f.make();
  const args = { goal, action: 'dispatch', operation_id: 'first', participant_id: 'impl', execution: f.execution('propose') };
  for (const change of [{ endpoint: 'https://other.example' }, { mode: 'edit' }, { read_scope: ['.'] }])
    await assert.rejects(f.call('advance_goal', { ...args, execution: { ...args.execution, ...change } }));
  await f.call('advance_goal', args);
  await f.call('advance_goal', { goal, operation_id: 'pause', action: 'pause' });
  await f.call('advance_goal', { goal, operation_id: 'resume', action: 'resume' });
  await assert.rejects(f.call('advance_goal', { ...args, operation_id: 'new' }), /budget/);
  const status = await f.call('goal_status', { goal }); assert.equal(status.budget.used.steps, 1);
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'done', snapshot_fingerprint: status.snapshot_fingerprint, checks })).status, 'completed');
});
test('new files, removed files, symlinks and unaccepted task reviews cannot bypass acceptance', async t => {
  const f = fixture(t); const { goal } = await f.make();
  const before = await f.call('goal_status', { goal }); fs.writeFileSync(path.join(f.project, 'src/b.txt'), 'new');
  const added = await f.call('goal_status', { goal }); assert.notEqual(added.snapshot_fingerprint, before.snapshot_fingerprint);
  fs.unlinkSync(path.join(f.project, 'src/b.txt')); assert.equal((await f.call('goal_status', { goal })).snapshot_fingerprint, before.snapshot_fingerprint);
  const step = await f.call('advance_goal', { goal, action: 'dispatch', operation_id: 'first', participant_id: 'impl', execution: f.execution('propose') });
  f.states.get(step.steps[0].job).quality.acceptanceStatus = 'pending';
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'bad', snapshot_fingerprint: step.snapshot_fingerprint, checks }), /accepted child/);
  fs.symlinkSync('/etc/passwd', path.join(f.project, 'src/escape'));
  await assert.rejects(f.call('goal_status', { goal }), /symlinks/);
});
test('cancel remains available with invalid source and terminal status cannot be resumed', async t => {
  const f = fixture(t); const { goal } = await f.make();
  const step = await f.call('advance_goal', { goal, action: 'dispatch', operation_id: 'first', participant_id: 'impl', execution: f.execution('propose') });
  f.states.get(step.steps[0].job).status = 'running';
  fs.symlinkSync('/etc/passwd', path.join(f.project, 'src/escape'));
  const cancelled = await f.call('advance_goal', { goal, action: 'cancel', operation_id: 'cancel' });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.steps[0].status, 'cancelled');
  assert.match(cancelled.snapshot_error, /symlinks/);
  await assert.rejects(f.call('advance_goal', { goal, action: 'pause', operation_id: 'pause' }), /Terminal/);
  fs.unlinkSync(path.join(f.project, 'src/escape'));
  await assert.rejects(f.call('advance_goal', { goal, action: 'resume', operation_id: 'resume' }), /Terminal/);
});
