import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../plugins/agent-bridge/scripts/mcp-server.mjs', import.meta.url));
const qualityContract = () => ({ complexity: 'complex', context: 'Synthetic fixture only; no private source.', allowed_edits: [],
  preserve: ['Preserve the fixture.'], integration: 'Host independently inspects the result and runs a synthetic runtime scenario.',
  acceptance_criteria: [
    { id: 'implementation', description: 'Return the requested model result.', verification: 'Inspect the actual result.', verification_kind: 'source' },
    { id: 'runtime', description: 'The application scenario works.', verification: 'Run the synthetic scenario.', verification_kind: 'runtime' },
  ] });
const reviewChecks = () => [
  { criterion_id: 'implementation', status: 'passed', evidence: 'Host inspected the synthetic result.', verification_kind: 'source' },
  { criterion_id: 'runtime', status: 'passed', evidence: 'Host ran the synthetic application scenario.', verification_kind: 'runtime' },
];

test('structured tasks bind criteria to preflight and expose pending acceptance and reasoning provenance', async t => {
  const f = fixture(t), contract = qualityContract();
  const selected = { ...f.args, task_contract: contract };
  const prepared = (await f.call('prepare_dispatch', selected)).structuredContent;
  assert.equal(prepared.quality.contract, 'structured');
  const changed = { ...contract, integration: 'Different responsibility.' };
  const refused = await f.call('dispatch_task', { ...selected, task_contract: changed, prepared_ref: prepared.preparedRef, endpoint: prepared.destination.endpoint });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /changed since preparation/);
  assert.equal(f.requestLog().length, 0);
  const submitted = await f.dispatch({ task_contract: contract });
  const job = submitted.structuredContent.job;
  const finished = (await f.call('task_status', { job, wait_seconds: 3 })).structuredContent;
  assert.equal(finished.quality.acceptanceStatus, 'pending');
  assert.equal(finished.effortEvidence.requested, 'high');
  assert.equal(finished.effortEvidence.sentToRuntime, 'high');
  assert.equal(finished.effortEvidence.runtimeConfirmed, 'high');
  assert.equal(finished.effortEvidence.providerConfirmed, null);
  assert.equal(finished.quality.recommendedEffort, 'max');
  assert.ok(finished.quality.warnings.some(w => w.startsWith('complex_task_below')));
  assert.equal(finished.effort, 'high', 'explicit selection is never overridden');
  assert.deepEqual(finished.taskContract.acceptance_criteria, contract.acceptance_criteria);
});

test('host acceptance requires complete independent evidence, preserves history and never runs inference', async t => {
  const f = fixture(t);
  const job = (await f.dispatch({ task_contract: qualityContract() })).structuredContent.job;
  await f.call('task_status', { job, wait_seconds: 3 });
  const before = f.requestLog().length;
  for (const checks of [reviewChecks().slice(0, 1), [reviewChecks()[0], reviewChecks()[0]],
    [reviewChecks()[0], { ...reviewChecks()[1], criterion_id: 'unknown' }],
    [reviewChecks()[0], { ...reviewChecks()[1], verification_kind: 'test' }]]) {
    const refused = await f.call('record_review', { job, review_id: 'bad-review', checks });
    assert.equal(refused.isError, true);
  }
  const unverified = [reviewChecks()[0], { ...reviewChecks()[1], status: 'unverified', evidence: 'Real runtime has not been exercised.' }];
  const incomplete = (await f.call('record_review', { job, review_id: 'review-1', checks: unverified })).structuredContent;
  assert.equal(incomplete.quality.acceptanceStatus, 'incomplete');
  assert.equal(incomplete.status, 'ready_for_review', 'execution and acceptance remain separate');
  const failed = [reviewChecks()[0], { ...reviewChecks()[1], status: 'failed', evidence: 'Synthetic scenario failed; api_key=synthetic-do-not-save' }];
  const rejected = (await f.call('record_review', { job, review_id: 'review-2', checks: failed })).structuredContent;
  assert.equal(rejected.quality.acceptanceStatus, 'changes_requested');
  assert.ok(!JSON.stringify(rejected).includes('synthetic-do-not-save'));
  const concurrent = await Promise.all([1, 2].map(() => f.call('record_review', { job, review_id: 'review-3', checks: reviewChecks() })));
  assert.ok(concurrent.every(r => !r.isError));
  assert.equal(concurrent.filter(r => r.structuredContent.reused).length, 1);
  const accepted = concurrent[0].structuredContent;
  assert.equal(accepted.quality.acceptanceStatus, 'accepted');
  assert.equal(accepted.recordedReview.host, 'claude');
  const retry = (await f.call('record_review', { job, review_id: 'review-1', checks: unverified })).structuredContent;
  assert.equal(retry.reused, true);
  assert.equal(retry.quality.acceptanceStatus, 'accepted', 'old retry does not undo a newer review');
  assert.equal((await f.call('record_review', { job, review_id: 'review-3', checks: failed })).isError, true);
  assert.equal(fs.readdirSync(path.join(job, 'reviews')).length, 3);
  assert.equal(fs.statSync(path.join(job, 'review.json')).mode & 0o777, 0o600);
  const result = (await f.call('task_result', { job })).structuredContent;
  assert.equal(result.review.checks.length, 2);
  assert.equal(f.requestLog().length, before);
  fs.appendFileSync(path.join(job, 'result.md'), '\nChanged saved result.');
  const stale = (await f.call('task_status', { job })).structuredContent;
  assert.equal(stale.quality.acceptanceStatus, 'stale');
});

