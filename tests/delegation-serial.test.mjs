import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { callGoalTool } from '../plugins/agent-bridge/scripts/goals.mjs';
import { designExecutionContext } from '../plugins/agent-bridge/scripts/delegation-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const criteria = [{ id: 'works', description: 'The complete requested source works.', verification: 'Read the integrated source.', verification_kind: 'source' }];
const checks = status => [{ criterion_id: 'works', status, verification_kind: 'source', evidence: 'Host checked every requirement against the actual material.' }];
const feedback = [{ criterion_id: 'works', problem: 'The plan misses the requested behavior.', required_change: 'Cover the missing behavior.', verification: 'Review the revised design coverage.' }];
const selection = { worker: 'claude', provider: 'fixture', model: 'glm-5.3', effort: 'high', endpoint: 'https://example.test/inference' };
const contract = edits => ({ complexity: 'standard', context: 'A bounded synthetic task.', allowed_edits: edits, preserve: ['Preserve existing source.'], integration: 'Host checks final source.', acceptance_criteria: criteria });
const spec = (id = 'implementation', depends_on = []) => ({ id, kind: 'implement', depends_on, mode: 'edit', read_scope: ['src'], task_contract: contract(['src']) });
const proposal = tasks => ({ summary: 'Implement and verify the requested behavior.', decisions: ['Keep the existing source layout.'], validation_plan: ['Verify every requested behavior.'], tasks });

function fixture(t, options = {}) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-delegation-serial-')));
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/a.txt'), 'initial');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const jobs = new Map(), calls = []; let result = 'Synthetic accepted worker output.', failure = null, dispatchEffect = null;
  const bridge = async (name, args) => {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'dispatch_task' || name === 'continue_task') {
      if (failure) throw new Error(failure);
      const job = path.join(project, '.ai/tasks/request-' + hash(args.request_id));
      if (!jobs.has(job)) {
        fs.mkdirSync(job, { recursive: true }); fs.writeFileSync(path.join(job, 'state.json'), '{}');
        fs.writeFileSync(path.join(job, 'result.md'), result);
        jobs.set(job, { job, requestId: args.request_id, ...selection, mode: args.mode, status: 'ready_for_review',
          review: { id: 'review-' + path.basename(job), status: 'accepted' }, quality: { acceptanceStatus: 'accepted' } });
        if (dispatchEffect) dispatchEffect(args, jobs.get(job));
      }
      return structuredClone(jobs.get(job));
    }
    if (name === 'task_status') return structuredClone(jobs.get(args.job));
    if (name === 'cancel_task') { jobs.get(args.job).status = 'cancelled'; return structuredClone(jobs.get(args.job)); }
    throw new Error('Unexpected fixture call ' + name);
  };
  const call = (name, args) => callGoalTool(name, args, bridge);
  const createArgs = { project, goal_id: 'delegation', objective: 'Complete a delegated goal.', context: 'Synthetic tests without inference.',
    read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria,
    participants: [{ id: 'designer', ...selection, mode: 'plan' }, { id: 'implementer', ...selection, mode: 'edit' }],
    limits: { max_steps: 12, max_reworks: 8, max_no_progress: 8 }, delegation_level: 'max', ...options };
  const create = () => call('create_goal', createArgs);
  const execution = (mode, task = 'Inspect the bounded fixture.') => ({ project, ...selection, mode, task, read_scope: ['src'],
    task_contract: contract(mode === 'edit' ? ['src'] : []), prepared_ref: 'a'.repeat(32), selection_reason: 'Deterministic local test selection.' });
  const design = async (goal, id = 'design-1', tasks = [spec()]) => {
    result = '```agent-bridge-design\n' + JSON.stringify(proposal(tasks)) + '\n```';
    const dispatched = await call('advance_goal', { goal, operation_id: id, action: 'dispatch', participant_id: 'designer', role: 'design', execution: execution('plan') });
    const source = dispatched.steps.at(-1);
    return call('submit_goal_design', { goal, operation_id: id + '-submit', source_job: source.job });
  };
  const approve = async (goal, design, id = 'approve') => call('review_goal_design', { goal, operation_id: id, design_fingerprint: design.fingerprint, checks: checks('passed') });
  const taskArgs = (goal, design, taskId = 'implementation', id = 'implement') => ({ goal, operation_id: id, action: 'dispatch', participant_id: 'implementer', role: 'implement',
    design_task_id: taskId, design_fingerprint: design.fingerprint, execution: execution('edit', designExecutionContext({ design, design_phase: 'approved' }, taskId) + '\nImplement the approved task.') });
  return { project, createArgs, create, call, execution, jobs, calls, design, approve, taskArgs,
    setResult: value => { result = value; }, setFailure: value => { failure = value; }, setDispatchEffect: value => { dispatchEffect = value; },
    launches: () => calls.filter(c => /^(dispatch|continue)_task$/.test(c.name)).length };
}

