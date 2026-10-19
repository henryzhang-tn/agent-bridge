import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inspectProject, createWorkspace, collectArtifact, integrateArtifact } from '../plugins/agent-bridge/scripts/goal-workspaces.mjs';

// These tests use real isolated Git worktrees and a local Bridge stub. They never
// launch a worker process, contact a provider, or edit the caller's checkout.
const hash = value => createHash('sha256').update(value).digest('hex');
const criteria = [{ id: 'source', description: 'The assigned source is correct.',
  verification: 'Inspect the actual artifact source.', verification_kind: 'source' }];
const checks = (status = 'passed', evidence = 'Host independently inspected the exact artifact source.') => [
  { criterion_id: 'source', status, evidence, verification_kind: 'source' },
];
const selection = { worker: 'claude', provider: 'fixture', model: 'fixture-model', effort: 'high',
  endpoint: 'https://example.test/inference', mode: 'edit' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-goal-adversarial-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, 'src'));
  for (const file of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(project, 'src', file + '.txt'), 'initial ' + file + '\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ai/\n');
  git(project, 'init', '-q');
  git(project, 'config', 'user.name', 'Goal Fixture');
  git(project, 'config', 'user.email', 'goal-fixture@example.test');
  git(project, 'add', '.');
  git(project, 'commit', '-qm', 'Fixture baseline');
  const calls = [], jobs = new Map();
  const bridge = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'task_status' || name === 'task_result') {
      assert.ok(jobs.has(args.job), 'Only known fixture jobs can be queried.');
      return structuredClone(jobs.get(args.job));
    }
    if (name === 'dispatch_task' || name === 'continue_task') {
      const job = path.join(args.project, '.ai/tasks/request-' + hash(args.request_id));
      if (!jobs.has(job)) {
        const state = { schema: 1, id: path.basename(job), job, project: args.project,
          host: process.env.AGENT_BRIDGE_HOST || 'generic', requestId: args.request_id,
          ...Object.fromEntries(['worker', 'provider', 'model', 'effort', 'mode'].map(k => [k, args[k]])),
          readScope: args.read_scope, taskContract: args.task_contract,
          destination: { provider: args.provider, endpoint: args.endpoint }, status: 'running',
          quality: { contract: 'structured', acceptanceStatus: 'pending' } };
        jobs.set(job, state); fs.mkdirSync(job, { recursive: true });
        fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
      }
      return structuredClone(jobs.get(job));
    }
    if (name === 'cancel_task') {
      assert.ok(jobs.has(args.job));
      // A cancellation request is not evidence that the process has stopped.
      return structuredClone(jobs.get(args.job));
    }
    throw new Error('Unexpected fixture Bridge call: ' + name);
  };
  const call = async (name, args) => (await import('../plugins/agent-bridge/scripts/parallel-goals.mjs')).callParallelGoalTool(name, args, bridge);
  function endJob(job, accepted = true) {
    const state = jobs.get(job); assert.ok(state, 'Expected a dispatched job before completing it.');
    state.status = 'ready_for_review';
    state.quality.acceptanceStatus = accepted ? 'accepted' : 'pending';
    state.review = { id: 'fixture-review', status: accepted ? 'accepted' : 'incomplete', remainingCriteria: accepted ? [] : ['source'] };
    fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(job, 'result.md'), 'Synthetic result for independent controller testing.\n');
  }
  return { project, call, calls, jobs, endJob };
}

function artifactFixture(f, goalId, file = 'a') {
  const baseline = inspectProject(f.project), goal = path.join(f.project, '.ai/goals', goalId);
  const workspace = createWorkspace({ project: f.project, goal, workspace_id: 'attempt-1', base_revision: baseline.base_revision });
  fs.writeFileSync(path.join(workspace.path, 'src', file + '.txt'), 'changed ' + file + '\n');
  const artifact = collectArtifact({ workspace, allowed_edits: ['src/' + file + '.txt'], read_scope: ['src'], output_dir: path.join(goal, 'artifacts/first') });
  return { goal, workspace, artifact };
}

const contract = (file = 'a', mode = 'edit') => ({ complexity: 'standard', context: 'Independent synthetic test.',
  allowed_edits: mode === 'edit' ? ['src/' + file + '.txt'] : [], preserve: [],
  integration: 'Host verifies the submitted artifact, then serially integrates it.', acceptance_criteria: criteria });
