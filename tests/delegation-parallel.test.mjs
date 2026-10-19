import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { callParallelGoalTool } from '../plugins/agent-bridge/scripts/parallel-goals.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const criteria = [{ id: 'correct', description: 'Source has the requested behavior', verification: 'Inspect actual source', verification_kind: 'source' }];
const checks = (status = 'passed') => [{ criterion_id: 'correct', status, evidence: 'Host independently inspected the actual proposal or artifact', verification_kind: 'source' }];
const feedback = [{ criterion_id: 'correct', problem: 'The proposed source does not satisfy the criterion', required_change: 'Correct the source behavior', verification: 'Inspect source after rework' }];
const contract = (mode = 'plan', file = 'src/a.txt') => ({ complexity: 'standard', context: 'Offline delegation fixture', allowed_edits: mode === 'edit' ? [file] : [], preserve: [], integration: 'Host reviews actual source and integrates accepted artifacts', acceptance_criteria: criteria });
const card = (id, kind = 'implement', mode = 'edit', extra = {}) => ({ id, kind, mode, depends_on: [], read_scope: ['src'], task_contract: contract(mode), ...extra });
const selection = { worker: 'claude', provider: 'fixture', model: 'fixture-model', effort: 'high', endpoint: 'https://example.invalid/api' };
const proposal = tasks => ({ summary: 'Implement the requested behavior in the existing source', decisions: ['Use isolated artifacts and serial integration'], validation_plan: ['Inspect source against the requested behavior'], tasks });

function fixture(t, delegation_level = 'max', limits = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-parallel-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/a.txt'), 'before\n'); fs.writeFileSync(path.join(project, 'src/b.txt'), 'before\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ai/\n'); git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const jobs = new Map(); let goal, seq = 0;
  const bridge = async (name, args) => {
    if (name === 'dispatch_task') {
      const job = path.join(args.project, '.ai/tasks/request-' + hash(args.request_id));
      fs.mkdirSync(job, { recursive: true });
      const state = { job, project: args.project, requestId: args.request_id, ...selection, status: 'running', quality: { acceptanceStatus: 'pending' } };
      jobs.set(job, state); fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state)); return state;
    }
    if (name === 'task_status') return jobs.get(args.job);
    if (name === 'cancel_task') { const state = jobs.get(args.job); state.status = 'cancelled'; return state; }
    throw new Error('Unexpected Bridge tool ' + name);
  };
  const create = { project, goal_id: 'delegation', objective: 'Implement requested source behavior', context: 'Synthetic tests without inference', read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria,
    ...(delegation_level ? { delegation_level } : {}), participants: [{ id: 'host', kind: 'host' }, { id: 'designer', kind: 'worker', ...selection, mode: 'plan' }, { id: 'writer', kind: 'worker', ...selection, mode: 'edit' }],
    limits: { max_steps: 20, max_reworks: 8, max_no_progress: 6, max_parallel_total: 3, max_parallel_workers: 2, ...limits } };
  const call = (name, args = {}) => callParallelGoalTool(name, { ...(goal ? { goal } : {}), ...args }, bridge);
  const setup = async () => { const result = await callParallelGoalTool('create_parallel_goal', create, bridge); goal = result.goal; return result; };
  const status = () => call('goal_status');
  const plan = async (tasks, extra = {}) => { const state = await status(); return call('plan_goal_tasks', { operation_id: 'plan-' + seq++, plan_version: state.plan_version, tasks,
    ...(state.design?.status === 'approved' ? { design_fingerprint: state.design.fingerprint } : {}), ...extra }); };
  const claim = (task_id, participant_id) => call('claim_goal_task', { operation_id: 'claim-' + seq++, task_id, participant_id, owner_session_id: 'session' });
  const owned = c => ({ task_id: c.task_id, attempt_id: c.attempt_id, owner_session_id: c.owner_session_id, lease_token: c.lease_token });
  const start = (c, host = false, extra = {}) => call('start_goal_task', { ...owned(c), operation_id: 'start-' + seq++, ...(host ? {} : { execution: {
    project: c.workspace.path, ...selection, mode: c.mode, read_scope: c.read_scope, task_contract: c.task_contract,
    task: 'Perform the scoped task. ' + (c.design_context || '') + '\n' + (c.review_context || ''), selection_reason: 'Offline fixture', prepared_ref: '0'.repeat(32), ...extra,
  } }) });
  const jobFor = c => [...jobs.values()].find(j => j.project === c.workspace.path);
  const end = (c, data, accepted = true) => { const j = jobFor(c); j.status = 'ready_for_review'; j.quality.acceptanceStatus = accepted ? 'accepted' : 'pending'; j.review = { id: 'review-' + seq++, status: accepted ? 'accepted' : 'incomplete' };
    fs.writeFileSync(path.join(j.job, 'state.json'), JSON.stringify(j)); fs.writeFileSync(path.join(j.job, 'result.md'), data ? 'Worker proposal\n```agent-bridge-design\n' + JSON.stringify(data) + '\n```\n' : 'Worker implementation and self-test completed\n'); return j; };
  const submit = c => call('submit_goal_task', { ...owned(c), operation_id: 'submit-' + seq++, summary: 'Worker completed and host inspected actual source' });
  const review = async (c, extra = {}) => { const state = await status(); return call('review_goal_task', { operation_id: 'review-' + seq++, task_id: c.task_id, attempt_id: c.attempt_id,
    artifact_fingerprint: state.attempts.find(a => a.id === c.attempt_id).artifact.fingerprint, checks: checks(), ...extra }); };
  const integrate = c => call('integrate_goal_task', { ...owned(c), operation_id: 'integrate-' + seq++ });
  const submitDesign = c => call('submit_goal_design', { operation_id: 'submit-design-' + seq++, source_job: jobFor(c).job });
  const reviewDesign = async (extra = {}) => { const state = await status(); return call('review_goal_design', { operation_id: 'review-design-' + seq++, design_fingerprint: state.design.fingerprint, checks: checks(), ...extra }); };
  const design = async (tasks, id = 'design-' + seq++) => { await plan([card(id, 'design', 'plan')]); const c = await claim(id, 'designer'); await start(c); end(c, proposal(tasks)); await submitDesign(c); return { claim: c, state: await reviewDesign() }; };
  return { project, create, jobs, setup, call, status, plan, claim, owned, start, jobFor, end, submit, review, integrate, submitDesign, reviewDesign, design };
}