test('default medium preserves legacy calls and persisted delegation is frozen', async t => {
  const f = fixture(t); delete f.createArgs.delegation_level;
  const created = await f.create(); assert.equal(created.delegation_level, 'medium');
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.goal, 'goal.json'), 'utf8')).delegation_level, 'medium');
  assert.equal((await f.create()).reused, true);
  await f.call('advance_goal', { goal: created.goal, operation_id: 'old-client', action: 'dispatch', participant_id: 'implementer', execution: f.execution('edit') });
  await assert.rejects(f.call('create_goal', { ...f.createArgs, delegation_level: 'max' }), /conflicts/);
});

test('high and max require a plan worker and cannot execute or complete without an approved design', async t => {
  for (const delegation_level of ['high', 'max']) {
    const f = fixture(t, { delegation_level });
    await assert.rejects(f.call('create_goal', { ...f.createArgs, participants: [f.createArgs.participants[1]] }), /plan-mode/);
    const { goal, snapshot_fingerprint } = await f.create();
    await assert.rejects(f.call('advance_goal', { goal, operation_id: 'missing-plan', action: 'dispatch', participant_id: 'implementer', role: 'implement', execution: f.execution('edit') }), /design/i);
    await assert.rejects(f.call('advance_goal', { goal, operation_id: 'edit-design', action: 'dispatch', participant_id: 'implementer', role: 'design', execution: f.execution('edit') }), /design|plan/i);
    await assert.rejects(f.call('record_goal_review', { goal, review_id: 'empty', snapshot_fingerprint, checks: checks('passed') }), /accepted child/);
    assert.equal(f.launches(), 0);
  }
});

test('design is imported only from the latest accepted read-only worker result and does not count unchanged source as no progress', async t => {
  const f = fixture(t), { goal } = await f.create();
  const submitted = await f.design(goal);
  assert.equal(submitted.budget.used.steps, 1); assert.equal(submitted.budget.used.no_progress, 0);
  assert.equal(submitted.design.tasks[0].id, 'implementation');
  await assert.rejects(f.call('submit_goal_design', { goal, operation_id: 'forged', source_job: '/tmp/unrelated-job' }), /source/i);
  await assert.rejects(f.call('review_goal_design', { goal, operation_id: 'no-feedback', design_fingerprint: submitted.design.fingerprint, checks: checks('failed') }), /feedback/i);
  const rejected = await f.call('review_goal_design', { goal, operation_id: 'reject', design_fingerprint: submitted.design.fingerprint, checks: checks('failed'), feedback });
  assert.equal(rejected.design.status, 'changes_requested');
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, rejected.design)), /approved|design/i);
});