const taskCard = (id, file = 'a', extra = {}) => ({ id, kind: 'implement', depends_on: [], read_scope: ['src'],
  mode: 'edit', task_contract: contract(file), ...extra });
const owner = (claim, operation_id) => ({ goal: claim.goal, task_id: claim.task_id, attempt_id: claim.attempt_id,
  owner_session_id: claim.owner_session_id, lease_token: claim.lease_token, operation_id });
const taskState = (result, id) => result.tasks.find(t => t.id === id);
const attemptState = (result, claim) => result.attempts.find(a => a.id === claim.attempt_id);
async function makeGoal(f, tasks, limits = {}) {
  const made = await f.call('create_parallel_goal', { project: f.project, goal_id: 'parallel-test',
    objective: 'Exercise independent parallel safety boundaries.', context: 'Synthetic tests without model inference.',
    read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria,
    participants: [{ id: 'host', kind: 'host' }, ...['worker-1', 'worker-2', 'worker-3'].map(id => ({ id, kind: 'worker', ...selection })),
      { id: 'reviewer', kind: 'worker', ...selection, mode: 'plan' }],
    limits: { max_steps: 20, max_reworks: 8, max_no_progress: 6, max_parallel_total: 3, max_parallel_workers: 2, ...limits } });
  if (tasks?.length) await f.call('plan_goal_tasks', { goal: made.goal, operation_id: 'plan', plan_version: 0, tasks });
  return made.goal;
}
const claimTask = (f, goal, task_id, participant_id, suffix = '') => f.call('claim_goal_task', {
  goal, task_id, participant_id, operation_id: 'claim-' + task_id + suffix, owner_session_id: 'session-' + participant_id,
});
async function startWorker(f, claim, card, extra = {}) {
  return f.call('start_goal_task', { ...owner(claim, 'start-' + claim.attempt_id), execution: {
    ...selection, mode: card.mode, project: claim.workspace.path, read_scope: card.read_scope,
    task: 'Perform the assigned fixture task. ' + (claim.review_context || ''), task_contract: card.task_contract,
    selection_reason: 'Independent offline fixture.', prepared_ref: '0'.repeat(32), ...extra,
  } });
}
async function submitWorker(f, claim, card, { content = 'changed source\n', summary = 'Independent fixture artifact.' } = {}) {
  const started = await startWorker(f, claim, card), active = attemptState(started, claim);
  if (card.mode === 'edit') fs.writeFileSync(path.join(claim.workspace.path, card.task_contract.allowed_edits[0]), content);
  f.endJob(active.job);
  return f.call('submit_goal_task', { ...owner(claim, 'submit-' + claim.attempt_id), summary });
}
async function reviewTask(f, claim, submitted, status = 'passed', operationSuffix = 'first', extra = {}) {
  return f.call('review_goal_task', { goal: claim.goal, task_id: claim.task_id, attempt_id: claim.attempt_id,
    operation_id: 'review-' + claim.attempt_id + '-' + operationSuffix, artifact_fingerprint: attemptState(submitted, claim).artifact.fingerprint,
    checks: checks(status, 'Independent artifact source verification ' + operationSuffix + '.'), ...extra });
}

test('DAG validation rejects unknown dependencies and cycles without partially changing the plan', async t => {
  const f = fixture(t), goal = await makeGoal(f);
  const badPlans = [
    [taskCard('a', 'a', { depends_on: ['missing'] })],
    [taskCard('a', 'a', { depends_on: ['a'] })],
    [taskCard('a', 'a', { depends_on: ['b'] }), taskCard('b', 'b', { depends_on: ['a'] })],
  ];
  for (let i = 0; i < badPlans.length; i++) {
    await assert.rejects(f.call('plan_goal_tasks', { goal, operation_id: 'invalid-' + i, plan_version: 0, tasks: badPlans[i] }), /dependency|cycle/i);
    const status = await f.call('goal_status', { goal });
    assert.equal(status.plan_version, 0); assert.deepEqual(status.tasks, []); assert.deepEqual(status.attempts, []);
  }
  await f.call('plan_goal_tasks', { goal, operation_id: 'valid', plan_version: 0, tasks: [taskCard('a')] });
  assert.equal((await f.call('goal_status', { goal })).plan_version, 1);
});

