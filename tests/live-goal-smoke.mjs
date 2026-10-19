// Explicit live inference; excluded from the offline *.test.mjs suite.
// node tests/live-goal-smoke.mjs PROJECT GOAL_ID WORKER PROVIDER MODEL EFFORT AUTHORIZED_ENDPOINT --authorized
import assert from 'node:assert/strict';
import path from 'node:path';
import { callTool } from '../plugins/agent-bridge/scripts/mcp-server.mjs';

const [project, goal_id, worker, provider, model, effort, endpoint, authorized] = process.argv.slice(2);
assert(project && path.isAbsolute(project) && goal_id && worker && provider && model && effort && endpoint && authorized === '--authorized',
  'Supply the absolute project, goal ID, exact selection and already-authorized endpoint, followed by --authorized.');
const criteria = [{ id: 'relay', description: 'Two real worker turns exchange and return the expected marker.',
  verification: 'Host compares real worker results and the persisted relay message.', verification_kind: 'runtime' }];
const task_contract = { complexity: 'standard', context: 'Synthetic live goal relay; no project source reads or edits.',
  allowed_edits: [], preserve: [], integration: 'Host verifies exact returned markers and records independent evidence.', acceptance_criteria: criteria };
const participants = ['sender', 'receiver'].map(id => ({ id, worker, provider, model, effort, endpoint, mode: 'plan' }));
const marker = 'AGENT_BRIDGE_GOAL_RELAY_OK';
let goal;
const call = (name, args) => callTool(name, args);
const acceptedChecks = evidence => [{ criterion_id: 'relay', status: 'passed', verification_kind: 'runtime', evidence }];
try {
  const catalog = await call('list_models', { project, worker });
  assert(catalog.models.some(x => x.provider_id === provider && x.model === model && x.reasoning_levels.includes(effort)), 'Selected model/effort must be available.');
  const created = await call('create_goal', { project, goal_id, objective: 'Verify a real two-participant goal loop.',
    context: 'Synthetic sender-to-receiver relay with host verification; no source reads.', read_scope: [], allowed_edits: [],
    acceptance_criteria: criteria, participants, limits: { max_steps: 2, max_reworks: 1, max_no_progress: 2 } });
  goal = created.goal;
  console.log(JSON.stringify({ event: 'goal_created', goal, model, endpoint }));
  const turn = async (participant_id, task) => {
    const selection = { project, worker, provider, model, effort, mode: 'plan', read_scope: [], task_contract, task,
      selection_reason: 'User-authorized GLM-5.3 synthetic goal relay; standard task uses supported high effort.' };
    const prepared = await call('prepare_dispatch', selection);
    assert.equal(prepared.destination.endpoint, endpoint, 'Actual destination must equal the explicitly authorized endpoint.');
    const execution = { ...selection, prepared_ref: prepared.preparedRef, endpoint };
    const advanced = await call('advance_goal', { goal, operation_id: participant_id + '-turn', action: 'dispatch', participant_id, execution });
    const job = advanced.steps.at(-1).job;
    assert(job);
    let status;
    do {
      status = await call('task_status', { job, wait_seconds: 30 });
      console.log(JSON.stringify({ event: 'turn_status', participant_id, status: status.status, phase: status.progress?.phase }));
    } while (['queued', 'running', 'cancelling'].includes(status.status));
    assert.equal(status.status, 'ready_for_review');
    const result = await call('task_result', { job });
    assert.equal(result.summary.trim(), marker);
    assert.equal(result.provider, provider); assert.equal(result.model, model);
    await call('record_review', { job, review_id: participant_id + '-verified',
      checks: acceptedChecks('Host compared the real ' + model + ' response to the exact synthetic relay marker; it matched.') });
    return { job, summary: result.summary.trim(), effortEvidence: result.effortEvidence };
  };
  const sender = await turn('sender', 'Synthetic connectivity task only. Do not read or modify source, run commands, use tools or contact other services. Return exactly ' + marker + ' as your final answer.');
  await call('send_goal_message', { goal, message_id: 'relay-message', source_job: sender.job, to: 'receiver', type: 'note', body: sender.summary });
  const inbox = await call('read_goal_messages', { goal, recipient: 'receiver' });
  const relay = inbox.messages.find(message => message.message_id === 'relay-message');
  assert.equal(relay?.from, 'sender'); assert.equal(relay?.body, marker);
  const receiver = await turn('receiver', 'Synthetic relay only. Do not read or modify source, run commands, use tools or contact other services. Return exactly the marker in this host-relayed message as your final answer. Message: ' + relay.body);
  const before = await call('goal_status', { goal });
  const result = await call('record_goal_review', { goal, review_id: 'live-goal-verified', snapshot_fingerprint: before.snapshot_fingerprint,
    checks: acceptedChecks('Host verified both real worker responses equal the expected marker and verified the persisted sender-to-receiver message. Both child-task reviews passed.') });
  assert.equal(result.status, 'completed');
  console.log(JSON.stringify({ event: 'goal_verified', goal, status: result.status, jobs: [sender.job, receiver.job], model,
    effortEvidence: [sender.effortEvidence, receiver.effortEvidence] }));
} catch (error) {
  if (goal) {
    try { await call('advance_goal', { goal, operation_id: 'smoke-failed-cancel', action: 'cancel', reason: 'Live smoke failed; stop remaining work.' }); } catch {}
  }
  throw error;
}