test('approved design binds exact tasks, dependencies, prepared context and final completion obligations', async t => {
  const f = fixture(t), { goal } = await f.create();
  const submitted = await f.design(goal, 'design', [spec('first'), spec('second', ['first'])]);
  const approved = await f.approve(goal, submitted.design), design = approved.design;
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, design, 'second')), /dependencies/);
  const first = f.taskArgs(goal, design, 'first', 'first');
  await assert.rejects(f.call('advance_goal', { ...first, design_fingerprint: '0'.repeat(64) }), /fingerprint/);
  await assert.rejects(f.call('advance_goal', { ...first, execution: { ...first.execution, task: 'No approved design marker.' } }), /context/);
  await assert.rejects(f.call('advance_goal', { ...first, execution: { ...first.execution, task_contract: { ...first.execution.task_contract, context: 'Altered host design.' } } }), /plan|match|approved/i);
  const partial = await f.call('advance_goal', first);
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'partial', snapshot_fingerprint: partial.snapshot_fingerprint, checks: checks('passed') }), /accepted child/);
  const complete = await f.call('advance_goal', f.taskArgs(goal, design, 'second', 'second'));
  const done = await f.call('record_goal_review', { goal, review_id: 'complete', snapshot_fingerprint: complete.snapshot_fingerprint, checks: checks('passed') });
  assert.equal(done.status, 'completed');
  f.jobs.get(design.source_job).quality.acceptanceStatus = 'changes_requested';
  assert.notEqual((await f.call('goal_status', { goal })).status, 'completed', 'revoked worker design acceptance invalidates completion');
});

test('design revisions preserve cumulative budgets, supersede historical tasks and reject stale bindings', async t => {
  const f = fixture(t), { goal } = await f.create();
  const initial = await f.design(goal), approved = await f.approve(goal, initial.design);
  await f.call('advance_goal', f.taskArgs(goal, approved.design));
  const revised = await f.design(goal, 'design-2', [spec('revised')]);
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, approved.design, 'implementation', 'old-before-review')), /approved|design/i);
  const next = await f.approve(goal, revised.design, 'approve-2');
  assert.equal(next.budget.used.steps, 3); assert.equal(next.budget.used.reworks, 1);
  assert.equal(next.steps.find(s => s.operation_id === 'implement').superseded_by_design, next.design.fingerprint);
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, approved.design, 'implementation', 'old-after-review')), /fingerprint|design/i);
  const implemented = await f.call('advance_goal', f.taskArgs(goal, next.design, 'revised', 'new-implementation'));
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'revised-done', snapshot_fingerprint: implemented.snapshot_fingerprint, checks: checks('passed') })).status, 'completed');
});

test('new design attempts obey rework budgets and cannot replace an active or uncertain execution', async t => {
  const f = fixture(t, { limits: { max_steps: 6, max_reworks: 0, max_no_progress: 6 } }), { goal } = await f.create();
  const first = await f.design(goal);
  await assert.rejects(f.design(goal, 'over-budget'), /max_reworks/);
  assert.equal((await f.call('goal_status', { goal })).budget.used.steps, 1);
  const g = fixture(t), created = await g.create(), submitted = await g.design(created.goal);
  const approved = await g.approve(created.goal, submitted.design);
  const started = await g.call('advance_goal', g.taskArgs(created.goal, approved.design));
  g.jobs.get(started.steps.at(-1).job).status = 'running';
  await assert.rejects(g.design(created.goal, 'while-running'), /active|uncertain/);
  assert.equal(g.launches(), 2);
  assert.equal(first.design.status, 'pending_review');
});

test('design result mutation and source changes prevent approving stale design evidence', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal);
  fs.appendFileSync(path.join(submitted.design.source_job, 'result.md'), '\nUnreviewed extra output.');
  await assert.rejects(f.approve(goal, submitted.design), /result|changed|fingerprint/i);
  const g = fixture(t), created = await g.create(), source = await g.design(created.goal);
  fs.writeFileSync(path.join(g.project, 'src/a.txt'), 'changed');
  await assert.rejects(g.approve(created.goal, source.design), /source|snapshot|changed/i);
});

