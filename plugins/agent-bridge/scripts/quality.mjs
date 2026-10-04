import path from 'node:path';

const text = (maxLength = 2400) => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(80), pattern: '^[A-Za-z0-9._-]{1,80}$' };
const paths = { type: 'array', maxItems: 50, items: text(4096) };
export const verificationKinds = ['source', 'test', 'runtime'];
export const contractSchema = {
  type: 'object', additionalProperties: false,
  required: ['complexity', 'context', 'allowed_edits', 'preserve', 'integration', 'acceptance_criteria'],
  properties: {
    complexity: { type: 'string', enum: ['simple', 'standard', 'complex'] },
    context: { ...text(6000), description: 'Relevant background, decisions and source entry points; never the full conversation or secrets.' },
    allowed_edits: { ...paths, description: 'Relative files/directories the worker may edit; empty for plan mode. New paths are allowed within read_scope.' },
    preserve: { type: 'array', maxItems: 30, items: text(), description: 'Existing changes and behavior to preserve.' },
    integration: { ...text(), description: 'Dependencies and explicit worker/host integration and verification responsibilities.' },
    acceptance_criteria: { type: 'array', minItems: 1, maxItems: 50, items: {
      type: 'object', additionalProperties: false, required: ['id', 'description', 'verification', 'verification_kind'],
      properties: { id, description: text(), verification: text(), verification_kind: { type: 'string', enum: verificationKinds } },
    } },
  },
};
export const checksSchema = { type: 'array', minItems: 1, maxItems: 50, items: {
  type: 'object', additionalProperties: false, required: ['criterion_id', 'status', 'evidence', 'verification_kind'],
  properties: { criterion_id: id, status: { type: 'string', enum: ['passed', 'failed', 'unverified'] },
    evidence: text(5000), verification_kind: { type: 'string', enum: verificationKinds } },
} };

// Used for the nested MCP fields and again by CLI, before writing any records.
export function validateValue(value, schema, label) {
  const invalid = () => { throw new Error('Invalid ' + schema.type + ': ' + label); };
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') invalid();
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error('Missing required argument: ' + label + '.' + key);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new Error('Unknown argument: ' + label + '.' + key);
      validateValue(item, schema.properties[key], label + '.' + key);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? Infinity)) invalid();
    value.forEach((item, i) => validateValue(item, schema.items, label + '[' + i + ']'));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? Infinity)) invalid();
  } else if (schema.type === 'integer') {
    if (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) invalid();
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error('Unsupported ' + label);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) invalid();
}

export function taskContract(value, { mode, readScope }) {
  if (value === undefined) return null; // Old clients/jobs remain explicitly unstructured.
  validateValue(value, contractSchema, 'task_contract');
  if (mode === 'plan' && value.allowed_edits.length) throw new Error('plan task_contract.allowed_edits must be empty');
  const allowed = value.allowed_edits.map(p => {
    if (path.isAbsolute(p)) throw new Error('allowed_edits must use relative project paths');
    const normalized = path.posix.normalize(p);
    if (normalized === '..' || normalized.startsWith('../')) throw new Error('allowed_edits escapes the project');
    if (normalized === '.ai' || normalized.startsWith('.ai/')) throw new Error('Worker must not edit .ai task metadata');
    if (!readScope.some(scope => scope === '.' || normalized === scope || normalized.startsWith(scope + '/'))) throw new Error('allowed_edits must stay within read_scope');
    return normalized;
  });
  const ids = value.acceptance_criteria.map(c => c.id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate acceptance criterion id');
  return { complexity: value.complexity, context: value.context, allowed_edits: [...new Set(allowed)].sort(),
    preserve: value.preserve, integration: value.integration,
    acceptance_criteria: value.acceptance_criteria.map(c => ({ id: c.id, description: c.description, verification: c.verification, verification_kind: c.verification_kind })) };
}

export function reviewChecks(contract, checks) {
  if (!contract) throw new Error('This legacy job has no task_contract; continue with a structured contract before recording acceptance.');
  validateValue(checks, checksSchema, 'checks');
  const byId = new Map();
  for (const check of checks) {
    if (byId.has(check.criterion_id)) throw new Error('Duplicate review criterion id');
    byId.set(check.criterion_id, check);
  }
  if (checks.length !== contract.acceptance_criteria.length) throw new Error('Review must cover every acceptance criterion exactly once');
  return contract.acceptance_criteria.map(criterion => {
    const check = byId.get(criterion.id);
    if (!check) throw new Error('Missing review criterion: ' + criterion.id);
    if (check.status === 'passed' && check.verification_kind !== criterion.verification_kind) throw new Error('Passed criterion ' + criterion.id + ' requires ' + criterion.verification_kind + ' evidence');
    return { criterion_id: check.criterion_id, status: check.status, evidence: check.evidence, verification_kind: check.verification_kind };
  });
}

const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function recommendedEffort(complexity, levels = []) {
  // Unknown provider-specific controls are never assigned an invented ordering.
  const highest = efforts.filter(e => levels.includes(e)).at(-1) || null;
  return complexity === 'complex' ? highest : levels.includes('high') ? 'high' : highest;
}
export function catalogGuidance(catalog) {
  return { ...catalog, selectionGuidance: {
    policy: 'quality-first', modelRanking: 'not-inferred',
    rule: 'Host selects a configured preferred full model from the actual catalog. Use high for standard tasks and the highest verified supported effort for complex tasks. Preserve explicit user choices; do not infer model quality from the worker name or silently downgrade.',
  }, models: (catalog.models || []).map(m => ({ ...m, recommended_effort: {
    standard: recommendedEffort('standard', m.reasoning_levels), complex: recommendedEffort('complex', m.reasoning_levels),
  } })) };
}
export function effortEvidence(state, { parameter, supportedLevels = [], runtimeConfirmed = null, confirmationSource = null }) {
  return { requested: state.effort, sentToRuntime: state.effort === 'provider-default' ? null : state.effort,
    parameter, supportedLevels, runtimeConfirmed, confirmationSource, providerConfirmed: null };
}
export function qualitySummary(state, review) {
  const recommended = recommendedEffort(state.taskContract?.complexity, state.effortEvidence?.supportedLevels);
  const warnings = [];
  if (!state.taskContract) warnings.push('legacy_unstructured_task: no machine-checkable acceptance criteria');
  if (state.taskContract && recommended && efforts.includes(state.effort) && efforts.indexOf(state.effort) < efforts.indexOf(recommended)) warnings.push(state.taskContract.complexity + '_task_below_recommended_effort: ' + recommended + ' (explicit selection preserved)');
  if ((state.reworkCount || 0) >= 2) warnings.push('repeated_rework: host should reassess the model or task split before another attempt');
  return { policy: 'quality-first', contract: state.taskContract ? 'structured' : 'legacy',
    complexity: state.taskContract?.complexity || null, recommendedEffort: recommended,
    acceptanceStatus: review?.status || (state.taskContract ? 'pending' : 'unstructured'),
    reworkCount: state.reworkCount || 0, warnings };
}
