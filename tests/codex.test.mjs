import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { routingFromConfig, workerConfigOverrides } from '../plugins/agent-bridge/scripts/codex-config.mjs';

const exec = promisify(execFile);
const bridge = fileURLToPath(new URL('../plugins/agent-bridge/scripts/bridge.mjs', import.meta.url));
const scripts = fileURLToPath(new URL('../plugins/agent-bridge/scripts/', import.meta.url));

test('Codex effective routing supports built-in login modes and rejects unknown destinations', () => {
  assert.equal(routingFromConfig({}, { type: 'chatgpt' }, {}).base, 'https://chatgpt.com/backend-api/codex');
  assert.equal(routingFromConfig({}, { type: 'apiKey' }, {}).base, 'https://api.openai.com/v1');
  assert.equal(routingFromConfig({ chatgpt_base_url: 'https://example.test/backend-api/' }, { type: 'chatgpt' }, {}).base, 'https://example.test/backend-api/codex');
  assert.equal(routingFromConfig({}, { type: 'apiKey' }, { OPENAI_BASE_URL: 'https://example.test/v1' }).base, 'https://example.test/v1');
  assert.throws(() => routingFromConfig({}, null, {}), /Cannot resolve/);
  const overrides = workerConfigOverrides({ mcp_servers: { 'server.with.dots': { command: 'fixture', tool_timeout_sec: null } }, plugins: { 'plugin@market': {} } });
  assert.equal(overrides.mcp_servers['server.with.dots'].enabled, false);
  assert.equal(overrides.mcp_servers['server.with.dots'].command, 'fixture');
  assert.equal(Object.hasOwn(overrides.mcp_servers['server.with.dots'], 'tool_timeout_sec'), false, 'RPC null must not become an invalid TOML string');
  assert.equal(overrides.plugins['plugin@market'].enabled, false);
});

// Synthetic Codex CLI: speaks the app-server JSON-RPC protocol from the local
// CLI's generated schemas. No real Codex, provider or inference is involved.
function fakeCodex(t, root) {
  const entry = path.join(root, 'codex-app-server.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import readline from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x) + '\\n');
const log = x => fs.appendFileSync('rpc.jsonl', JSON.stringify(x) + '\\n');
const models = [{ id: 'gpt-test', model: 'gpt-test', displayName: 'Fixture GPT', description: 'synthetic', hidden: false,
  defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }, { reasoningEffort: 'high', description: 'high' }] }];
