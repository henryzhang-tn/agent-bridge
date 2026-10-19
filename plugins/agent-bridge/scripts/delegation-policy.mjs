import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateValue, contractSchema, checksSchema, taskContract, reviewChecks } from './quality.mjs';

const text = (maxLength = 6000) => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(80), pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$' };
const operationId = { ...text(80), pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' };
const fingerprint = { ...text(64), pattern: '^[a-f0-9]{64}$' };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const strings = (maxItems = 50) => ({ type: 'array', maxItems, items: text(4096) });
const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => hash(stable(value));
export const delegationLevelSchema = { type: 'string', enum: ['low', 'medium', 'high', 'max'] };
export const taskRoleSchema = { type: 'string', enum: ['design', 'implement', 'research', 'review'] };
export const feedbackSchema = { type: 'array', maxItems: 50, items: object({
  criterion_id: checksSchema.items.properties.criterion_id, problem: text(), required_change: text(), verification: text(),
}) };
export const designTaskSchema = object({ id, kind: { type: 'string', enum: ['implement', 'research', 'review'] },
  depends_on: { type: 'array', maxItems: 100, items: id }, read_scope: strings(),
  mode: { type: 'string', enum: ['plan', 'edit'] }, task_contract: contractSchema, review_of: id,
}, ['id', 'kind', 'depends_on', 'read_scope', 'mode', 'task_contract']);
export const proposalSchema = object({ summary: text(), decisions: { ...strings(), minItems: 1 },
  validation_plan: { ...strings(), minItems: 1 }, tasks: { type: 'array', minItems: 1, maxItems: 100, items: designTaskSchema },
});
const designSchemas = {
  submit_goal_design: object({ goal: text(4096), operation_id: operationId, source_job: text(4096) }),
  review_goal_design: object({ goal: text(4096), operation_id: operationId, design_fingerprint: fingerprint,
    checks: checksSchema, feedback: feedbackSchema }, ['goal', 'operation_id', 'design_fingerprint', 'checks']),
};
export const designTools = Object.entries(designSchemas).map(([name, inputSchema]) => ({ name, inputSchema,
  description: name === 'submit_goal_design'
    ? 'Capture a structured design from an ended, accepted goal design worker result. The worker owns the proposal; no implementation authorization is granted.'
    : 'Review exact worker design coverage with source evidence. Every failed or unverified criterion needs structured change instructions. This is not final runtime acceptance.',
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}));

export function level(g) { return g.delegation_level || 'medium'; }
export function requiresDesign(g) { return ['high', 'max'].includes(level(g)); }
export function delegationState(g) {
  const current = level(g);
  return { delegation_level: current, delegation_policy: {
    worker_design_first: requiresDesign(g), host_implementation: current !== 'max',
    host_role: current === 'max' ? 'review_and_orchestration' : current === 'low' ? 'primary_executor' : current === 'medium' ? 'designer_and_reviewer' : 'reviewer_and_helper',
    automatic_takeover: false,
  }, design_phase: g.design_phase || (requiresDesign(g) ? 'required' : 'optional'), design: g.design || null, designs: g.designs || [] };
}
export function assertDelegationActor(g, { kind, role, mode }) {
  if (role === 'design' && (kind !== 'worker' || mode !== 'plan')) throw new Error('Design tasks require a worker in plan mode');
  if (level(g) === 'max' && kind === 'host' && (role !== 'review' || mode !== 'plan')) {
    throw new Error('max delegation permits host review and orchestration only; no host design, research or implementation takeover');
  }
}
export function beginDesign(g) { g.design_phase = 'designing'; }

function relative(value) {
  if (path.isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new Error('Design scopes must use relative project paths');
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/').some(part => part === '.git' || part === '.ai')) throw new Error('Design scope escapes the project or includes reserved metadata');
  return normalized;
}
const within = (value, scopes) => scopes.some(scope => scope === '.' || value === scope || value.startsWith(scope + '/'));
function normalizedTask(input, g) {
  validateValue(input, designTaskSchema, 'design task');
  const read_scope = [...new Set(input.read_scope.map(relative))].sort();
  if (read_scope.some(item => !within(item, g.read_scope))) throw new Error('Design task read scope exceeds the goal');
  const contract = taskContract(input.task_contract, { mode: input.mode, readScope: read_scope });
  contract.allowed_edits = contract.allowed_edits.map(relative);
  if (contract.allowed_edits.some(item => !within(item, g.allowed_edits))) throw new Error('Design task edit scope exceeds the goal');
  if (new Set(input.depends_on).size !== input.depends_on.length) throw new Error('Duplicate design dependency');
  if (input.kind === 'implement' && input.mode !== 'edit') throw new Error('Implementation design tasks must use edit mode');
  if (input.kind !== 'implement' && input.mode !== 'plan') throw new Error('Research and review design tasks must use plan mode');
  if (input.review_of && input.kind !== 'review') throw new Error('Only review tasks may specify review_of');
  return { ...input, read_scope, task_contract: contract };
}
function validateProposal(g, value) {
  validateValue(value, proposalSchema, 'design proposal');
  const tasks = value.tasks.map(t => normalizedTask(t, g));
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error('Duplicate design task ID');
  // An approved revision can depend on already integrated work, whose evidence remains required.
  const retained = new Map((g.tasks || []).filter(t => t.status === 'integrated' && t.kind !== 'design').map(t => [t.id, t]));
  for (const t of tasks) if ((g.tasks || []).some(old => old.id === t.id)) throw new Error('Design revisions must use new task IDs; prior task history is immutable');
  const visiting = new Set(), visited = new Set();
  function visit(t) {
    if (visiting.has(t.id)) throw new Error('Design task dependency cycle');
    if (visited.has(t.id)) return;
    visiting.add(t.id);
    for (const dep of [...t.depends_on, ...(t.review_of ? [t.review_of] : [])]) {
      if (dep === t.id || (!byId.has(dep) && !retained.has(dep))) throw new Error('Unknown or self design dependency');
      if (byId.has(dep)) visit(byId.get(dep));
    }
    if (t.review_of && digest(t.read_scope) !== digest((byId.get(t.review_of) || retained.get(t.review_of)).read_scope)) throw new Error('Design review must read the target task scope');
    visiting.delete(t.id); visited.add(t.id);
  }
  tasks.forEach(visit);
  return { ...value, tasks };
}
function resultBytes(job) {
  if (!path.isAbsolute(job)) throw new Error('Design source job must be absolute');
  // The controller verifies membership; these checks prevent substituted result paths.
  if (fs.realpathSync(job) !== path.normalize(job)) throw new Error('Design source job symlinks are forbidden');
  const file = path.join(job, 'result.md'); const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Design result must be a regular file of at most 128 KiB');
  return fs.readFileSync(file, 'utf8');
}
export function submitDesign(g, args, source) {
  if (g.design_phase !== 'designing') throw new Error('Start a linked design task before submitting a design revision');
  if (source.source_job !== args.source_job) throw new Error('Design source job differs from its linked attempt');
  if ((g.designs || []).some(d => d.source_job === args.source_job)) throw new Error('This design job already supplied a proposal; run a new design attempt for revision');
  const result = resultBytes(args.source_job);
  const matches = [...result.matchAll(/^```agent-bridge-design\s*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
  if (matches.length !== 1) throw new Error('Worker result must contain exactly one complete agent-bridge-design JSON fence');
  let raw;
  try { raw = JSON.parse(matches[0][1]); } catch { throw new Error('Worker design fence must contain valid JSON'); }
  const proposal = validateProposal(g, raw);
  const contentFingerprint = digest(proposal);
  const progressFingerprint = digest({ decisions: proposal.decisions, validation_plan: proposal.validation_plan, tasks: proposal.tasks });
  const designs = g.designs || [];
  if (designs.some(d => d.progress_fingerprint === progressFingerprint)) g.design_no_progress = (g.design_no_progress || 0) + 1;
  const frozen = { ...proposal, ...source, version: designs.length + 1,
    source_result_fingerprint: hash(result), proposal_fingerprint: contentFingerprint, progress_fingerprint: progressFingerprint };
  const design = { ...frozen, fingerprint: digest(frozen), status: 'pending_review', submitted_at: Date.now(), reviews: [] };
  g.designs = [...designs, design]; g.design = design; g.design_phase = 'pending_review';
  return design;
}
function assertSource(design, accepted) {
  if (!accepted) throw new Error('Design source worker must remain ended and independently accepted');
  if (hash(resultBytes(design.source_job)) !== design.source_result_fingerprint) throw new Error('Design worker result changed; its approval is stale');
}
export function validateFeedback(checks, feedback = [], required = false) {
  validateValue(feedback, feedbackSchema, 'feedback');
  const ids = new Set(checks.map(c => c.criterion_id));
  if (feedback.some(f => !ids.has(f.criterion_id))) throw new Error('Feedback references an unknown review criterion');
  if (required && checks.some(c => c.status !== 'passed' && !feedback.some(f => f.criterion_id === c.criterion_id))) {
    throw new Error('Every failed or unverified criterion requires structured feedback: problem, required_change and verification');
  }
  return feedback;
}
export function reviewDesign(g, args, { sourceAccepted, snapshot_fingerprint }) {
  const d = g.design;
  if (!d || d.fingerprint !== args.design_fingerprint || !['pending_review', 'changes_requested', 'approved'].includes(g.design_phase)) throw new Error('Design fingerprint is stale or a new design is in progress');
  assertSource(d, sourceAccepted);
  if (d.snapshot_fingerprint !== snapshot_fingerprint) throw new Error('Source changed since the design proposal; obtain a fresh worker design');
  // Approving coverage of a runtime criterion does not claim runtime success before implementation.
  const checks = reviewChecks({ acceptance_criteria: g.acceptance_criteria.map(c => ({ ...c, verification_kind: 'source' })) }, args.checks);
  const feedback = validateFeedback(checks, args.feedback, true);
  const status = checks.every(c => c.status === 'passed') ? 'approved' : 'changes_requested';
  if (status === 'approved' && d.status === 'changes_requested') throw new Error('A rejected design requires a fresh worker revision before approval');
  const outcome = digest({ proposal: d.progress_fingerprint, checks: checks.map(({ criterion_id, status }) => ({ criterion_id, status })).sort((a, b) => a.criterion_id.localeCompare(b.criterion_id)) });
  if (status !== 'approved' && (g.designs || []).some(design => design.reviews.some(r => r.outcome_fingerprint === outcome))) g.design_no_progress = (g.design_no_progress || 0) + 1;
  const review = { operation_id: args.operation_id, design_fingerprint: d.fingerprint, checks, feedback,
    evaluation: 'design_coverage', status, outcome_fingerprint: outcome, at: Date.now() };
  d.reviews.push(review); d.review = review; d.status = status; g.design_phase = status;
  // JSON persistence duplicates this record in history, so update both references on every review.
  g.designs = g.designs.map(item => item.fingerprint === d.fingerprint ? d : item);
  return d;
}
export function assertApprovedDesign(g, sourceAccepted) {
  const d = g.design;
  if (!d || g.design_phase !== 'approved' || d.status !== 'approved') throw new Error('Worker design approval is required before implementation or other planned work');
  assertSource(d, sourceAccepted); return d;
}
export function designIsCurrent(g, sourceAccepted) {
  try { assertApprovedDesign(g, sourceAccepted); return true; } catch { return false; }
}
export function approvedTask(g, taskId, sourceAccepted) {
  const d = assertApprovedDesign(g, sourceAccepted); const t = d.tasks.find(t => t.id === taskId);
  if (!t) throw new Error('Task is absent from the approved worker design');
  return t;
}
export function assertPlannedTask(g, input, sourceAccepted) {
  const expected = approvedTask(g, input.id, sourceAccepted);
  if (digest(normalizedTask(input, g)) !== digest(expected)) throw new Error('Task must match the exact approved worker design contract');
  return expected;
}
export function designExecutionContext(g, taskId) { return 'Approved design: ' + g.design.fingerprint + '\nDesign task: ' + taskId; }