test('simultaneous claims cannot allocate the same task twice and exact replay reuses its lease', async t => {
  const f = fixture(t), goal = await makeGoal(f, [taskCard('a')]);
  const args = ['worker-1', 'worker-2'].map((participant_id, i) => ({ goal, operation_id: 'claim-race-' + i,
    task_id: 'a', participant_id, owner_session_id: 'session-' + participant_id }));
  const results = await Promise.allSettled(args.map(input => f.call('claim_goal_task', input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const loser = results.find(r => r.status === 'rejected'); assert.match(loser.reason.message, /already.*attempt/i);
  const index = results.findIndex(r => r.status === 'fulfilled'), winner = results[index].value;
  const replay = await f.call('claim_goal_task', args[index]);
  assert.equal(replay.attempt_id, winner.attempt_id); assert.equal(replay.lease_token, winner.lease_token);
  assert.equal(replay.attempts.length, 1); assert.equal(replay.budget.used.steps, 1);
  await assert.rejects(f.call('claim_goal_task', { ...args[index], owner_session_id: 'different-session' }), /conflicts/i);
});

test('host start and submission require both the original session and lease token', async t => {
  const f = fixture(t), goal = await makeGoal(f, [taskCard('host-work')]);
  const claim = await claimTask(f, goal, 'host-work', 'host');
  for (const change of [{ owner_session_id: 'different-session' }, { lease_token: 'wrong-token' }]) {
    await assert.rejects(f.call('start_goal_task', { ...owner(claim, 'bad-start'), ...change }), /ownership/i);
  }
  await f.call('start_goal_task', owner(claim, 'start-host'));
  fs.writeFileSync(path.join(claim.workspace.path, 'src/a.txt'), 'host edit\n');
  for (const change of [{ owner_session_id: 'different-session' }, { lease_token: 'wrong-token' }]) {
    await assert.rejects(f.call('submit_goal_task', { ...owner(claim, 'bad-submit'), summary: 'Forged completion.', ...change }), /ownership/i);
  }
  const status = await f.call('goal_status', { goal });
  assert.equal(status.capacity.total, 1); assert.equal(attemptState(status, claim).artifact, null);
  assert.equal(JSON.stringify(status).includes(claim.lease_token), false, 'Read-only status must not leak ownership tokens.');
  const submitted = await f.call('submit_goal_task', { ...owner(claim, 'submit-host'), summary: 'Host stopped and submitted actual source.' });
  assert.equal(attemptState(submitted, claim).status, 'submitted');
});

test('worker and total capacity include reserved work and count host work separately', async t => {
  const f = fixture(t), goal = await makeGoal(f, ['a', 'b', 'c', 'd'].map(id => taskCard(id, id)));
  await claimTask(f, goal, 'a', 'worker-1'); await claimTask(f, goal, 'b', 'worker-2');
  await assert.rejects(claimTask(f, goal, 'c', 'worker-3', '-worker-limit'), /capacity/i);
  await claimTask(f, goal, 'c', 'host');
  await assert.rejects(claimTask(f, goal, 'd', 'worker-3', '-total-limit'), /capacity/i);
  const status = await f.call('goal_status', { goal });
  assert.equal(status.capacity.total, 3); assert.equal(status.capacity.workers, 2); assert.equal(status.budget.used.steps, 3);
});

test('pause and cancel retain active host and unconfirmed worker slots until actual stop evidence', async t => {
  const f = fixture(t), a = taskCard('host-work'), b = taskCard('worker-work', 'b');
  const goal = await makeGoal(f, [a, b, taskCard('later', 'c')]);
  const host = await claimTask(f, goal, a.id, 'host'), worker = await claimTask(f, goal, b.id, 'worker-1');
  await f.call('start_goal_task', owner(host, 'start-host')); await startWorker(f, worker, b);
  const paused = await f.call('advance_goal', { goal, operation_id: 'pause', action: 'pause' });
  assert.equal(paused.capacity.total, 2);
  await assert.rejects(claimTask(f, goal, 'later', 'worker-2'), /active/i);
  const cancelled = await f.call('advance_goal', { goal, operation_id: 'cancel', action: 'cancel' });
  assert.equal(cancelled.capacity.total, 2); assert.equal(cancelled.status, 'cancelling');
  await assert.rejects(f.call('submit_goal_task', { ...owner(host, 'false-stop'), owner_session_id: 'replacement-host', outcome: 'cancelled', summary: 'Cannot attest another session stopped.' }), /ownership/i);
  const hostStopped = await f.call('submit_goal_task', { ...owner(host, 'host-stopped'), outcome: 'cancelled', summary: 'Owning host explicitly stopped editing.' });
  assert.equal(hostStopped.capacity.total, 1); assert.equal(hostStopped.capacity.workers, 1);
  f.endJob(attemptState(hostStopped, worker).job);
  const stopped = await f.call('goal_status', { goal });
  assert.equal(stopped.capacity.total, 0); assert.equal(stopped.status, 'cancelled');
});

test('host edit acceptance requires a current independently accepted reviewer bound to the artifact', async t => {
  const reviewCard = taskCard('inspect', 'a', {
    kind: 'review', mode: 'plan', task_contract: contract('a', 'plan'), review_of: 'host-work',
  });
  const f = fixture(t), goal = await makeGoal(f, [taskCard('host-work'), reviewCard]);
  const claim = await claimTask(f, goal, 'host-work', 'host'); await f.call('start_goal_task', owner(claim, 'start-host'));
  fs.writeFileSync(path.join(claim.workspace.path, 'src/a.txt'), 'host edit\n');
  const submitted = await f.call('submit_goal_task', { ...owner(claim, 'submit-host'), summary: 'Host source edit.' });
  await assert.rejects(reviewTask(f, claim, submitted), /independent.*review/i);
  await assert.rejects(reviewTask(f, claim, submitted, 'passed', 'fake-name', { reviewer_task_id: 'inspect' }), /reviewer.*accepted.*artifact/i);
  const status = await f.call('goal_status', { goal }); assert.equal(taskState(status, 'host-work').status, 'submitted');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'initial a\n');
  const reviewer = await claimTask(f, goal, 'inspect', 'reviewer');
  const inspected = await submitWorker(f, reviewer, reviewCard);
  await reviewTask(f, claim, submitted, 'passed', 'real-review', { reviewer_task_id: 'inspect' });
  f.endJob(attemptState(inspected, reviewer).job, false);
  await assert.rejects(f.call('integrate_goal_task', owner(claim, 'review-withdrawn')), /review|accepted/i,
    'A withdrawn worker review cannot authorize host code integration.');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'initial a\n');
});

test('accepted but unintegrated tasks do not release dependencies or change the next input version', async t => {
  const f = fixture(t), a = taskCard('a'), b = taskCard('b', 'b', { depends_on: ['a'] });
  const goal = await makeGoal(f, [a, b]), claim = await claimTask(f, goal, 'a', 'worker-1');
  const submitted = await submitWorker(f, claim, a); await reviewTask(f, claim, submitted);
  await assert.rejects(claimTask(f, goal, 'b', 'worker-2'), /dependencies.*integrated/i);
  assert.equal(taskState(await f.call('goal_status', { goal }), 'b').status, 'waiting_dependencies');
  await f.call('integrate_goal_task', owner(claim, 'integrate-a'));
  const next = await claimTask(f, goal, 'b', 'worker-2');
  assert.equal(fs.readFileSync(path.join(next.workspace.path, 'src/a.txt'), 'utf8'), 'changed source\n');
  assert.equal(attemptState(next, next).dependencies[0].artifact_fingerprint, attemptState(submitted, claim).artifact.fingerprint);
});

test('workspace changes after submission invalidate both artifact review and accepted integration', async t => {
  const f = fixture(t), card = taskCard('a'), goal = await makeGoal(f, [card]), claim = await claimTask(f, goal, 'a', 'worker-1');
  const submitted = await submitWorker(f, claim, card), file = path.join(claim.workspace.path, 'src/a.txt');
  fs.writeFileSync(file, 'different source\n');
  await assert.rejects(reviewTask(f, claim, submitted), /changed.*stale|stale.*changed/i);
  fs.writeFileSync(file, 'changed source\n'); await reviewTask(f, claim, submitted);
  fs.writeFileSync(file, 'late edit after review\n');
  await assert.rejects(f.call('integrate_goal_task', owner(claim, 'stale-integrate')), /changed.*stale|stale.*changed/i);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'initial a\n');
});