let card = null, threadNumber = 0, interrupted = false;
const thread = { id: 'th_fixture_1' };
const readCard = content => (content.match(/Read the task card at (.+\\/task\\.md)\\. Read/) || [])[1];
readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  log(m);
  if (m.id !== undefined && m.method === 'initialize') return send({ id: m.id, result: { codexHome: '/tmp', platformFamily: 'unix', userAgent: 'codex-fixture' } });
  if (m.method === 'initialized') return;
  if (m.method === 'config/read') {
    const text = fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8');
    const provider = (text.match(/model_provider\\s*=\\s*"([^"]+)"/) || [])[1] || 'openai';
    const base = (text.match(/base_url\\s*=\\s*"([^"]+)"/) || [])[1];
    return send({ id: m.id, result: { config: { model_provider: provider, chatgpt_base_url: 'https://chatgpt.com/backend-api/', model_providers: base ? { zhipu: { base_url: base } } : {} } } });
  }
  if (m.method === 'account/read') return send({ id: m.id, result: { account: { type: 'chatgpt' } } });
  if (m.id !== undefined && m.method === 'model/list') return send({ id: m.id, result: { data: models } });
  if (m.id !== undefined && m.method === 'thread/start') {
    threadNumber++;
    return send({ id: m.id, result: { thread: { id: 'th_fixture_' + threadNumber, status: { type: 'idle' }, cwd: m.params.cwd, model: m.params.model, modelProvider: m.params.modelProvider },
      model: m.params.model, modelProvider: m.params.modelProvider, approvalPolicy: m.params.approvalPolicy,
      sandbox: { type: m.params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }, cwd: m.params.cwd, reasoningEffort: 'low' } });
  }
  if (m.id !== undefined && m.method === 'thread/resume') {
    threadNumber++;
    return send({ id: m.id, result: { thread: { id: m.params.threadId, status: { type: 'idle' } },
      model: 'gpt-test', modelProvider: 'zhipu', approvalPolicy: m.params.approvalPolicy,
      sandbox: { type: m.params.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite' }, cwd: m.params.cwd, reasoningEffort: 'low' } });
  }
  if (m.id !== undefined && m.method === 'turn/start') {
    card = fs.readFileSync(readCard(m.params.input[0].text) || '/dev/null', 'utf8');
    send({ id: m.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [] } } });
    const threadId = m.params.threadId;
    send({ method: 'thread/started', params: { thread } });
    function emitTurn(turn) { send({ method: 'turn/completed', params: { threadId, turn } }); }
    if (card.includes('hang')) {
      let seq = 0;
      setInterval(() => { if (fs.existsSync('pause-events')) return;
        send({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'msg1', turnId: 'turn_1', delta: 'PRIVATE_STREAM_MUST_NOT_LEAK' + (seq++) } }); }, 150);
      return;
    }
    send({ method: 'turn/started', params: { threadId, turnId: 'turn_1' } });
    send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: [] } } });
    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId, itemId: 'r1', turnId: 'turn_1', summaryIndex: 0, delta: 'PRIVATE_REASONING' } });
    send({ method: 'item/started', params: { threadId, turnId: 'turn_1', startedAtMs: Date.now(), item: { id: 'cmd1', type: 'commandExecution', status: 'inProgress', command: 'PRIVATE_COMMAND' } } });
    send({ method: 'item/completed', params: { threadId, turnId: 'turn_1', completedAtMs: Date.now(), item: { id: 'cmd1', type: 'commandExecution', status: 'completed' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId, itemId: 'msg1', turnId: 'turn_1', delta: 'Codex fixture result' } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId, turnId: 'turn_1', tokenUsage: { last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningOutputTokens: 1, totalTokens: 12 }, total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 5, reasoningOutputTokens: 8, totalTokens: 150 } } } });
    if (card.includes('BLOCKER')) {
      send({ id: 9001, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'turn_1', itemId: 'cmd1', startedAtMs: Date.now(), command: 'PRIVATE_COMMAND' } });
      send({ method: 'thread/status/changed', params: { threadId, status: { type: 'active', activeFlags: ['waitingOnApproval'] } } });
    }
    emitTurn({ id: 'turn_1', status: 'completed', items: [], startedAt: 1, completedAt: 2, durationMs: 5 });
    return;
  }
  if (m.id !== undefined && m.method === 'thread/read') {
    return send({ id: m.id, result: { thread: { id: m.params.threadId, model: 'gpt-test', modelProvider: 'zhipu', status: { type: 'idle' },
      turns: [{ id: 'older_turn', status: 'completed', items: [{ id: 'old', type: 'agentMessage', text: 'STALE_OLD_RESULT', phase: 'final_answer' }] }, { id: 'turn_1', status: 'completed', items: [{ id: 'msg1', type: 'agentMessage', text: 'Codex fixture result', phase: 'final_answer' }] }] } } });
  }
  if (m.id !== undefined && m.method === 'turn/interrupt') { interrupted = true; return send({ id: m.id, result: {} }); }
  if (m.id !== undefined) return send({ id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
});
process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400)); // stay up briefly so turn/interrupt is observable
`);
  return entry;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-codex-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const codexHome = path.join(root, 'codex-home');
  fs.mkdirSync(codexHome);
  fs.writeFileSync(path.join(codexHome, 'config.toml'),
    'model = "gpt-test"\nmodel_provider = "zhipu"\n\n[model_providers.zhipu]\nname = "Zhipu"\nbase_url = "http://127.0.0.1:9000"\nwire_api = "responses"\n');
  const entry = fakeCodex(t, root);
  const env = { ...process.env, AGENT_BRIDGE_HOST: 'codex', CODEX_WORKER_ENTRY: entry, CODEX_HOME: codexHome };
  const jobs = [];
  const invoke = async (...argv) => {
    try {
      const x = await exec(process.execPath, [bridge, ...argv], { env, cwd: project, timeout: 20000 });
      return { code: 0, ...JSON.parse(x.stdout) };
    } catch (e) {
      if (!e.stdout) throw e;
      return { code: e.code, ...JSON.parse(e.stdout) };
    }
  };
  const selection = (overrides = {}) => {
    const merged = { '--project': project, '--worker': 'codex', '--provider': 'zhipu', '--model': 'gpt-test', '--effort': 'low', '--mode': 'plan', ...overrides };
    return Object.entries(merged).flat();
  };
  const card = content => {
    const file = path.join(root, 'card-' + Math.random().toString(36).slice(2) + '.md');
    fs.writeFileSync(file, content);
    return file;
  };
  const dispatch = async (content, extra = [], requestId = null) => {
    const file = card(content);
    const prepared = await invoke('prepare', '--task-file', file, ...selection(extra));
    if (prepared.code !== 0) return prepared;
    const submitted = await invoke('submit', '--task-file', file, ...selection(extra),
      '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint,
      ...(requestId ? ['--request-id', requestId] : []), '--wait', '2');
    if (submitted.job) jobs.push(submitted.job);
    return submitted;
  };
  const track = job => { if (job && !jobs.includes(job)) jobs.push(job); };
  t.after(async () => {
    for (const job of jobs) { try { await invoke('cancel', '--job', job); } catch {} }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, project, env, invoke, dispatch, selection, card, codexHome, track };
}

test('codex worker is discoverable and its destination comes from config.toml', async t => {
  const f = fixture(t);
  const listed = await f.invoke('workers');
  const codex = listed.workers.find(w => w.worker === 'codex');
  assert.equal(codex.installed, true);
  assert.equal(listed.host, 'codex');
  const catalog = await f.invoke('models', '--worker', 'codex', '--project', f.project);
  assert.equal(catalog.code, 0);
  assert.equal(catalog.provider, 'zhipu');
  assert.deepEqual(catalog.models[0].reasoning_levels, ['low', 'high']);
  const prepared = await f.invoke('prepare', '--task-file', f.card('Synthetic codex preflight'), ...f.selection());
  assert.equal(prepared.inferenceDispatched, false);
  assert.deepEqual(prepared.destination, { provider: 'zhipu', endpoint: 'http://127.0.0.1:9000' });
  // Built-in login routing is resolved locally without an inference call.
  fs.writeFileSync(path.join(f.codexHome, 'config.toml'), 'model = "gpt-test"\n');
  const builtin = await f.invoke('prepare', '--task-file', f.card('builtin provider'),
    '--project', f.project, '--worker', 'codex', '--provider', 'openai', '--model', 'gpt-test', '--effort', 'low', '--mode', 'plan');
  assert.equal(builtin.code, 0, JSON.stringify(builtin));
  assert.equal(builtin.destination.endpoint, 'https://chatgpt.com/backend-api/codex');
  fs.writeFileSync(path.join(f.codexHome, 'config.toml'),
    'model_provider = "other"\n[model_providers.zhipu]\nbase_url = "http://127.0.0.1:9000"\n');
  const mismatch = await f.invoke('prepare', '--task-file', f.card('non-default provider'), ...f.selection());
  assert.equal(mismatch.code, 1);
  assert.match(mismatch.error, /not the active default/);
});

test('codex dispatch runs through the app-server with bound identity, sandbox and approvals', async t => {
  const f = fixture(t);
  const submitted = await f.dispatch('Read the synthetic codex project only.', [], 'codex-run-001');
  assert.equal(submitted.code, 0, JSON.stringify(submitted));
  assert.equal(submitted.worker, 'codex');
  const status = await f.invoke('status', '--job', submitted.job, '--wait', '5');
  assert.equal(status.status, 'ready_for_review', JSON.stringify(status));
  assert.equal(status.sessionId, 'th_fixture_1');
  assert.equal(status.selectedModel.options.reasoningLevel, 'low');
  assert.equal(status.timeBudgetSeconds, null);
  const result = await f.invoke('result', '--job', submitted.job);
  assert.match(result.summary, /Codex fixture result/);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 30, totalTokens: 150, reasoningTokens: 8, cacheReadTokens: 5, lastInputTokens: 10, lastOutputTokens: 2 });
  const rpc = fs.readFileSync(path.join(f.project, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const start = rpc.find(x => x.method === 'thread/start');
  assert.equal(start.params.model, 'gpt-test');
  assert.equal(start.params.modelProvider, 'zhipu');
  assert.equal(start.params.sandbox, 'read-only'); // plan mode
  assert.equal(start.params.approvalPolicy, 'on-request');
  assert.equal(start.params.approvalsReviewer, 'user', 'approval requests are returned to the adapter, never to an autonomous reviewer');
  assert.equal(start.params.cwd, fs.realpathSync(f.project));
  const turn = rpc.find(x => x.method === 'turn/start');
  assert.equal(turn.params.input[0].type, 'text');
  assert.equal(turn.params.effort, 'low');
  assert.equal(rpc.filter(x => x.method === 'turn/start').length, 1, 'exactly one turn');
});

test('codex progress persists phase, tools and activity; blockers are visible and never approved', async t => {
  const f = fixture(t);
  const submitted = await f.dispatch('BLOCKER synthetic codex activity.');
  const status = await f.invoke('status', '--job', submitted.job, '--wait', '5');
  assert.equal(status.status, 'needs_attention', JSON.stringify(status));
  assert.match(status.error, /Host interaction required/);
  const progress = status.progress;
  assert.equal(progress.source, 'codex-app-server');
  assert.equal(progress.monitoring, 'subscribed');
  assert.equal(progress.phase, 'blocked');
  assert.equal(progress.tools.total, 1);
  assert.equal(progress.tools.completed, 1);
  assert.ok(progress.reasoningCharacters > 0);
  const rpc = fs.readFileSync(path.join(f.project, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const approvalResponse = rpc.find(x => x.id === 9001 && x.result);
  assert.ok(approvalResponse, 'adapter answered the approval request');
  assert.equal(approvalResponse.result.decision, 'decline', 'valid v2 denial, never approval');
  for (const file of ['progress.json', 'protocol-events.jsonl']) {
    assert.ok(!fs.readFileSync(path.join(submitted.job, file), 'utf8').includes('PRIVATE_'), file + ' leaked content');
  }
});

test('codex reasoning evidence does not mistake the thread default for the requested turn effort', async t => {
  const f = fixture(t);
  const submitted = await f.dispatch('Inspect only the synthetic fixture.', { '--effort': 'high' });
  const result = await f.invoke('status', '--job', submitted.job, '--wait', '5');
  assert.equal(result.status, 'ready_for_review');
  assert.equal(result.effortEvidence.requested, 'high');
  assert.equal(result.effortEvidence.sentToRuntime, 'high');
  assert.equal(result.effortEvidence.runtimeConfirmed, null, 'thread/start returned low, but the current turn did not confirm an effort');
  assert.equal(result.effortEvidence.providerConfirmed, null);
});

test('codex cancellation interrupts the turn and preserves last observed progress', async t => {
  const f = fixture(t);
  const submitted = await f.dispatch('hang instead of finishing');
  const running = await f.invoke('status', '--job', submitted.job, '--wait', '2');
  assert.equal(running.status, 'running');
  assert.equal(running.progress.monitoring, 'subscribed');
  assert.ok(running.progress.responseCharacters > 0);
  fs.writeFileSync(path.join(f.project, 'pause-events'), 'pause');
  const cancelled = await f.invoke('cancel', '--job', submitted.job);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.progress.responseCharacters >= running.progress.responseCharacters);
  const rpc = fs.readFileSync(path.join(f.project, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(rpc.some(x => x.method === 'turn/interrupt'), 'adapter asked the runtime to interrupt the turn');
  assert.ok(!JSON.stringify(cancelled).includes('PRIVATE_'));
});

test('codex native continuation resumes the recorded thread after explicit re-preflight', async t => {
  const f = fixture(t);
  const first = await f.dispatch('Read the synthetic codex project only.', [], 'codex-cont-001');
  assert.equal((await f.invoke('status', '--job', first.job, '--wait', '5')).status, 'ready_for_review');
  const checkpoint = JSON.parse(fs.readFileSync(path.join(first.job, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.sessionId, 'th_fixture_1');
  assert.equal(checkpoint.resumeSupport, 'native');
  assert.equal(checkpoint.artifacts.summary, true);
  assert.ok(!JSON.stringify(checkpoint).includes('PRIVATE_'));
  // Refusals first: live worker, stale request id, changed selection.
  const hanging = await f.dispatch('hang instead of finishing', [], 'codex-cont-hang');
  const contCard = f.card('Continue the synthetic codex task.');
  const fresh = await f.invoke('prepare', '--task-file', contCard, ...f.selection());
  const refuseLive = await f.invoke('continue', '--job', hanging.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'codex-cont-002');
  assert.equal(refuseLive.code, 1); assert.match(refuseLive.error, /still running|still alive/);
  assert.equal((await f.invoke('cancel', '--job', hanging.job)).status, 'cancelled');
  const changedCard = f.card('Continue with another model.');
  const changedPrep = await f.invoke('prepare', '--task-file', changedCard, ...f.selection({ '--model': 'gpt-other' }));
  const refuseSelection = await f.invoke('continue', '--job', first.job, '--task-file', changedCard, ...f.selection({ '--model': 'gpt-other' }),
    '--prepared-ref', changedPrep.preparedRef, '--endpoint', changedPrep.destination.endpoint, '--request-id', 'codex-cont-003');
  assert.equal(refuseSelection.code, 1); assert.match(refuseSelection.error, /original model/);
  const noFresh = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'codex-cont-001');
  assert.equal(noFresh.code, 1); assert.match(noFresh.error, /fresh request_id|already/);
  const continued = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'codex-cont-002', '--wait', '2');
  assert.equal(continued.code, 0, JSON.stringify(continued));
  assert.equal(continued.resumeMode, 'native');
  assert.equal(continued.continuation.of, first.id);
  f.track(continued.job);
  const done = await f.invoke('status', '--job', continued.job, '--wait', '5');
  assert.equal(done.status, 'ready_for_review');
  assert.equal(done.continuation.previousSessionId, 'th_fixture_1');
  const result = await f.invoke('result', '--job', continued.job);
  assert.match(result.summary, /Codex fixture result/);
  assert.ok(!result.summary.includes('STALE_OLD_RESULT'));
  const replay = await f.invoke('continue', '--job', first.job, '--task-file', contCard, ...f.selection(),
    '--prepared-ref', fresh.preparedRef, '--endpoint', fresh.destination.endpoint, '--request-id', 'codex-cont-002');
  assert.equal(replay.job, continued.job);
  assert.equal(replay.reused, true);
  const rpc = fs.readFileSync(path.join(f.project, 'rpc.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const resume = rpc.find(x => x.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'th_fixture_1');
  assert.equal(resume.params.cwd, fs.realpathSync(f.project));
});

test('expired preparation blocks only new dispatch; running jobs and checkpoints are unaffected', async t => {
  const f = fixture(t);
  const card = f.card('Read the synthetic codex project only.');
  const prepared = await f.invoke('prepare', '--task-file', card, ...f.selection());
  const running = await f.invoke('submit', '--task-file', card, ...f.selection(),
    '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint, '--request-id', 'codex-ttl-001');
  assert.equal(running.code, 0);
  const finished = await f.invoke('status', '--job', running.job, '--wait', '5');
  assert.equal(finished.status, 'ready_for_review');
  assert.equal(finished.sessionId, 'th_fixture_1');
  assert.ok(fs.existsSync(path.join(running.job, 'checkpoint.json')));
  const record = path.join(f.project, '.ai', 'preparations', prepared.preparedRef + '.json');
  const data = JSON.parse(fs.readFileSync(record, 'utf8'));
  data.expiresAt = 0;
  fs.writeFileSync(record, JSON.stringify(data));
  const blocked = await f.invoke('submit', '--task-file', card, ...f.selection(),
    '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint, '--request-id', 'codex-ttl-002');
  assert.equal(blocked.code, 1); assert.match(blocked.error, /expired/);
  const status = await f.invoke('status', '--job', running.job);
  assert.equal(status.status, 'ready_for_review'); // expiry never touched the ended job or its artifacts
  const result = await f.invoke('result', '--job', running.job);
  assert.match(result.summary, /Codex fixture result/);
});