test('an uncertain implementation cannot launch on retry after its design acceptance is revoked', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal);
  const approved = await f.approve(goal, submitted.design), args = f.taskArgs(goal, approved.design);
  f.setFailure('Unknown dispatch reply before a job is visible.');
  await assert.rejects(f.call('advance_goal', args), /Unknown dispatch reply/);
  f.setFailure(null);
  f.jobs.get(approved.design.source_job).quality.acceptanceStatus = 'changes_requested';
  await assert.rejects(f.call('advance_goal', args), /accepted/);
  assert.equal(f.launches(), 2, 'revoked approval prevents another underlying dispatch call');
  const state = await f.call('goal_status', { goal });
  assert.equal(state.budget.used.steps, 2);
  assert.equal(state.steps.at(-1).status, 'dispatch_unknown');
});

test('replaying old design operations cannot restore approval after a revision starts', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal);
  const approved = await f.approve(goal, submitted.design);
  f.setResult('```agent-bridge-design\n' + JSON.stringify(proposal([spec('revised')])) + '\n```');
  await f.call('advance_goal', { goal, operation_id: 'revision', action: 'dispatch', participant_id: 'designer', role: 'design', execution: f.execution('plan') });
  const replayed = await f.approve(goal, submitted.design);
  assert.equal(replayed.reused, true); assert.equal(replayed.design_phase, 'designing');
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, approved.design)), /approval|design/);
});

test('design submission binds source as read at dispatch and rejects intervening source changes', async t => {
  const f = fixture(t), { goal } = await f.create();
  f.setResult('```agent-bridge-design\n' + JSON.stringify(proposal([spec()])) + '\n```');
  const dispatched = await f.call('advance_goal', { goal, operation_id: 'design', action: 'dispatch', participant_id: 'designer', role: 'design', execution: f.execution('plan') });
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'Edited after the worker inspected it.');
  await assert.rejects(f.call('submit_goal_design', { goal, operation_id: 'submit-stale-source', source_job: dispatched.steps[0].job }), /Source changed/);
  assert.equal((await f.call('goal_status', { goal })).design, null);
});

test('rerunning a prerequisite invalidates dependent acceptance until its work is repeated against the new evidence', async t => {
  const f = fixture(t), { goal } = await f.create();
  const submitted = await f.design(goal, 'design', [spec('first'), spec('second', ['first']), spec('third', ['second'])]);
  const { design } = await f.approve(goal, submitted.design);
  await f.call('advance_goal', f.taskArgs(goal, design, 'first', 'first-v1'));
  await f.call('advance_goal', f.taskArgs(goal, design, 'second', 'second-v1'));
  const changed = await f.call('advance_goal', f.taskArgs(goal, design, 'first', 'first-v2'));
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, design, 'third', 'third-before-fresh-review')), /dependencies/);
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'stale-dependents', snapshot_fingerprint: changed.snapshot_fingerprint, checks: checks('passed') }), /accepted child/);
  const fresh = await f.call('advance_goal', f.taskArgs(goal, design, 'second', 'second-v2'));
  assert.equal(fresh.steps.at(-1).dependency_bindings[0].job, changed.steps.at(-1).job);
  const final = await f.call('advance_goal', f.taskArgs(goal, design, 'third', 'third'));
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'fresh-dependents', snapshot_fingerprint: final.snapshot_fingerprint, checks: checks('passed') })).status, 'completed');
});

test('external source edits after approval cannot launch an old plan or consume a new execution budget', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal);
  const approved = await f.approve(goal, submitted.design);
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'External idle source change.');
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, approved.design)), /Source changed outside/);
  const current = await f.call('goal_status', { goal });
  assert.equal(current.budget.used.steps, 1); assert.equal(f.launches(), 1);
  assert.equal(current.approved_source_fingerprint, approved.snapshot_fingerprint);
  assert.notEqual(current.snapshot_fingerprint, current.approved_source_fingerprint);
});