test('unchanged failed work cannot hide no progress behind another task or cosmetic summaries', async t => {
  const f = fixture(t), a = taskCard('a'), b = taskCard('b', 'b'), goal = await makeGoal(f, [a, b]);
  const first = await claimTask(f, goal, 'a', 'worker-1');
  const initial = await submitWorker(f, first, a, { summary: 'First attempt.' });
  await reviewTask(f, first, initial, 'failed');
  const other = await claimTask(f, goal, 'b', 'worker-2');
  const good = await submitWorker(f, other, b, { content: 'unrelated real progress\n' }); await reviewTask(f, other, good);
  await f.call('integrate_goal_task', owner(other, 'integrate-independent-b'));
  const retry = await claimTask(f, goal, 'a', 'worker-1', '-retry');
  const repeated = await submitWorker(f, retry, a, { summary: 'Cosmetically rewritten summary, unchanged output.' });
  const failed = await reviewTask(f, retry, repeated, 'failed', 'worded-differently');
  assert.equal(taskState(failed, 'a').no_progress, 1, 'Same source and failed criteria must count as no progress despite summary wording.');
  assert.equal(taskState(failed, 'b').no_progress, 0, 'Another task has an independent progress history.');
  assert.equal(failed.budget.used.no_progress, 1);
});

