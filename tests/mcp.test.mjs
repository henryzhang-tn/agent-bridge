import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../plugins/agent-bridge/scripts/mcp-server.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-mcp-'));
  const entry = path.join(root, 'fake-app-server.mjs');
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', config: { api: { baseUrl: 'http://127.0.0.1:9000' } } }] } } }));
  fs.writeFileSync(entry, `import fs from 'node:fs'; import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
let selection;
const models=['GLM-5.3','GLM-5.3-Flash'].map(modelId=>({ref:{providerId:'fixture',modelId},providerLabel:'Synthetic',reasoning:{levels:['low','high','max'].map(value=>({value}))}}));
const snapshot=()=>({session:{sessionId:'sess_fake',status:'idle'},settings:{model:{current:selection||models[0].ref,available:models}},projection:{status:'idle'},messages:[{info:{role:'assistant'},parts:[{type:'text',text:'Synthetic result for '+selection?.modelId}]}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);fs.appendFileSync('rpc.jsonl',JSON.stringify(m)+'\\n');
 if(m.method==='session/create')send({id:m.id,result:snapshot()});
 else if(m.method==='session/setModel'){selection=m.params.model;send({id:m.id,result:snapshot()});}
 else if(m.method==='session/subscribe')send(fs.existsSync('unsupported-subscription') ? {id:m.id,error:{code:-32601,message:'Method not found'}} : {id:m.id,result:{sessionId:'sess_fake',eventSeq:0,events:[]}});
 else if(m.method==='session/send'){
  send({id:m.id,result:{accepted:true}});
  const card=fs.readFileSync(m.params.content.match(/Read the task card at (.+\\/task\\.md)\\. Read/)[1],'utf8');
  if(card.includes('PROGRESS_TEST')){
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
  const requestLog = () => fs.existsSync(path.join(root, 'rpc.jsonl')) ? fs.readFileSync(path.join(root, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
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
  return { root, rpc, call, requestLog, dispatch, args, config };
}

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