test('delegation defaults to medium and high/max require a separate read-only design worker', async t => {
  const f = fixture(t, null), state = await f.setup(); assert.equal(state.delegation_level, 'medium');
  await f.plan([card('host-work')]); const host = await f.claim('host-work', 'host'); await f.start(host, true);
  assert.equal((await f.status()).capacity.total, 1);
  await assert.rejects(callParallelGoalTool('create_parallel_goal', { ...f.create, goal_id: 'invalid-max', delegation_level: 'max', participants: f.create.participants.filter(p => p.id !== 'designer') }, () => {}), /plan worker/);
});

test('max requires a real accepted worker proposal, exact approved tasks and worker execution markers', async t => {
  const f = fixture(t); await f.setup(); const implementation = card('implement');
  await assert.rejects(f.plan([implementation]), /design|approv/i);
  await f.plan([card('design', 'design', 'plan')]);
  await assert.rejects(f.claim('design', 'host'), /worker|review/i);
  const designer = await f.claim('design', 'designer'); await f.start(designer);
  await assert.rejects(f.submitDesign(designer), /ended.*accepted|accepted.*design|active.*stop/i);
  f.end(designer, proposal([implementation])); const submitted = await f.submitDesign(designer);
  assert.equal(submitted.design.status, 'pending_review');
  await assert.rejects(f.plan([implementation]), /design|approv/i);
  const approved = await f.reviewDesign(); assert.equal(approved.design.status, 'approved');
  await assert.rejects(f.plan([{ ...implementation, task_contract: { ...implementation.task_contract, context: 'Host changed the worker design' } }]), /approved|design|match/i);
  await f.plan([implementation]);
  await assert.rejects(f.claim('implement', 'host'), /review|host/i);
  const writer = await f.claim('implement', 'writer');
  await assert.rejects(f.start(writer, false, { task: 'Missing approved proposal binding' }), /design marker/i);
  await f.start(writer); fs.writeFileSync(path.join(writer.workspace.path, 'src/a.txt'), 'implemented\n'); f.end(writer);
  await f.submit(writer); await f.review(writer); const integrated = await f.integrate(writer);
  const complete = await f.call('record_goal_review', { review_id: 'final', snapshot_fingerprint: integrated.snapshot_fingerprint, checks: checks() });
  assert.equal(complete.status, 'completed'); assert.equal(complete.budget.used.steps, 2);
  assert.equal(complete.tasks.find(item => item.id === 'design').status, 'worker_ended', 'Design work is bookkeeping, not an unintegrated implementation obligation.');
});