test('artifact collection rejects edits outside the task scope before creating an acceptable artifact', t => {
  const f = fixture(t), baseline = inspectProject(f.project), goal = path.join(f.project, '.ai/goals/scope');
  const workspace = createWorkspace({ project: f.project, goal, workspace_id: 'attempt-1', base_revision: baseline.base_revision });
  fs.writeFileSync(path.join(workspace.path, 'src/a.txt'), 'allowed edit\n');
  fs.writeFileSync(path.join(workspace.path, 'src/b.txt'), 'unauthorized edit\n');
  const output_dir = path.join(goal, 'artifacts/first');
  assert.throws(() => collectArtifact({ workspace, allowed_edits: ['src/a.txt'], read_scope: ['src'], output_dir }), /outside.*scope/i);
  assert.equal(fs.existsSync(path.join(output_dir, 'artifact.json')), false);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'initial a\n');
});

test('stale integration preimages never overwrite newer target source', t => {
  const f = fixture(t), { goal, artifact } = artifactFixture(f, 'stale');
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'newer user work\n');
  assert.throws(() => integrateArtifact({ project: f.project, goal, operation_id: 'merge', artifact }), /preimage.*stale|stale.*preimage/i);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'newer user work\n');
});

test('two goals targeting one checkout honor the same live integration lock', t => {
  const f = fixture(t), first = artifactFixture(f, 'goal-a', 'a'), second = artifactFixture(f, 'goal-b', 'b');
  const lock = path.join(f.project, '.ai/integration.lock');
  // Fault injection models another live integrator. Both independent goal IDs
  // must fail at the repository lock, before either target can be modified.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'independent-live-integrator' }));
  for (const item of [first, second]) {
    assert.throws(() => integrateArtifact({ project: f.project, goal: item.goal, operation_id: 'merge', artifact: item.artifact }), /integration.*running/i);
  }
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'initial a\n');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'initial b\n');
  fs.unlinkSync(lock);
  assert.equal(integrateArtifact({ project: f.project, goal: first.goal, operation_id: 'merge', artifact: first.artifact }).status, 'integrated');
  assert.equal(integrateArtifact({ project: f.project, goal: second.goal, operation_id: 'merge', artifact: second.artifact }).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'changed a\n');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'changed b\n');
});

test('retrying a blocked integration cannot silently absorb another goal\'s target changes', async t => {
  const f = fixture(t), card = taskCard('b', 'b'), goal = await makeGoal(f, [card, taskCard('later', 'c')]);
  const claim = await claimTask(f, goal, 'b', 'worker-1'), submitted = await submitWorker(f, claim, card);
  await reviewTask(f, claim, submitted);
  const other = artifactFixture(f, 'other-goal', 'a'), lock = path.join(f.project, '.ai/integration.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'temporary-live-integrator' }));
  const integration = owner(claim, 'blocked-integrate');
  await assert.rejects(f.call('integrate_goal_task', integration), /integration.*running/i);
  fs.unlinkSync(lock);
  integrateArtifact({ project: f.project, goal: other.goal, operation_id: 'other-merge', artifact: other.artifact });
  await assert.rejects(f.call('integrate_goal_task', integration), /changed|stale|baseline|fingerprint|outside/i,
    'An earlier intent is not proof that target changes came from that intent.');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'changed a\n');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'initial b\n');
});