test('external edits after accepted work block final acceptance and require a fresh design', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal);
  const approved = await f.approve(goal, submitted.design);
  const done = await f.call('advance_goal', f.taskArgs(goal, approved.design));
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'An untracked host implementation after worker completion.');
  const changed = await f.call('goal_status', { goal });
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'outside-edit', snapshot_fingerprint: changed.snapshot_fingerprint, checks: checks('passed') }), /Source changed outside/);
  await assert.rejects(f.call('advance_goal', f.taskArgs(goal, approved.design, 'implementation', 'retry-old-plan')), /Source changed outside/);
  assert.equal(changed.approved_source_fingerprint, done.snapshot_fingerprint);
  const revision = await f.design(goal, 'fresh-design', [spec('fresh-task')]);
  const fresh = await f.approve(goal, revision.design, 'fresh-approval');
  assert.equal(fresh.approved_source_fingerprint, changed.snapshot_fingerprint);
  const implemented = await f.call('advance_goal', f.taskArgs(goal, fresh.design, 'fresh-task', 'fresh-implementation'));
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'fresh-source', snapshot_fingerprint: implemented.snapshot_fingerprint, checks: checks('passed') })).status, 'completed');
});

test('a running worker can change source and only its ended result advances the expected source for later tasks', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal, 'design', [spec('first'), spec('second', ['first'])]);
  const approved = await f.approve(goal, submitted.design);
  f.setDispatchEffect((args, state) => { fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'Owned in-progress edit.'); state.status = 'running'; });
  const running = await f.call('advance_goal', f.taskArgs(goal, approved.design, 'first', 'first'));
  assert.equal(running.approved_source_fingerprint, approved.snapshot_fingerprint);
  assert.notEqual(running.snapshot_fingerprint, running.approved_source_fingerprint);
  assert.equal((await f.call('goal_status', { goal })).status, 'running');
  const job = running.steps.at(-1).job;
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'Owned completed edit.'); f.jobs.get(job).status = 'ready_for_review';
  const ended = await f.call('goal_status', { goal });
  assert.equal(ended.approved_source_fingerprint, ended.snapshot_fingerprint);
  f.setDispatchEffect(null);
  const completed = await f.call('advance_goal', f.taskArgs(goal, approved.design, 'second', 'second'));
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'owned-edits', snapshot_fingerprint: completed.snapshot_fingerprint, checks: checks('passed') })).status, 'completed');
});

test('an unknown implementation retry cannot launch after an idle source edit', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal), approved = await f.approve(goal, submitted.design);
  const args = f.taskArgs(goal, approved.design); f.setFailure('Unknown dispatch response.');
  await assert.rejects(f.call('advance_goal', args), /Unknown dispatch/);
  f.setFailure(null); fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'Changed while dispatch outcome was unknown.');
  await assert.rejects(f.call('advance_goal', args), /Source changed outside/);
  assert.equal(f.launches(), 2);
});

test('an ended failed worker preserves its partial edits as the source baseline for bounded rework', async t => {
  const f = fixture(t), { goal } = await f.create(), submitted = await f.design(goal), approved = await f.approve(goal, submitted.design);
  f.setDispatchEffect((args, state) => { fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'Owned partial edit before failure.'); state.status = 'failed'; });
  const failed = await f.call('advance_goal', f.taskArgs(goal, approved.design));
  assert.equal(failed.approved_source_fingerprint, failed.snapshot_fingerprint);
  await assert.rejects(f.call('record_goal_review', { goal, review_id: 'failed-child', snapshot_fingerprint: failed.snapshot_fingerprint, checks: checks('passed') }), /accepted child/);
  f.setDispatchEffect(null);
  const reworked = await f.call('advance_goal', f.taskArgs(goal, approved.design, 'implementation', 'bounded-rework'));
  assert.equal(reworked.budget.used.reworks, 1);
  assert.equal((await f.call('record_goal_review', { goal, review_id: 'reworked-child', snapshot_fingerprint: reworked.snapshot_fingerprint, checks: checks('passed') })).status, 'completed');
});