test('design changes require structured feedback and revisions retain budgets and superseded history', async t => {
  const f = fixture(t); await f.setup(); const oldTask = card('old');
  const first = await f.design([oldTask]); await f.plan([oldTask]);
  const oldWriter = await f.claim('old', 'writer'); await f.start(oldWriter);
  await f.plan([card('revise', 'design', 'plan')]);
  await assert.rejects(f.claim('revise', 'designer'), /active|uncertain/i);
  fs.writeFileSync(path.join(oldWriter.workspace.path, 'src/a.txt'), 'old artifact\n'); f.end(oldWriter); await f.submit(oldWriter);
  const revised = await f.claim('revise', 'designer'); await f.start(revised); f.end(revised, proposal([card('new')])); await f.submitDesign(revised);
  await assert.rejects(f.reviewDesign({ checks: checks('failed') }), /feedback/i);
  const rejected = await f.reviewDesign({ checks: checks('failed'), feedback });
  assert.equal(rejected.design.status, 'changes_requested'); assert.equal(rejected.designs.length, 2);
  await assert.rejects(f.review(oldWriter), /design|approv/i);
  await assert.rejects(f.reviewDesign(), /fresh worker revision/);
  const revisionAttempt = await f.claim('revise', 'designer'); await f.start(revisionAttempt);
  f.end(revisionAttempt, { ...proposal([card('new')]), decisions: ['Preserve accepted behavior and cover the requested correction'] });
  await f.submitDesign(revisionAttempt);
  const approved = await f.reviewDesign(); assert.equal(approved.tasks.find(item => item.id === 'old').status, 'superseded');
  assert.equal(approved.attempts.find(item => item.id === oldWriter.attempt_id).status, 'superseded');
  assert.equal(approved.budget.used.steps, 4); assert.equal(approved.budget.used.reworks, 2);
  await assert.rejects(f.review(oldWriter), /superseded/i);
  await assert.rejects(f.integrate(oldWriter), /superseded/i);
  await assert.rejects(f.plan([oldTask]), /already exists/i);
  await f.plan([card('new')]);
  const again = await f.reviewDesign(); assert.notEqual(again.tasks.find(item => item.id === 'new').status, 'superseded', 'Repeating approval must not supersede tasks from that same design.');
  assert.equal(first.state.design.fingerprint === again.design.fingerprint, false);
});

test('max host may review but cannot take research or edit work; high permits host implementation after design', async t => {
  const f = fixture(t); await f.setup(); const tasks = [card('research', 'research', 'plan'), card('review', 'review', 'plan'), card('implement')];
  await f.design(tasks); await f.plan(tasks);
  await assert.rejects(f.claim('research', 'host'), /review|host/i);
  await assert.rejects(f.claim('implement', 'host'), /review|host/i);
  const review = await f.claim('review', 'host'); await f.start(review, true); assert.equal((await f.status()).capacity.total, 1);
  const h = fixture(t, 'high'); await h.setup(); await h.design([card('implement')]); await h.plan([card('implement')]);
  const host = await h.claim('implement', 'host'); await h.start(host, true); assert.equal((await h.status()).delegation_level, 'high');
});

test('changed worker result or revoked worker acceptance invalidates a design before launch and completion', async t => {
  const f = fixture(t); await f.setup(); const implementation = card('implement'); const designed = await f.design([implementation]); await f.plan([implementation]);
  const writer = await f.claim('implement', 'writer'), job = f.jobFor(designed.claim), file = path.join(job.job, 'result.md'), original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original + 'Changed after approval\n'); await assert.rejects(f.start(writer), /changed|stale|design/i);
  fs.writeFileSync(file, original); job.quality.acceptanceStatus = 'pending'; await assert.rejects(f.start(writer), /accepted|design/i);
  job.quality.acceptanceStatus = 'accepted'; const originalReview = job.review.id; job.review.id = 'replacement-accepted-review';
  await assert.rejects(f.start(writer), /accepted|design/i); job.review.id = originalReview;
  await f.start(writer); fs.writeFileSync(path.join(writer.workspace.path, 'src/a.txt'), 'implemented\n'); f.end(writer);
  await f.submit(writer); await f.review(writer); const integrated = await f.integrate(writer);
  await f.call('record_goal_review', { review_id: 'final', snapshot_fingerprint: integrated.snapshot_fingerprint, checks: checks() });
  job.quality.acceptanceStatus = 'pending'; const stale = await f.status(); assert.notEqual(stale.status, 'completed'); assert.equal(stale.review.status, 'stale');
  assert.equal(stale.delegation_level, 'max', 'A worker review failure does not lower delegation level or authorize host takeover.');
});

