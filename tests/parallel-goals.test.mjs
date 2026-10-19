import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { callParallelGoalTool, parallelTools, isParallelGoal } from '../plugins/agent-bridge/scripts/parallel-goals.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (project, args) => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
const criteria = [{ id: 'correct', description: 'Required behavior is present', verification: 'Inspect source and output', verification_kind: 'source' }];
const checks = status => [{ criterion_id: 'correct', status, evidence: 'Independently inspected fixture source', verification_kind: 'source' }];
const contract = (allowed_edits = []) => ({ complexity: 'standard', context: 'Fixture source task', allowed_edits, preserve: [], integration: 'Host verifies and integrates the returned artifact', acceptance_criteria: criteria });
function fixture(t, options = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-goal-test-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  git(project, ['init', '--quiet']); git(project, ['config', 'user.name', 'Fixture']); git(project, ['config', 'user.email', 'fixture@example.invalid']);
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/a.txt'), 'before\n'); fs.writeFileSync(path.join(project, 'src/b.txt'), 'before\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ai/\n'); git(project, ['add', '.']); git(project, ['commit', '--quiet', '-m', 'initial']);
  const worker = { worker: 'claude', provider: 'fixture', model: 'model', effort: 'high', endpoint: 'https://example.invalid/api', mode: 'plan' };
  const participants = [{ id: 'host', kind: 'host' }, { id: 'reviewer', kind: 'worker', ...worker }, { id: 'worker2', kind: 'worker', ...worker }];
  const jobs = new Map(); let launches = 0, cancelled = 0, dispatchHook;
  const bridge = async (name, args) => {
    if (name === 'dispatch_task') {
      launches++;
      const job = path.join(args.project, '.ai/tasks/request-' + hash(args.request_id));
      fs.mkdirSync(job, { recursive: true });
      const state = { job, project: args.project, requestId: args.request_id, worker: args.worker, provider: args.provider, model: args.model, status: 'running', quality: { acceptanceStatus: 'pending' } };
      jobs.set(job, state); fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
      if (dispatchHook) await dispatchHook(state);
      return { job, status: state.status };
    }
    if (name === 'task_status') return jobs.get(args.job);
    if (name === 'cancel_task') { cancelled++; jobs.get(args.job).status = 'cancelled'; return jobs.get(args.job); }
    throw new Error('Unexpected bridge call: ' + name);
  };
  const create = { project, goal_id: 'parallel', objective: 'Complete fixture tasks', context: 'Host and two workers share isolated tasks',
    read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria, participants,
    limits: { max_steps: 12, max_reworks: 4, max_no_progress: 3, max_parallel_total: 3, max_parallel_workers: 2 }, ...options };
  let goal, seq = 0;
  const call = (name, args = {}) => callParallelGoalTool(name, { ...(goal ? { goal } : {}), ...args }, bridge);
  const setup = async tasks => { const created = await callParallelGoalTool('create_parallel_goal', create, bridge); goal = created.goal;
    if (tasks) await call('plan_goal_tasks', { operation_id: 'plan', plan_version: 0, tasks }); return created; };
  const makeTask = (id, mode = 'plan', extra = {}) => ({ id, kind: mode === 'edit' ? 'implement' : 'research', mode, depends_on: [], read_scope: ['src'], task_contract: contract(mode === 'edit' ? ['src'] : []), ...extra });
  const claim = async (id, participant_id = 'host') => call('claim_goal_task', { operation_id: 'claim-' + seq++, task_id: id, participant_id, owner_session_id: 'session' });
  const owned = (claim, operation_id) => ({ operation_id, task_id: claim.task_id, attempt_id: claim.attempt_id, owner_session_id: claim.owner_session_id, lease_token: claim.lease_token });
  const execution = claim => ({ project: claim.workspace.path, ...worker, read_scope: claim.read_scope, task_contract: claim.task_contract,
    task: 'Perform the task. ' + (claim.review_context || ''), selection_reason: 'Fixture', prepared_ref: '0'.repeat(32) });
  const start = (claim, worker = false, operation_id = 'start-' + seq++) => call('start_goal_task', { ...owned(claim, operation_id), ...(worker ? { execution: execution(claim) } : {}) });
  const submit = (claim, summary = 'Completed task') => call('submit_goal_task', { ...owned(claim, 'submit-' + seq++), summary });
  const artifact = (state, claim) => state.attempts.find(a => a.id === claim.attempt_id).artifact;
  const review = (claim, state, reviewer_task_id) => call('review_goal_task', { operation_id: 'review-' + seq++, task_id: claim.task_id, attempt_id: claim.attempt_id,
    artifact_fingerprint: artifact(state, claim).fingerprint, checks: checks('passed'), ...(reviewer_task_id ? { reviewer_task_id } : {}) });
  const integrate = claim => call('integrate_goal_task', owned(claim, 'integrate-' + seq++));
  const finish = claim => { const state = [...jobs.values()].find(j => j.project === claim.workspace.path); state.status = 'ready_for_review'; state.quality.acceptanceStatus = 'accepted'; };
  return { project, create, jobs, setup, call, makeTask, claim, owned, execution, start, submit, artifact, review, integrate, finish,
    setHook: hook => { dispatchHook = hook; }, launches: () => launches, cancelled: () => cancelled, goal: () => goal };
}