test('a runtime effort mismatch becomes needs_attention rather than an apparently successful result', async t => {
  const f = fixture(t);
  const job = (await f.dispatch()).structuredContent.job;
  await f.call('task_status', { job, wait_seconds: 3 });
  const file = path.join(job, 'adapter-result.json'), result = JSON.parse(fs.readFileSync(file));
  result.effortEvidence.runtimeConfirmed = 'low';
  fs.writeFileSync(file, JSON.stringify(result));
  const recovered = (await f.call('recover_result', { job })).structuredContent;
  assert.equal(recovered.status, 'needs_attention');
  assert.match(recovered.error, /different reasoning effort/);
});

test('legacy, running, errored and wrong-host jobs cannot be falsely accepted', async t => {
  const f = fixture(t);
  const legacy = (await f.dispatch()).structuredContent.job;
  const old = (await f.call('task_status', { job: legacy, wait_seconds: 3 })).structuredContent;
  assert.equal(old.quality.acceptanceStatus, 'unstructured');
  assert.equal((await f.call('record_review', { job: legacy, review_id: 'legacy', checks: reviewChecks() })).isError, true);
  const job = (await f.dispatch({ task_contract: qualityContract() })).structuredContent.job;
  await f.call('task_status', { job, wait_seconds: 3 });
  const file = path.join(job, 'state.json'), state = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...state, status: 'needs_attention' }));
  assert.equal((await f.call('record_review', { job, review_id: 'errored', checks: reviewChecks() })).isError, true);
  fs.writeFileSync(file, JSON.stringify({ ...state, host: 'zcode' }));
  const wrongHost = await f.call('record_review', { job, review_id: 'wrong-host', checks: reviewChecks() });
  assert.equal(wrongHost.isError, true); assert.match(wrongHost.content[0].text, /dispatching host/);
  fs.writeFileSync(file, JSON.stringify(state));
  const live = (await f.dispatch({ task: 'PROGRESS_TEST', task_contract: qualityContract() })).structuredContent.job;
  const blocked = await f.call('record_review', { job: live, review_id: 'running', checks: reviewChecks() });
  assert.equal(blocked.isError, true); assert.match(blocked.content[0].text, /ended job/);
});

test('rework preserves criteria and passes only remaining host feedback into explicit continuations', async t => {
  const f = fixture(t), contract = qualityContract();
  let previous = (await f.dispatch({ task_contract: contract, request_id: 'quality-original' })).structuredContent;
  await f.call('task_status', { job: previous.job, wait_seconds: 3 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    const checks = [reviewChecks()[0], { ...reviewChecks()[1], status: 'failed', evidence: 'HOST_REWORK_SCENARIO_FAILED' }];
    await f.call('record_review', { job: previous.job, review_id: 'failed-' + attempt, checks });
    const selected = { ...f.args, task: 'Fix only the failed synthetic scenario and preserve passing behavior.', task_contract: contract };
    const prepared = (await f.call('prepare_dispatch', selected)).structuredContent;
    const continued = await f.call('continue_task', { ...selected, job: previous.job,
      prepared_ref: prepared.preparedRef, endpoint: prepared.destination.endpoint, request_id: 'quality-rework-' + attempt });
    assert.equal(continued.isError, false, continued.content[0].text);
    previous = continued.structuredContent; f.jobs.push(previous.job);
    const done = (await f.call('task_status', { job: previous.job, wait_seconds: 3 })).structuredContent;
    assert.equal(done.quality.reworkCount, attempt);
    assert.equal(done.quality.acceptanceStatus, 'pending');
    const state = JSON.parse(fs.readFileSync(path.join(previous.job, 'state.json')));
    assert.deepEqual(state.taskContract, contract);
    assert.equal(state.resume.reviewFeedback.length, 1);
    assert.equal(state.resume.reviewFeedback[0].criterion_id, 'runtime');
    assert.match(fs.readFileSync(path.join(previous.job, 'prompt.md'), 'utf8'), /HOST_REWORK_SCENARIO_FAILED/);
    if (attempt === 2) assert.ok(done.quality.warnings.some(w => w.startsWith('repeated_rework')));
  }
  const changed = { ...f.args, task: 'Drop a criterion.', task_contract: { ...contract, acceptance_criteria: contract.acceptance_criteria.slice(0, 1) } };
  const prepared = (await f.call('prepare_dispatch', changed)).structuredContent;
  const refused = await f.call('continue_task', { ...changed, job: previous.job,
    prepared_ref: prepared.preparedRef, endpoint: prepared.destination.endpoint, request_id: 'quality-loosen' });
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /preserve the original task_contract/);
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 3);
});

