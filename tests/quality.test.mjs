import test from 'node:test';
import assert from 'node:assert/strict';
import { taskContract, reviewChecks, recommendedEffort, catalogGuidance, effortEvidence, qualitySummary } from '../plugins/agent-bridge/scripts/quality.mjs';

const contract = () => ({ complexity: 'complex', context: 'Existing integration decisions and entry points.',
  allowed_edits: ['src/new.mjs'], preserve: ['Preserve existing edits.'], integration: 'Host tests the real application; worker implements the module.',
  acceptance_criteria: [{ id: 'save', description: 'Settings survive restart.', verification: 'Restart the actual application with synthetic settings.', verification_kind: 'runtime' }] });

test('contracts reject empty criteria, duplicate IDs, unknown fields and edits outside declared scope', () => {
  const options = { mode: 'edit', readScope: ['src'] };
  assert.deepEqual(taskContract(contract(), options).allowed_edits, ['src/new.mjs']);
  for (const value of [
    { ...contract(), acceptance_criteria: [] },
    { ...contract(), acceptance_criteria: [...contract().acceptance_criteria, ...contract().acceptance_criteria] },
    { ...contract(), allowed_edits: ['../elsewhere'] },
    { ...contract(), allowed_edits: ['/absolute'] },
    { ...contract(), allowed_edits: ['other/file'] },
    { ...contract(), unexpected: true },
    { ...contract(), context: ' ' },
    { ...contract(), preserve: [42] },
  ]) assert.throws(() => taskContract(value, options));
  assert.throws(() => taskContract(contract(), { ...options, mode: 'plan' }), /must be empty/);
  assert.throws(() => taskContract({ ...contract(), allowed_edits: ['.ai/task.json'] }, { mode: 'edit', readScope: ['.'] }), /metadata/);
  assert.equal(taskContract(undefined, options), null);
});

test('host checks cannot omit criteria or substitute mocks for required runtime evidence', () => {
  const check = { criterion_id: 'save', status: 'passed', evidence: 'Actual application reopened and loaded settings.', verification_kind: 'runtime' };
  assert.deepEqual(reviewChecks(contract(), [check]), [check]);
  assert.throws(() => reviewChecks(contract(), []));
  assert.throws(() => reviewChecks(contract(), [check, check]), /Duplicate/);
  assert.throws(() => reviewChecks(contract(), [{ ...check, criterion_id: 'other' }]), /Missing/);
  assert.throws(() => reviewChecks(contract(), [{ ...check, verification_kind: 'test' }]), /runtime evidence/);
  assert.throws(() => reviewChecks(null, [check]), /legacy/);
  assert.throws(() => reviewChecks(contract(), [{ ...check, evidence: '' }]));
});

test('quality guidance preserves model identity and only orders supported reasoning controls', () => {
  assert.equal(recommendedEffort('standard', ['low', 'high', 'max']), 'high');
  assert.equal(recommendedEffort('complex', ['low', 'high', 'max']), 'max');
  assert.equal(recommendedEffort('complex', ['low', 'xhigh']), 'xhigh');
  assert.equal(recommendedEffort('complex', ['provider-default']), null);
  assert.equal(recommendedEffort('complex', ['custom-small', 'custom-large']), null);
  const catalog = catalogGuidance({ worker: 'fixture', models: [{ model: 'user-selected-model', reasoning_levels: ['low', 'high', 'max'] }] });
  assert.equal(catalog.models[0].model, 'user-selected-model');
  assert.equal(catalog.models[0].recommended_effort.complex, 'max');
  assert.equal(catalog.selectionGuidance.modelRanking, 'not-inferred');
  const evidence = effortEvidence({ effort: 'max' }, { parameter: '--effort' });
  assert.equal(evidence.sentToRuntime, 'max');
  assert.equal(evidence.runtimeConfirmed, null);
  assert.equal(evidence.providerConfirmed, null);
  assert.equal(effortEvidence({ effort: 'provider-default' }, { parameter: '--effort' }).sentToRuntime, null);
  const q = qualitySummary({ taskContract: contract(), effort: 'high', effortEvidence: { supportedLevels: ['high', 'max'] }, reworkCount: 2 }, null);
  assert.equal(q.acceptanceStatus, 'pending');
  assert.equal(q.recommendedEffort, 'max');
  assert.equal(q.warnings.length, 2);
  assert.ok(qualitySummary({ taskContract: { ...contract(), complexity: 'standard' }, effort: 'low', effortEvidence: { supportedLevels: ['low', 'high', 'max'] } }, null).warnings[0].startsWith('standard_task_below'));
  assert.equal(qualitySummary({ taskContract: { ...contract(), complexity: 'standard' }, effort: 'max', effortEvidence: { supportedLevels: ['low', 'high', 'max'] } }, null).warnings.length, 0);
  assert.equal(qualitySummary({}, null).acceptanceStatus, 'unstructured');
});