test('a revised design retains integrated host artifacts and their independently accepted review evidence', async t => {
  const f = fixture(t, 'high'); await f.setup();
  const first = card('host-work'), reviewer = card('worker-review', 'review', 'plan', { review_of: first.id });
  await f.design([first, reviewer]); await f.plan([first, reviewer]);
  const host = await f.claim(first.id, 'host'); await f.start(host, true); fs.writeFileSync(path.join(host.workspace.path, 'src/a.txt'), 'host implementation\n'); await f.submit(host);
  const review = await f.claim(reviewer.id, 'designer'); await f.start(review); f.end(review); await f.submit(review);
  await f.review(host, { reviewer_task_id: reviewer.id }); await f.integrate(host);
  const followup = card('next', 'implement', 'edit', { depends_on: [first.id], task_contract: contract('edit', 'src/b.txt') });
  const revised = await f.design([followup]); assert.equal(revised.state.tasks.find(t => t.id === reviewer.id).status, 'superseded');
  await f.plan([followup]); const writer = await f.claim(followup.id, 'writer'); await f.start(writer);
  assert.equal(fs.readFileSync(path.join(writer.workspace.path, 'src/a.txt'), 'utf8'), 'host implementation\n');
  fs.writeFileSync(path.join(writer.workspace.path, 'src/b.txt'), 'worker followup\n'); f.end(writer); await f.submit(writer); await f.review(writer); const integrated = await f.integrate(writer);
  const complete = await f.call('record_goal_review', { review_id: 'revised-final', snapshot_fingerprint: integrated.snapshot_fingerprint, checks: checks() });
  assert.equal(complete.status, 'completed'); assert.equal(complete.budget.used.steps, 5); assert.equal(complete.budget.used.reworks, 1);
  f.jobFor(review).quality.acceptanceStatus = 'pending'; assert.notEqual((await f.status()).status, 'completed', 'Retained review evidence must still be independently accepted.');
});

test('design acceptance binds the worker source baseline and rejects plan-mode edits', async t => {
  const f = fixture(t); await f.setup(); await f.plan([card('design', 'design', 'plan')]);
  const designer = await f.claim('design', 'designer'); await f.start(designer); f.end(designer, proposal([card('implement')]));
  const local = path.join(designer.workspace.path, 'src/a.txt'), integration = path.join(f.project, 'src/a.txt');
  fs.writeFileSync(local, 'unauthorized plan-mode edit\n'); await assert.rejects(f.submitDesign(designer), /workspace changed/i);
  fs.writeFileSync(local, 'before\n'); fs.writeFileSync(integration, 'outside goal edit\n'); await assert.rejects(f.submitDesign(designer), /changed outside/i);
  assert.equal(fs.readFileSync(integration, 'utf8'), 'outside goal edit\n', 'An external source edit is retained.');
  fs.writeFileSync(integration, 'before\n'); await f.submitDesign(designer); await f.reviewDesign(); await f.plan([card('implement')]);
  fs.writeFileSync(local, 'late design edit\n'); await assert.rejects(f.claim('implement', 'writer'), /accepted|design/i);
});

test('the same design card can rework a rejected proposal without resetting cumulative budgets', async t => {
  const f = fixture(t, 'max', { max_reworks: 1 }); await f.setup(); await f.plan([card('design', 'design', 'plan')]);
  const first = await f.claim('design', 'designer'); await f.start(first); f.end(first, proposal([card('implement')])); await f.submitDesign(first);
  await f.reviewDesign({ checks: checks('failed'), feedback });
  const second = await f.claim('design', 'designer'); assert.notEqual(second.attempt_id, first.attempt_id); assert.equal(second.design_phase, 'designing');
  await f.start(second); const changed = proposal([card('implement')]); changed.decisions = ['Revise the source strategy to address the host finding']; f.end(second, changed);
  await f.submitDesign(second); const rejected = await f.reviewDesign({ checks: checks('failed'), feedback });
  assert.equal(rejected.tasks.length, 1); assert.equal(rejected.designs.length, 2); assert.equal(rejected.budget.used.steps, 2); assert.equal(rejected.budget.used.reworks, 1);
  await assert.rejects(f.claim('design', 'designer'), /rework budget/i);
  assert.equal((await f.status()).delegation_level, 'max');
});