test('malformed task contracts are refused before preparation and worker startup', async t => {
  const f = fixture(t);
  for (const task_contract of [{}, { ...qualityContract(), allowed_edits: ['new-file'] },
    { ...qualityContract(), acceptance_criteria: [] }, { ...qualityContract(), unknown: true }]) {
    const r = await f.dispatch({ task_contract }); assert.equal(r.isError, true);
  }
  assert.equal(fs.existsSync(path.join(f.root, '.ai')), false);
  assert.equal(f.requestLog().length, 0);
});
function fixture(t, { logsInMetadata = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-mcp-'));
  const logRelative = logsInMetadata ? '.ai/rpc.jsonl' : 'rpc.jsonl';
  const entry = path.join(root, 'fake-app-server.mjs');
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', config: { api: { baseUrl: 'http://127.0.0.1:9000' } } }] } } }));
  fs.writeFileSync(entry, `import fs from 'node:fs'; import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let selection;
const models=['GLM-5.3','GLM-5.3-Flash'].map(modelId=>({ref:{providerId:'fixture',modelId},providerLabel:'Synthetic',reasoning:{levels:['low','high','max'].map(value=>({value}))}}));
const snapshot=()=>({session:{sessionId:'sess_fake',status:'idle'},settings:{model:{current:selection||models[0].ref,available:models}},projection:{status:'idle'},messages:[{info:{role:'assistant'},parts:[{type:'text',text:'Synthetic result for '+selection?.modelId}]}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);const logPath=new URL(${JSON.stringify(logRelative)},import.meta.url);fs.mkdirSync(new URL('.',logPath),{recursive:true});fs.appendFileSync(logPath,JSON.stringify(m)+'\\n');
 if(m.method==='session/create')send({id:m.id,result:snapshot()});
 else if(m.method==='session/resume')send({id:m.id,result:snapshot()});
 else if(m.method==='session/setModel'){selection=m.params.model;send({id:m.id,result:snapshot()});}
 else if(m.method==='session/subscribe')send(fs.existsSync('unsupported-subscription') ? {id:m.id,error:{code:-32601,message:'Method not found'}} : {id:m.id,result:{sessionId:'sess_fake',eventSeq:0,events:[]}});
 else if(m.method==='session/send'){
  send({id:m.id,result:{accepted:true}});
  const card=fs.readFileSync(m.params.content.match(/Read the task card at (.+\\/task\\.md)\\. Read/)[1],'utf8');
  const edit=card.match(/PARALLEL_EDIT (src\\/[a-z-]+\\.txt)/);
  if(edit){
   fs.writeFileSync(edit[1],'completed '+edit[1]+'\\n');
   const timer=setInterval(()=>{if(fs.existsSync(new URL('.ai/parallel-release',import.meta.url))){clearInterval(timer);send({method:'state.updated',params:{sessionId:'sess_fake',reason:'prompt_completed'}});}},50);
  }else if(card.includes('PROGRESS_TEST')){
   let seq=0;
   const event=(type,payload)=>send({method:'session/event',params:{sessionId:'sess_fake',eventId:'ev_'+seq,seq:++seq,type,payload,timestamp:Date.now()}});
   send({method:'state.updated',params:{sessionId:'sess_fake',reason:'prompt_started'}});
   event('tool.updated',{kind:'scheduled',toolCallId:'read1',toolName:'Read',input:'PRIVATE_INPUT_MUST_NOT_LEAK'});
   event('tool.updated',{kind:'started',toolCallId:'read1'});
   event('tool.updated',{kind:'result',toolCallId:'read1',result:{success:true,content:'PRIVATE_RESULT_MUST_NOT_LEAK'},duration:12});
   event('tool.updated',{kind:'started',toolCallId:'bash1',toolName:'Bash'});
   setInterval(()=>{
    if(fs.existsSync('pause-events'))return;
    event('model.streaming',{kind:'reasoning_delta',delta:'PRIVATE_REASONING_MUST_NOT_LEAK'});
    event('tool.updated',{kind:'progress',toolCallId:'bash1',elapsedMs:seq*200,stdoutBytes:seq*10,stdoutTail:'PRIVATE_STDOUT_MUST_NOT_LEAK'});
   },200);
  }else setTimeout(()=>send({method:'state.updated',params:{sessionId:'sess_fake',reason:'prompt_completed'}}),20);
 }
 else if(m.method==='session/read')send({id:m.id,result:snapshot()});
 else if(m.method==='session/usage')send({id:m.id,result:{inputTokens:80,outputTokens:8}});
 else if(m.method==='session/close')send({id:m.id,result:{closed:true}});
});`);
  const child = spawn(process.execPath, [server], { env: { ...process.env, AGENT_BRIDGE_HOST: 'claude', ZCODE_WORKER_ENTRY: entry, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config }, stdio: ['pipe', 'pipe', 'pipe'] });
  let next = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const m = JSON.parse(line); const p = pending.get(m.id);
    if (p) { clearTimeout(p.timer); pending.delete(m.id); p.resolve(m); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP call timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  const jobs = [];
  t.after(async () => {
    for (const job of jobs) await call('cancel_task', { job });
    for (const p of pending.values()) clearTimeout(p.timer);
    lines.close(); child.stdin.end(); child.kill();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const requestLog = () => fs.existsSync(path.join(root, logRelative)) ? fs.readFileSync(path.join(root, logRelative), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const args = { worker: 'zcode', project: root, task: 'Read this synthetic fixture only.', read_scope: [], provider: 'fixture', model: 'GLM-5.3-Flash', effort: 'high', selection_reason: 'Synthetic task tests explicit agent model and effort selection.', mode: 'plan', timeout_seconds: 10 };
  const dispatch = async overrides => {
    const selection = { ...args, ...overrides };
    const { request_id, ...preview } = selection;
    const prepared = await call('prepare_dispatch', preview);
    if (prepared.isError) return prepared;
    const r = await call('dispatch_task', { ...selection, prepared_ref: prepared.structuredContent.preparedRef, endpoint: prepared.structuredContent.destination.endpoint });
    if (r.structuredContent?.job) jobs.push(r.structuredContent.job);
    return r;
  };
  return { root, rpc, call, requestLog, dispatch, args, config, jobs };
}

test('parallel MCP loop runs host and two workers, reviews host artifact and accepts the integrated version', async t => {
  const f = fixture(t, { logsInMetadata: true }), project = fs.realpathSync(f.root);
  const git = args => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  git(['init', '--quiet']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  fs.mkdirSync(path.join(project, 'src'));
  for (const name of ['host', 'worker-a', 'worker-b']) fs.writeFileSync(path.join(project, 'src', name + '.txt'), 'before\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.ai/\nfake-app-server.mjs\nproviders.json\n');
  git(['add', 'src', '.gitignore']); git(['commit', '--quiet', '-m', 'initial']);
  const head = git(['rev-parse', 'HEAD']);
  const call = async (name, args) => { const r = await f.call(name, args); assert.equal(r.isError, false, r.content?.[0]?.text); return r.structuredContent; };
  const initial = await call('prepare_dispatch', { ...f.args, project });
  const selection = { worker: 'zcode', provider: 'fixture', model: 'GLM-5.3-Flash', effort: 'high', endpoint: initial.destination.endpoint };
  const created = await call('create_parallel_goal', { project, goal_id: 'parallel-mcp', objective: 'Complete three isolated fixture changes.',
    context: 'Synthetic fixture only.', read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: qualityContract().acceptance_criteria,
    participants: [{ id: 'host', kind: 'host' }, ...['worker-a', 'worker-b'].map(id => ({ id, kind: 'worker', ...selection, mode: 'edit' })),
      { id: 'reviewer', kind: 'worker', ...selection, mode: 'plan' }],
    limits: { max_steps: 8, max_reworks: 2, max_no_progress: 3, max_parallel_total: 3, max_parallel_workers: 2 } });
  const goal = created.goal;
  const tasks = ['host', 'worker-a', 'worker-b', 'review'].map(id => ({
    id, kind: id === 'review' ? 'review' : 'implement', depends_on: [], mode: id === 'review' ? 'plan' : 'edit',
    read_scope: ['src'], task_contract: { ...qualityContract(), preserve: ['Keep other fixture files unchanged.'], allowed_edits: id === 'review' ? [] : ['src/' + id + '.txt'] },
    ...(id === 'review' ? { review_of: 'host' } : {}),
  }));
  await call('plan_goal_tasks', { goal, operation_id: 'plan', plan_version: 0, tasks });
  const claims = {};
  const owned = (id, operation_id) => ({ goal, operation_id, task_id: id, attempt_id: claims[id].attempt_id,
    owner_session_id: claims[id].owner_session_id, lease_token: claims[id].lease_token });
  const claim = async (id, participant_id = id) => {
    claims[id] = await call('claim_goal_task', { goal, operation_id: 'claim-' + id, task_id: id, participant_id, owner_session_id: 'mcp-session' });
    return claims[id];
  };
  const startWorker = async id => {
    const c = claims[id];
    const chosen = { ...f.args, project: c.workspace.path, mode: c.mode, read_scope: c.read_scope, task_contract: c.task_contract,
      task: id === 'review' ? 'Inspect the submitted host source. ' + c.review_context : 'PARALLEL_EDIT src/' + id + '.txt' };
    const preflight = await call('prepare_dispatch', chosen);
    const started = await call('start_goal_task', { ...owned(id, 'start-' + id), execution: { ...chosen, endpoint: preflight.destination.endpoint, prepared_ref: preflight.preparedRef } });
    const job = started.attempts.find(a => a.id === c.attempt_id).job; f.jobs.push(job); return job;
  };
  await claim('host'); await call('start_goal_task', owned('host', 'start-host'));
  await claim('worker-a'); await claim('worker-b');
  assert.equal(new Set(Object.values(claims).map(c => c.workspace.path)).size, 3);
  const jobs = await Promise.all(['worker-a', 'worker-b'].map(startWorker));
  const running = await call('goal_status', { goal });
  assert.equal(running.capacity.total, 3); assert.equal(running.capacity.workers, 2);
  assert.ok(running.attempts.every(a => a.status === 'running'));
  fs.writeFileSync(path.join(claims.host.workspace.path, 'src/host.txt'), 'completed src/host.txt\n');
  fs.writeFileSync(path.join(project, '.ai/parallel-release'), 'release');
  const submitted = {};
  for (let i = 0; i < jobs.length; i++) {
    const id = ['worker-a', 'worker-b'][i], job = jobs[i];
    const done = await call('task_status', { job, wait_seconds: 3 }); assert.equal(done.status, 'ready_for_review');
    assert.equal(fs.readFileSync(path.join(claims[id].workspace.path, 'src/' + id + '.txt'), 'utf8'), 'completed src/' + id + '.txt\n');
    await call('record_review', { job, review_id: 'worker-reviewed', checks: reviewChecks() });
    submitted[id] = await call('submit_goal_task', { ...owned(id, 'submit-' + id), summary: 'Verified fixture modification.' });
  }
  submitted.host = await call('submit_goal_task', { ...owned('host', 'submit-host'), summary: 'Host fixture modification.' });
  const fingerprint = id => submitted[id].attempts.find(a => a.id === claims[id].attempt_id).artifact.fingerprint;
  const review = (id, reviewer_task_id) => call('review_goal_task', { goal, operation_id: 'review-' + id, task_id: id, attempt_id: claims[id].attempt_id,
    artifact_fingerprint: fingerprint(id), checks: reviewChecks(), ...(reviewer_task_id ? { reviewer_task_id } : {}) });
  const premature = await f.call('review_goal_task', { goal, operation_id: 'host-self-review', task_id: 'host', attempt_id: claims.host.attempt_id,
    artifact_fingerprint: fingerprint('host'), checks: reviewChecks() });
  assert.equal(premature.isError, true); assert.match(premature.content[0].text, /independent worker review/);
  for (const id of ['worker-a', 'worker-b']) { await review(id); await call('integrate_goal_task', owned(id, 'integrate-' + id)); }
  const reviewer = await claim('review', 'reviewer');
  for (const id of ['host', 'worker-a', 'worker-b']) assert.equal(fs.readFileSync(path.join(reviewer.workspace.path, 'src/' + id + '.txt'), 'utf8'), 'completed src/' + id + '.txt\n');
  const reviewerJob = await startWorker('review');
  assert.equal((await call('task_status', { job: reviewerJob, wait_seconds: 3 })).status, 'ready_for_review');
  await call('record_review', { job: reviewerJob, review_id: 'independent-review-checked', checks: reviewChecks() });
  submitted.review = await call('submit_goal_task', { ...owned('review', 'submit-review'), summary: 'Inspected the exact host artifact and seeded integrated changes.' });
  await review('review'); await call('integrate_goal_task', owned('review', 'integrate-review'));
  await review('host', 'review'); await call('integrate_goal_task', owned('host', 'integrate-host'));
  for (const id of ['host', 'worker-a', 'worker-b']) assert.equal(fs.readFileSync(path.join(project, 'src/' + id + '.txt'), 'utf8'), 'completed src/' + id + '.txt\n');
  const status = await call('goal_status', { goal });
  const final = await call('record_goal_review', { goal, review_id: 'all-integrated', snapshot_fingerprint: status.snapshot_fingerprint, checks: reviewChecks() });
  assert.equal(final.status, 'completed'); assert.ok(final.tasks.every(t => t.status === 'integrated'));
  assert.equal(final.capacity.total, 0); assert.equal(final.budget.used.steps, 4);
  assert.equal(git(['rev-parse', 'HEAD']), head); assert.equal(git(['diff', '--cached', '--name-only']), '');
  assert.equal(f.requestLog().filter(r => r.method === 'session/send').length, 3);
});

test('MCP initialization, discovery and model catalog do not invoke inference', async t => {
  const f = fixture(t);
  const init = await f.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await f.rpc('tools/list', {});
  assert.ok(list.result.tools.some(x => x.name === 'list_workers'));
  assert.match(init.result.instructions, /claude host agent/);
  assert.ok(list.result.tools.some(x => x.name === 'prepare_dispatch'));
  assert.deepEqual(list.result.tools.find(x => x.name === 'dispatch_task').inputSchema.required.slice(-2), ['prepared_ref', 'endpoint']);
  const models = await f.call('list_models', { worker: 'zcode', project: f.root });
  assert.equal(models.isError, false);
  assert.equal(models.structuredContent.models[1].model, 'GLM-5.3-Flash');
  assert.deepEqual(models.structuredContent.models[1].reasoning_levels, ['low', 'high', 'max']);
  const log = f.requestLog();
  assert.equal(log.filter(x => x.method === 'session/send').length, 0);
  assert.equal(log.filter(x => x.method === 'session/setModel').length, 0);
  assert.equal(log.filter(x => x.method === 'session/close').length, 1);
  assert.equal(fs.existsSync(path.join(f.root, '.ai')), false);
});

test('MCP requires agent selection before dispatch, including reason and bounded arguments', async t => {
  const f = fixture(t);
  for (const key of ['worker', 'provider', 'model', 'effort', 'selection_reason']) {
    const args = { ...f.args }; delete args[key];
    const r = await f.call('dispatch_task', args);
    assert.equal(r.isError, true); assert.match(r.content[0].text, new RegExp(key));
  }
  assert.equal((await f.dispatch({ model: ' ' })).isError, true);
  assert.equal((await f.dispatch({ worker: 'unknown' })).isError, true);
  assert.equal((await f.dispatch({ mode: 'yolo' })).isError, true);
  assert.equal((await f.dispatch({ unexpected: true })).isError, true);
  assert.equal((await f.dispatch({ task: 'a'.repeat(24001) })).isError, true);
  assert.equal((await f.dispatch({ project: './relative' })).isError, true);
  assert.equal((await f.call('dispatch_task', { ...f.args, request_id: '../bad', prepared_ref: '0'.repeat(32), endpoint: 'http://127.0.0.1:9000' })).isError, true);
  assert.equal(fs.existsSync(path.join(f.root, '.ai')), false);
  assert.equal(f.requestLog().length, 0);
});

test('MCP repeats return the original request and invoke the model once', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.dispatch({ request_id: 'mcp-repeat-001' }), f.dispatch({ request_id: 'mcp-repeat-001' })]);
  assert.ok(results.every(r => !r.isError), JSON.stringify(results));
  const [first, second] = results.map(r => r.structuredContent);
  assert.equal(first.job, second.job);
  assert.equal(results.filter(r => r.structuredContent.reused).length, 1);
  const done = await f.call('task_status', { job: first.job, wait_seconds: 3 });
  assert.equal(done.structuredContent.status, 'ready_for_review');
  assert.equal((await f.dispatch({ request_id: 'mcp-repeat-001' })).structuredContent.reused, true);
  assert.equal((await f.dispatch({ request_id: 'mcp-repeat-001', model: 'GLM-5.3' })).isError, true);
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 1);
});

test('MCP dispatch uses non-default model and effort; result records choice and reads locally', async t => {
  const f = fixture(t);
  const submitted = await f.dispatch();
  assert.equal(submitted.isError, false);
  const job = submitted.structuredContent.job;
  const status = await f.call('task_status', { job, wait_seconds: 3 });
  assert.equal(status.structuredContent.status, 'ready_for_review');
  const before = f.requestLog().length;
  const r = (await f.call('task_result', { job })).structuredContent;
  assert.equal(r.model, 'GLM-5.3-Flash'); assert.equal(r.effort, 'high');
  assert.equal(r.provider, 'fixture'); assert.equal(r.selectionReason, f.args.selection_reason);
  assert.equal(r.selectedModel.options.reasoningLevel, 'high');
  assert.match(r.summary, /GLM-5.3-Flash/);
  assert.deepEqual(r.usage, { inputTokens: 80, outputTokens: 8 });
  assert.equal(f.requestLog().length, before);
  const set = f.requestLog().find(x => x.method === 'session/setModel').params;
  assert.deepEqual(set.model, { providerId: 'fixture', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } });
  assert.equal(set.persistAsWorkspaceLastUsed, false);
});

test('MCP exposes live tools and reasoning; idle time survives heartbeats, local reads and cancellation', async t => {
  const f = fixture(t);
  const job = (await f.dispatch({ task: 'PROGRESS_TEST synthetic activity only.' })).structuredContent.job;
  const live = (await f.call('task_status', { job, wait_seconds: 2 })).structuredContent;
  assert.equal(live.status, 'running'); assert.equal(live.sessionId, 'sess_fake');
  assert.equal(live.selectedModel.modelId, f.args.model);
  assert.equal(live.progress.monitoring, 'subscribed');
  assert.ok(live.progress.reasoningCharacters > 0);
  assert.equal(live.progress.tools.completed, 1); assert.equal(live.progress.tools.active, 1);
  assert.equal(live.progress.tools.current[0].name, 'Bash');
  assert.ok(live.progress.tools.current[0].stdoutBytes > 0);
  assert.ok(!JSON.stringify(live).includes('PRIVATE_'));
  assert.ok(!fs.readFileSync(path.join(job, 'progress.json'), 'utf8').includes('PRIVATE_'));
  assert.ok(!fs.readFileSync(path.join(job, 'protocol-events.jsonl'), 'utf8').includes('PRIVATE_'));
  fs.writeFileSync(path.join(f.root, 'pause-events'), 'pause');
  const paused = (await f.call('task_status', { job, wait_seconds: 1 })).structuredContent;
  const heartbeat = JSON.parse(fs.readFileSync(path.join(job, 'state.json'))).updatedAt;
  const before = f.requestLog().length;
  const idle = (await f.call('task_status', { job, wait_seconds: 2 })).structuredContent;
  assert.equal(idle.status, 'running');
  assert.equal(idle.progress.lastActivityAt, paused.progress.lastActivityAt);
  assert.ok(idle.progress.idleSeconds >= 2);
  assert.ok(JSON.parse(fs.readFileSync(path.join(job, 'state.json'))).updatedAt > heartbeat);
  assert.equal(f.requestLog().length, before, 'task_status must not request new inference or session snapshots');
  const stopped = (await f.call('cancel_task', { job })).structuredContent;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.progress.tools.completed, 1);
  assert.equal(stopped.progress.lastActivityAt, idle.progress.lastActivityAt);
});

