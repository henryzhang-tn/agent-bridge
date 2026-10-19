import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delegationState, beginDesign, submitDesign, reviewDesign, approvedTask, assertPlannedTask,
  assertDelegationActor, assertApprovedDesign, designIsCurrent } from '../plugins/agent-bridge/scripts/delegation-policy.mjs';

const criteria = [{ id: 'runtime', description: 'Feature works', verification: 'Exercise the application', verification_kind: 'runtime' }];
const checks = status => [{ criterion_id: 'runtime', status, evidence: 'Reviewed design coverage and its validation method', verification_kind: 'source' }];
const feedback = [{ criterion_id: 'runtime', problem: 'Missing recovery path', required_change: 'Specify recovery behavior', verification: 'Trace interrupted execution in the design' }];
const task = (id = 'build') => ({ id, kind: 'implement', mode: 'edit', read_scope: ['src'], depends_on: [],
  task_contract: { complexity: 'standard', context: 'Implement bounded behavior', allowed_edits: ['src'], preserve: [], integration: 'Serially integrate accepted source', acceptance_criteria: criteria } });
const proposal = () => ({ summary: 'Implement the feature with recovery', decisions: ['Use existing state storage'], validation_plan: ['Exercise normal and interrupted application scenarios'], tasks: [task()] });
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-policy-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = { delegation_level: 'max', read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria };
  let n = 0;
  const submit = (p = proposal()) => {
    const job = path.join(dir, 'job-' + n++); fs.mkdirSync(job);
    fs.writeFileSync(path.join(job, 'result.md'), '```agent-bridge-design\n' + JSON.stringify(p) + '\n```\n');
    beginDesign(g);
    return submitDesign(g, { source_job: job }, { source_job: job, source_id: 'attempt-' + n, source_review_id: 'review', snapshot_fingerprint: 'initial' });
  };
  const review = (d, status = 'passed', extra = {}) => reviewDesign(g, { operation_id: 'review-' + n++, design_fingerprint: d.fingerprint, checks: checks(status), ...extra }, { sourceAccepted: true, snapshot_fingerprint: 'initial' });
  return { g, submit, review, dir };
}
test('four levels separate role policy from model effort, with legacy medium default', () => {
  assert.equal(delegationState({}).delegation_level, 'medium');
  for (const level of ['low', 'medium', 'high']) assert.doesNotThrow(() => assertDelegationActor({ delegation_level: level }, { kind: 'host', role: 'implement', mode: 'edit' }));
  for (const role of ['design', 'research', 'implement']) assert.throws(() => assertDelegationActor({ delegation_level: 'max' }, { kind: 'host', role, mode: 'plan' }));
  assert.throws(() => assertDelegationActor({ delegation_level: 'max' }, { kind: 'host', role: 'review', mode: 'edit' }));
  assert.doesNotThrow(() => assertDelegationActor({ delegation_level: 'max' }, { kind: 'host', role: 'review', mode: 'plan' }));
  assert.throws(() => assertDelegationActor({}, { kind: 'worker', role: 'design', mode: 'edit' }), /plan mode/);
});
test('design approval proves source coverage, preserving runtime criteria for final acceptance', t => {
  const f = fixture(t); const d = f.submit();
  assert.throws(() => assertApprovedDesign(f.g, true), /approval/);
  f.review(d);
  assert.equal(d.review.evaluation, 'design_coverage');
  assert.equal(f.g.acceptance_criteria[0].verification_kind, 'runtime');
  assert.equal(approvedTask(f.g, 'build', true).mode, 'edit');
  assert.throws(() => assertApprovedDesign(f.g, false), /accepted/);
  fs.appendFileSync(path.join(d.source_job, 'result.md'), 'Changed evidence');
  assert.equal(designIsCurrent(f.g, true), false);
});
test('proposal parsing rejects extra fences, invalid scopes, role laundering and task graph cycles', t => {
  const f = fixture(t);
  for (const change of [p => { p.tasks[0].read_scope = ['../secret']; }, p => { p.tasks[0].task_contract.allowed_edits = ['src/.git']; },
    p => { p.tasks[0].kind = 'review'; }, p => { p.tasks[0].depends_on = ['build']; }, p => { p.tasks.push({ ...task('two'), depends_on: ['build'] }); p.tasks[0].depends_on = ['two']; }]) {
    const p = proposal(); change(p); assert.throws(() => f.submit(p));
  }
  const job = path.join(f.dir, 'extra'); fs.mkdirSync(job);
  fs.writeFileSync(path.join(job, 'result.md'), ('```agent-bridge-design\n' + JSON.stringify(proposal()) + '\n```\n').repeat(2));
  beginDesign(f.g); assert.throws(() => submitDesign(f.g, { source_job: job }, { source_job: job }), /exactly one/);
});
test('rejection needs actionable criterion-bound feedback; failed reviews share no-progress budget', t => {
  const f = fixture(t), d = f.submit();
  assert.throws(() => f.review(d, 'failed'), /structured feedback/);
  f.review(d, 'failed', { feedback }); assert.equal(d.status, 'changes_requested');
  assert.throws(() => f.review(d), /fresh worker revision/);
  f.review(d, 'failed', { feedback: [{ ...feedback[0], problem: 'Different wording for the same outcome' }] });
  assert.equal(f.g.design_no_progress, 1);
  const revised = f.submit(); assert.equal(f.g.design_no_progress, 2);
  assert.notEqual(revised.fingerprint, d.fingerprint);
  assert.equal(revised.version, 2); assert.equal(f.g.designs.length, 2);
  assert.throws(() => f.review(d), /stale/);
});
test('approval binds exact task scopes, contract and current source snapshot', t => {
  const f = fixture(t), d = f.submit();
  assert.throws(() => reviewDesign(f.g, { operation_id: 'wrong', design_fingerprint: d.fingerprint, checks: checks('passed') }, { sourceAccepted: true, snapshot_fingerprint: 'changed' }), /Source changed/);
  f.review(d); assert.doesNotThrow(() => assertPlannedTask(f.g, task(), true));
  const altered = task(); altered.task_contract.integration = 'Skip integration review';
  assert.throws(() => assertPlannedTask(f.g, altered, true), /exact approved/);
  beginDesign(f.g); assert.equal(designIsCurrent(f.g, true), false);
});
test('changing only design summary does not disguise repeated design work', t => {
  const f = fixture(t);
  const first = f.submit(); f.review(first, 'failed', { feedback });
  const p = proposal(); p.summary = 'A differently worded summary of the same design';
  const second = f.submit(p);
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.equal(first.progress_fingerprint, second.progress_fingerprint);
  assert.equal(f.g.design_no_progress, 1);
  f.review(second, 'failed', { feedback });
  assert.equal(f.g.design_no_progress, 2);
});
test('design revisions preserve integrated task dependencies and immutable historical IDs', t => {
  const f = fixture(t);
  f.g.tasks = [{ ...task('old'), status: 'integrated' }];
  const p = proposal(); p.tasks[0].depends_on = ['old'];
  assert.doesNotThrow(() => f.submit(p));
  p.tasks[0].id = 'old'; p.tasks[0].depends_on = [];
  assert.throws(() => f.submit(p), /new task IDs/);
});