test('schemas expose seven opt-in tools and clean Git requirement preserves legacy source', async t => {
  assert.equal(parallelTools.length, 7); const f = fixture(t); const g = await f.setup(); assert.equal(g.schema, 2); assert.equal(isParallelGoal(g.goal), true);
  const reused = await callParallelGoalTool('create_parallel_goal', f.create, () => {}); assert.equal(reused.reused, true);
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'user edits');
  await assert.rejects(callParallelGoalTool('create_parallel_goal', { ...f.create, goal_id: 'second' }, () => {}), /clean Git|committed source/);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'user edits');
});
test('host edit, independent artifact-bound review, serial integration and final source acceptance', async t => {
  const f = fixture(t);
  await f.setup([f.makeTask('implement', 'edit'), f.makeTask('review', 'plan', { kind: 'review', review_of: 'implement' })]);
  const host = await f.claim('implement'); await f.start(host);
  fs.writeFileSync(path.join(host.workspace.path, 'src/a.txt'), 'implemented\n');
  const submitted = await f.submit(host); assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'before\n');
  await assert.rejects(f.review(host, submitted), /independent worker review/);
  const reviewer = await f.claim('review', 'reviewer'); assert.equal(fs.readFileSync(path.join(reviewer.workspace.path, 'src/a.txt'), 'utf8'), 'implemented\n');
  const invalid = f.execution(reviewer); invalid.task = 'Review without the artifact marker';
  await assert.rejects(f.call('start_goal_task', { ...f.owned(reviewer, 'bad-review-start'), execution: invalid }), /exact artifact marker/);
  await f.start(reviewer, true); await assert.rejects(f.submit(reviewer), /ended execution/);
  f.finish(reviewer); const reviewOutput = await f.submit(reviewer, 'The proposed implementation matches its criteria');
  await f.review(reviewer, reviewOutput); await f.integrate(reviewer);
  await f.review(host, submitted, 'review'); await f.integrate(host);
  const status = await f.call('goal_status'); assert.ok(status.tasks.every(task => task.status === 'integrated'));
  const complete = await f.call('record_goal_review', { review_id: 'all', snapshot_fingerprint: status.snapshot_fingerprint, checks: checks('passed') });
  assert.equal(complete.status, 'completed'); assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'implemented\n');
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'IMPLEMENTED\n'); const stale = await f.call('goal_status'); assert.notEqual(stale.status, 'completed'); assert.equal(stale.review.status, 'stale');
  assert.ok(!JSON.stringify(stale).includes(host.lease_token));
});
test('dispatch releases goal mutex, same operation does not duplicate active launch, and late cancellation stops worker', async t => {
  const f = fixture(t); await f.setup([f.makeTask('worker'), f.makeTask('host')]); const worker = await f.claim('worker', 'reviewer');
  let release; const wait = new Promise(resolve => { release = resolve; }); let reached;
  const started = new Promise(resolve => { reached = resolve; }); f.setHook(async () => { reached(); await wait; });
  const args = { ...f.owned(worker, 'start'), execution: f.execution(worker) }; const pending = f.call('start_goal_task', args); await started;
  const host = await f.claim('host'); assert.equal(host.capacity.total, 2);
  const replay = await f.call('start_goal_task', args); assert.equal(replay.reused, true); assert.equal(f.launches(), 1);
  const cancelled = await f.call('advance_goal', { operation_id: 'cancel', action: 'cancel' }); assert.equal(cancelled.status, 'cancelling');
  release(); await pending; assert.ok(f.cancelled() >= 1);
  const acknowledged = await f.call('submit_goal_task', { ...f.owned(host, 'host-stopped'), summary: 'Host stopped editing', outcome: 'cancelled' });
  assert.equal(acknowledged.status, 'cancelled'); assert.equal(acknowledged.capacity.total, 0);
});
test('unknown dispatch retains budget and capacity, exact retry uses the stable request identity', async t => {
  const f = fixture(t); await f.setup([f.makeTask('work')]); const worker = await f.claim('work', 'reviewer'); let dropped = true;
  f.setHook(() => { if (dropped) { dropped = false; throw new Error('Lost connection after creating the job'); } });
  const args = { ...f.owned(worker, 'start'), execution: f.execution(worker) }; await assert.rejects(f.call('start_goal_task', args), /Lost connection/);
  const status = await f.call('goal_status'); assert.equal(status.capacity.total, 1); assert.equal(status.budget.used.steps, 1);
  await f.call('start_goal_task', args); assert.equal(f.launches(), 1); // Read reconciliation located the first job.
  f.finish(worker); const result = await f.submit(worker); await f.review(worker, result); const done = await f.integrate(worker);
  assert.equal(done.capacity.total, 0);
});
test('task messages derive task and attempt from an ended linked source job', async t => {
  const f = fixture(t); await f.setup([f.makeTask('research')]); const worker = await f.claim('research', 'reviewer'); await f.start(worker, true);
  const job = [...f.jobs.keys()][0];
  await assert.rejects(f.call('send_goal_message', { message_id: 'early', to: 'host', type: 'note', body: 'early', source_job: job }), /ended worker/);
  f.finish(worker);
  const message = await f.call('send_goal_message', { message_id: 'ready', to: 'host', type: 'answer', body: 'Found useful evidence', source_job: job });
  assert.equal(message.message.from, 'reviewer'); assert.equal(message.message.task_id, 'research'); assert.equal(message.message.attempt_id, worker.attempt_id);
  const inbox = await f.call('read_goal_messages', { recipient: 'host' }); assert.equal(inbox.messages.length, 1);
});