test('older app-server without subscription reports unavailable monitoring and preserves result handling', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'unsupported-subscription'), 'unsupported');
  const job = (await f.dispatch()).structuredContent.job;
  const done = (await f.call('task_status', { job, wait_seconds: 3 })).structuredContent;
  assert.equal(done.status, 'ready_for_review');
  assert.equal(done.progress.monitoring, 'unsupported');
  assert.equal(done.progress.tools.total, 0);
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 1);
});

test('unavailable model/provider/effort fails without inference or silent fallback', async t => {
  const f = fixture(t);
  for (const override of [{ model: 'missing' }, { provider: 'missing' }, { effort: 'unsupported' }]) {
    const s = await f.dispatch(override);
    if (override.provider) { assert.equal(s.isError, true); continue; }
    assert.equal(s.isError, false);
    const result = await f.call('task_status', { job: s.structuredContent.job, wait_seconds: 3 });
    assert.equal(result.structuredContent.status, 'failed');
  }
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 0);
  assert.equal(f.requestLog().filter(x => x.method === 'session/close').length, 2);
});

test('preflight sends no inference and rejects changed destination, task, scope and expired references', async t => {
  const f = fixture(t);
  assert.equal((await f.call('dispatch_task', f.args)).isError, true);
  const prepared = (await f.call('prepare_dispatch', f.args)).structuredContent;
  assert.equal(prepared.host, 'claude');
  assert.equal(prepared.inferenceDispatched, false);
  assert.equal(prepared.destination.endpoint, 'http://127.0.0.1:9000');
  assert.equal(f.requestLog().length, 0);
  const request = { ...f.args, prepared_ref: prepared.preparedRef, endpoint: prepared.destination.endpoint };
  for (const change of [{ task: 'changed' }, { read_scope: ['.'] }, { endpoint: 'https://example.com' }, { effort: 'low' }, { read_scope: ['../'] }]) {
    assert.equal((await f.call('dispatch_task', { ...request, ...change })).isError, true);
  }
  const config = JSON.parse(fs.readFileSync(f.config));
  config.config.providerConfigRules.providerRules[0].config.api.baseUrl = 'http://127.0.0.1:9001';
  fs.writeFileSync(f.config, JSON.stringify(config));
  assert.match((await f.call('dispatch_task', request)).content[0].text, /destination changed/);
  config.config.providerConfigRules.providerRules[0].config.api.baseUrl = request.endpoint;
  fs.writeFileSync(f.config, JSON.stringify(config));
  const file = path.join(f.root, '.ai/preparations', request.prepared_ref + '.json');
  const record = JSON.parse(fs.readFileSync(file)); record.expiresAt = 0; fs.writeFileSync(file, JSON.stringify(record));
  assert.match((await f.call('dispatch_task', request)).content[0].text, /expired/);
  assert.equal(fs.existsSync(path.join(f.root, '.ai/tasks')), false);
  assert.equal(f.requestLog().length, 0);
});

test('MCP continue_task re-preflights and resumes natively after an ended job', async t => {
  const f = fixture(t);
  const first = (await f.dispatch({ request_id: 'mcp-cont-001' })).structuredContent;
  assert.equal((await f.call('task_status', { job: first.job, wait_seconds: 5 })).structuredContent.status, 'ready_for_review');
  const prepared = await f.call('prepare_dispatch', { ...f.args, task: 'Continue the synthetic fixture work only.' });
  const continuation = { ...f.args, task: 'Continue the synthetic fixture work only.', job: first.job,
    prepared_ref: prepared.structuredContent.preparedRef, endpoint: prepared.structuredContent.destination.endpoint, request_id: 'mcp-cont-002' };
  for (const broken of [{ request_id: '../bad' }, { job: '/relative/path' }, { prepared_ref: '0'.repeat(31) }]) {
    assert.equal((await f.call('continue_task', { ...continuation, ...broken })).isError, true);
  }
  const continued = await f.call('continue_task', continuation);
  assert.equal(continued.isError, false, continued.content[0].text);
  const r = continued.structuredContent;
  f.jobs.push(r.job);
  assert.equal(r.reused, false); assert.equal(r.resumeMode, 'native');
  assert.equal(r.continuation.of, first.id);
  assert.equal(r.continuation.previousSessionId, 'sess_fake');
  const finished = await f.call('task_status', { job: r.job, wait_seconds: 5 });
  assert.equal(finished.structuredContent.status, 'ready_for_review');
  assert.ok(f.requestLog().some(x => x.method === 'session/resume'), 'native resume used the recorded session');
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 2, 'one turn per dispatched task');
  // Lost replies can be retried without starting another turn.
  const replay = await f.call('continue_task', continuation);
  assert.equal(replay.isError, false);
  assert.equal(replay.structuredContent.reused, true);
  assert.equal(replay.structuredContent.job, r.job);
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 2);
});