test('reserved attempts consume cumulative budget, while exact-budget final verification remains possible', async t => {
  const f = fixture(t, { limits: { max_steps: 1, max_reworks: 0, max_no_progress: 2, max_parallel_total: 3, max_parallel_workers: 2 } });
  await f.setup([f.makeTask('only')]); const host = await f.claim('only'); assert.equal(host.budget.used.steps, 1);
  await f.start(host, false, 'host-start');
  await assert.rejects(f.call('integrate_goal_task', f.owned(host, 'host-start')), /operation_id conflicts/);
  const submitted = await f.submit(host, 'Research conclusion'); await f.review(host, submitted); const integrated = await f.integrate(host);
  assert.ok(integrated.budget.exhausted.includes('max_steps'));
  const complete = await f.call('record_goal_review', { review_id: 'exact-limit', snapshot_fingerprint: integrated.snapshot_fingerprint, checks: checks('passed') });
  assert.equal(complete.status, 'completed');
});
test('source snapshot failure does not prevent cancellation or explicit host stopped acknowledgment', async t => {
  const f = fixture(t); await f.setup([f.makeTask('host')]); const host = await f.claim('host'); await f.start(host);
  fs.symlinkSync('/tmp', path.join(f.project, 'src/unsafe'));
  const cancelled = await f.call('advance_goal', { operation_id: 'stop', action: 'cancel' }); assert.equal(cancelled.status, 'cancelling'); assert.match(cancelled.snapshot_error, /symlink/);
  const stopped = await f.call('submit_goal_task', { ...f.owned(host, 'stopped'), summary: 'Stopped writer with invalid source retained', outcome: 'cancelled' });
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.capacity.total, 0);
});