test('scope symlink retargeting is blocked but replay of an existing job needs no surviving source file', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'first')); fs.mkdirSync(path.join(f.root, 'second'));
  fs.symlinkSync('first', path.join(f.root, 'source'));
  const scoped = { ...f.args, read_scope: ['source'] };
  const preparation = (await f.call('prepare_dispatch', scoped)).structuredContent;
  const request = { ...scoped, prepared_ref: preparation.preparedRef, endpoint: preparation.destination.endpoint, request_id: 'scope-replay' };
  fs.unlinkSync(path.join(f.root, 'source')); fs.symlinkSync('second', path.join(f.root, 'source'));
  assert.match((await f.call('dispatch_task', request)).content[0].text, /targets changed/);
  fs.unlinkSync(path.join(f.root, 'source')); fs.symlinkSync('first', path.join(f.root, 'source'));
  const submitted = (await f.call('dispatch_task', request)).structuredContent;
  assert.ok(submitted.job);
  assert.equal((await f.call('task_status', { job: submitted.job, wait_seconds: 3 })).structuredContent.status, 'ready_for_review');
  fs.unlinkSync(path.join(f.root, 'source'));
  const repeated = (await f.call('dispatch_task', request)).structuredContent;
  assert.equal(repeated.reused, true); assert.equal(repeated.job, submitted.job);
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 1);
});
test('MCP goal loop relays two participants, resumes rework and binds final acceptance to source', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'before');
  const criteria = [{ id: 'overall', description: 'The complete fixture meets the goal.', verification: 'Host checks fixture contents.', verification_kind: 'source' }];
  const contract = { complexity: 'standard', context: 'Synthetic goal fixture.', allowed_edits: [], preserve: [],
    integration: 'Host validates the complete fixture.', acceptance_criteria: criteria };
  const participants = ['implementer', 'reviewer'].map(id => ({ id, worker: f.args.worker, provider: f.args.provider,
    model: f.args.model, effort: f.args.effort, endpoint: 'http://127.0.0.1:9000', mode: 'plan' }));
  const call = async (name, args) => {
    const r = await f.call(name, args);
    assert.equal(r.isError, false, r.content?.[0]?.text);
    return r.structuredContent;
  };
  const made = await call('create_goal', { project: f.root, goal_id: 'integration-goal', objective: 'Verify serial cooperation.',
    context: 'Implement, review, rework, verify.', read_scope: ['src'], allowed_edits: ['src'], acceptance_criteria: criteria,
    participants, limits: { max_steps: 4, max_reworks: 2, max_no_progress: 3 } });
  const goal = made.goal;
  assert.ok(path.isAbsolute(goal));
  const runStep = async (operation_id, participant_id, task, previousJob) => {
    const selected = { ...f.args, task, read_scope: ['src'], task_contract: contract };
    const p = await call('prepare_dispatch', selected);
    const execution = { ...selected, prepared_ref: p.preparedRef, endpoint: p.destination.endpoint,
      ...(previousJob ? { job: previousJob } : {}) };
    const advanced = await call('advance_goal', { goal, operation_id, action: previousJob ? 'continue' : 'dispatch', participant_id, execution });
    const job = advanced.steps.at(-1).job;
    assert.ok(job, 'a new linked job was launched'); f.jobs.push(job);
    await call('task_status', { job, wait_seconds: 3 });
    const repeated = await call('advance_goal', { goal, operation_id, action: previousJob ? 'continue' : 'dispatch', participant_id, execution });
    assert.ok(repeated);
    return job;
  };
  const verifyTask = (job, id) => call('record_review', { job, review_id: id, checks: [
    { criterion_id: 'overall', status: 'passed', verification_kind: 'source', evidence: 'Host inspected the synthetic worker result.' },
  ] });
  const first = await runStep('implement-1', 'implementer', 'Read the bounded fixture and propose a fix.');
  await verifyTask(first, 'impl-accepted');
  await call('send_goal_message', { goal, message_id: 'handoff', to: 'reviewer', type: 'question',
    body: 'Inspect the proposal against the goal.', source_job: first, artifact_refs: ['src/value.txt'] });
  const inbox = await call('read_goal_messages', { goal, recipient: 'reviewer' });
  assert.match(JSON.stringify(inbox), /Inspect the proposal/);
  const reviewer = await runStep('review-1', 'reviewer', 'Review the fixture. Handoff: Inspect the proposal against the goal.');
  await verifyTask(reviewer, 'review-accepted');
  await call('send_goal_message', { goal, message_id: 'feedback', to: 'implementer', type: 'review',
    body: 'The fixture needs the corrected contents.', reply_to: 'handoff', source_job: reviewer });
  const status = await call('goal_status', { goal });
  await call('record_goal_review', { goal, review_id: 'overall-failed', snapshot_fingerprint: status.snapshot_fingerprint,
    checks: [{ criterion_id: 'overall', status: 'failed', verification_kind: 'source', evidence: 'Fixture still contains before.' }] });
  const rework = await runStep('rework-1', 'implementer', 'Address only the review feedback and preserve passing behavior.', first);
  await verifyTask(rework, 'rework-accepted');
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'after!');
  const finalVersion = await call('goal_status', { goal });
  const completed = await call('record_goal_review', { goal, review_id: 'overall-pass', snapshot_fingerprint: finalVersion.snapshot_fingerprint,
    checks: [{ criterion_id: 'overall', status: 'passed', verification_kind: 'source', evidence: 'Host read after! from the actual fixture.' }] });
  assert.equal(completed.status, 'completed');
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 3);
  fs.writeFileSync(path.join(f.root, 'src/value.txt'), 'other!');
  const changed = await call('goal_status', { goal });
  assert.notEqual(changed.status, 'completed');
  assert.notEqual(changed.snapshot_fingerprint, finalVersion.snapshot_fingerprint);
});

test('MCP goal recovers from an expired preparation without replaying a rejected operation', async t => {
  const f = fixture(t), task_contract = qualityContract();
  const selected = { ...f.args, task_contract };
  const call = async (name, args) => {
    const r = await f.call(name, args);
    assert.equal(r.isError, false, r.content?.[0]?.text);
    return r.structuredContent;
  };
  const prepare = () => call('prepare_dispatch', selected);
  const p = await prepare();
  const participant = { id: 'implementer', worker: selected.worker, provider: selected.provider,
    model: selected.model, effort: selected.effort, endpoint: p.destination.endpoint, mode: selected.mode };
  const { goal } = await call('create_goal', { project: f.root, goal_id: 'expired-preflight', objective: 'Recover a rejected execution.',
    context: 'Synthetic recovery fixture.', read_scope: selected.read_scope, allowed_edits: [], acceptance_criteria: task_contract.acceptance_criteria,
    participants: [participant], limits: { max_steps: 3, max_reworks: 1, max_no_progress: 3 } });
  const recordPath = path.join(f.root, '.ai/preparations', p.preparedRef + '.json');
  const record = JSON.parse(fs.readFileSync(recordPath)); record.expiresAt = Date.now() - 1;
  fs.writeFileSync(recordPath, JSON.stringify(record));
  const request = { goal, action: 'dispatch', operation_id: 'expired', participant_id: participant.id,
    execution: { ...selected, prepared_ref: p.preparedRef, endpoint: p.destination.endpoint } };
  const refused = await f.call('advance_goal', request);
  assert.equal(refused.isError, true); assert.match(refused.content[0].text, /expired/);
  const rejected = await call('goal_status', { goal });
  assert.equal(rejected.steps[0].status, 'dispatch_rejected');
  assert.equal((await call('advance_goal', request)).reused, true);
  assert.equal(f.requestLog().length, 0);
  const fresh = await prepare();
  const advanced = await call('advance_goal', { ...request, operation_id: 'fresh',
    execution: { ...request.execution, prepared_ref: fresh.preparedRef } });
  const job = advanced.steps.at(-1).job; f.jobs.push(job);
  await call('task_status', { job, wait_seconds: 3 });
  await call('record_review', { job, review_id: 'accepted', checks: reviewChecks() });
  const status = await call('goal_status', { goal });
  const done = await call('record_goal_review', { goal, review_id: 'done', snapshot_fingerprint: status.snapshot_fingerprint, checks: reviewChecks() });
  assert.equal(done.status, 'completed');
  assert.equal(done.budget.used.steps, 2, 'rejected attempts remain in the cumulative budget');
  assert.equal(f.requestLog().filter(x => x.method === 'session/send').length, 1);
});
