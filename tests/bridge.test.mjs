import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bridge = fileURLToPath(new URL('../plugins/agent-bridge/scripts/bridge.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-bridge-test-'));
  const project = path.join(root, 'project with spaces $(no-shell)');
  fs.mkdirSync(project);
  const entry = path.join(root, 'fake-zcode.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs';
const argv = process.argv.slice(2);
const get = flag => argv[argv.indexOf(flag) + 1];
const prompt = get('--prompt');
fs.appendFileSync(get('--cwd') + '/worker-starts.txt', 'start\\n');
const task = fs.readFileSync(prompt.match(/Read the task card at (.+\\/task\\.md)\\. Read/)[1], 'utf8');
if (task.includes('hang')) { setInterval(() => {}, 1000); }
else if (task.includes('error')) { process.stderr.write('synthetic error'); process.exitCode = 7; }
else if (task.includes('malformed')) { process.stdout.write('not json'); }
else {
  fs.writeFileSync(get('--cwd') + '/produced.txt', 'worker edit');
  process.stdout.write(JSON.stringify({sessionId:'sess_fixture', response:'Edited produced.txt. Tests not run.',usage:{inputTokens:100,outputTokens:10},projection:{status:'idle'}}));
}
`);
  const jobs = [];
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'fixture', config: { api: { baseUrl: 'http://127.0.0.1:9000' } } }] } } }));
  const preparations = new Map();
  const invoke = async (...argv) => {
    try {
      const x = await exec(process.execPath, [bridge, ...argv], { env: { ...process.env, AGENT_BRIDGE_HOST: 'generic', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config, ZCODE_WORKER_ENTRY: entry, ZCODE_WORKER_TRANSPORT: 'prompt', CLAUDE_WORKER_ENTRY: entry, HERMES_WORKER_PYTHON: process.execPath }, timeout: 15000 });
      return { code: 0, ...JSON.parse(x.stdout) };
    } catch (e) {
      if (!e.stdout) throw e;
      return { code: e.code, ...JSON.parse(e.stdout) };
    }
  };
  const submit = async (content, extra = []) => {
    const card = path.join(root, 'task-' + Math.random() + '.md');
    fs.writeFileSync(card, content);
    const options = new Map([['--project', project], ['--task-file', card], ['--worker', 'zcode'], ['--provider', 'fixture'], ['--model', 'GLM-5.3'], ['--effort', 'low'], ['--mode', 'edit']]);
    for (let i = 0; i < extra.length; i += 2) options.set(extra[i], extra[i + 1]);
    const key = JSON.stringify([content, [...options].filter(([k]) => !['--task-file', '--wait', '--request-id'].includes(k))]);
    let preparation = preparations.get(key);
    if (!preparation && !fs.existsSync(path.join(project, '.ai/zcode-worker.lock'))) {
      preparation = await invoke('prepare', ...[...options].flat());
      if (preparation.code !== 0) return preparation;
      preparations.set(key, preparation);
    }
    const x = await invoke('submit', ...[...options].flat(), '--prepared-ref', preparation?.preparedRef || '0'.repeat(32), '--endpoint', preparation?.destination.endpoint || 'http://127.0.0.1:9000');
    if (x.job) jobs.push(x.job);
    return x;
  };
  t.after(async () => {
    for (const job of jobs) await invoke('cancel', '--job', job);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { project, invoke, submit, entry, config };
}

test('concurrent retries and completed requests reuse one execution; selection changes conflict', async t => {
  const f = fixture(t);
  const extra = ['--request-id', 'edit-001'];
  const submissions = await Promise.all([f.submit('Fix a local fixture', extra), f.submit('Fix a local fixture', extra)]);
  assert.ok(submissions.every(s => s.code === 0), JSON.stringify(submissions));
  assert.equal(submissions[0].job, submissions[1].job);
  assert.equal(submissions.filter(s => s.reused).length, 1);
  const result = await f.invoke('status', '--job', submissions[0].job, '--wait', '3');
  assert.equal(result.status, 'ready_for_review');
  for (const changed of [['--effort', 'high'], ['--worker', 'claude'], ['--timeout', '45']]) {
    // Replace a fixture default instead of supplying duplicate CLI options.
    const card = path.join(f.project, 'conflict-task.md'); fs.writeFileSync(card, 'Fix a local fixture');
    const args = ['submit', '--project', f.project, '--task-file', card, '--worker', 'zcode', '--provider', 'fixture', '--endpoint', 'http://127.0.0.1:9000', '--model', 'GLM-5.3', '--effort', 'low', ...extra];
    const index = args.indexOf(changed[0]);
    if (index >= 0) args[index + 1] = changed[1]; else args.push(...changed);
    const conflict = await f.invoke(...args);
    assert.equal(conflict.code, 1); assert.match(conflict.error, /conflicts/);
  }
  assert.match((await f.submit('Changed task', extra)).error, /conflicts/);
  fs.unlinkSync(f.entry); // Reading a completed request must not need the runtime.
  const reused = await f.submit('Fix a local fixture', extra);
  assert.equal(reused.status, 'ready_for_review'); assert.equal(reused.reused, true);
  assert.equal(reused.requestId, 'edit-001');
  assert.equal(fs.readFileSync(path.join(f.project, 'worker-starts.txt'), 'utf8'), 'start\n');
});

test('failed and cancelled requests are not automatically rerun; new IDs start new work', async t => {
  const f = fixture(t);
  const failed = await f.submit('error', ['--request-id', 'failed-001', '--wait', '2']);
  assert.equal(failed.status, 'failed');
  const retry = await f.submit('error', ['--request-id', 'failed-001']);
  assert.equal(retry.job, failed.job); assert.equal(retry.reused, true); assert.equal(retry.status, 'failed');
  const running = await f.submit('hang', ['--request-id', 'cancel-001']);
  assert.equal((await f.invoke('cancel', '--job', running.job)).status, 'cancelled');
  const cancelled = await f.submit('hang', ['--request-id', 'cancel-001']);
  assert.equal(cancelled.reused, true); assert.equal(cancelled.status, 'cancelled');
  const fresh = await f.submit('Fix a local fixture', ['--request-id', 'edit-002', '--wait', '2']);
  assert.equal(fresh.reused, false); assert.equal(fresh.status, 'ready_for_review');
  assert.equal(fs.readFileSync(path.join(f.project, 'worker-starts.txt'), 'utf8').trim().split('\n').length, 3);
});

test('dead supervisor retains the lock while its worker lives; explicit cancel stops the orphan', async t => {
  const f = fixture(t);
  const job = await f.submit('hang', ['--timeout', '30']);
  const statePath = path.join(job.job, 'state.json');
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  process.kill(s.runnerPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 150));
  s.updatedAt = Date.now() - 15000; fs.writeFileSync(statePath, JSON.stringify(s));
  const orphan = await f.invoke('status', '--job', job.job);
  assert.equal(orphan.status, 'orphaned');
  assert.equal(fs.existsSync(path.join(f.project, '.ai/zcode-worker.lock')), true);
  assert.match((await f.submit('competing task')).error, /already owns/);
  const cancelled = await f.invoke('cancel', '--job', job.job);
  assert.equal(cancelled.status, 'cancelled', JSON.stringify(cancelled));
  assert.equal(fs.existsSync(path.join(f.project, '.ai/zcode-worker.lock')), false);
  assert.throws(() => process.kill(-s.childPid, 0), { code: 'ESRCH' });
  assert.equal((await f.submit('next task', ['--wait', '2'])).status, 'ready_for_review');
});

test('dead supervisor and worker become interrupted without spawning or discarding edits', async t => {
  const f = fixture(t);
  const job = await f.submit('hang', ['--timeout', '30', '--request-id', 'interrupted-001']);
  const statePath = path.join(job.job, 'state.json');
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(path.join(f.project, 'partial.txt'), 'preserve me');
  process.kill(s.runnerPid, 'SIGKILL'); process.kill(-s.childPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 150));
  s.updatedAt = Date.now() - 15000; fs.writeFileSync(statePath, JSON.stringify(s));
  assert.equal((await f.invoke('result', '--job', job.job)).status, 'interrupted');
  const reused = await f.submit('hang', ['--timeout', '30', '--request-id', 'interrupted-001']);
  assert.equal(reused.reused, true); assert.equal(reused.status, 'interrupted');
  assert.equal(fs.readFileSync(path.join(f.project, 'partial.txt'), 'utf8'), 'preserve me');
  assert.equal(fs.existsSync(path.join(f.project, '.ai/zcode-worker.lock')), false);
});

test('a terminal job left with a stale lock is reclaimed without rerunning it', async t => {
  const f = fixture(t);
  const done = await f.submit('Fix a local fixture', ['--request-id', 'done-001', '--wait', '2']);
  const statePath = path.join(done.job, 'state.json');
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  s.runnerPid = null; s.childPid = null;
  fs.writeFileSync(statePath, JSON.stringify(s));
  const lock = path.join(f.project, '.ai/zcode-worker.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ id: s.id, job: s.job }));
  const result = await f.invoke('result', '--job', done.job);
  assert.equal(result.status, 'ready_for_review');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readFileSync(path.join(f.project, 'worker-starts.txt'), 'utf8'), 'start\n');
});

test('interrupted cancellation retains cancelled status and does not become recoverable', async t => {
  const f = fixture(t);
  const job = await f.submit('hang', ['--timeout', '30', '--request-id', 'cancel-race-001']);
  const statePath = path.join(job.job, 'state.json');
  const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  process.kill(s.runnerPid, 'SIGKILL');
  fs.writeFileSync(path.join(job.job, 'cancel.request'), 'cancel\n');
  process.kill(-s.childPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 150));
  s.updatedAt = Date.now() - 15000; fs.writeFileSync(statePath, JSON.stringify(s));
  assert.equal((await f.invoke('status', '--job', job.job)).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(f.project, '.ai/zcode-worker.lock')), false);
  const reused = await f.submit('hang', ['--timeout', '30', '--request-id', 'cancel-race-001']);
  assert.equal(reused.reused, true); assert.equal(reused.status, 'cancelled');
});

test('dispatch, recover result and usage; paths are arguments rather than shell code', async t => {
  const f = fixture(t);
  const job = await f.submit('Fix a local fixture', ['--wait', '3']);
  assert.equal(job.status, 'ready_for_review');
  const result = await f.invoke('result', '--job', job.job);
  assert.equal(result.sessionId, 'sess_fixture');
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 10 });
  assert.match(result.summary, /Tests not run/);
  assert.equal(fs.readFileSync(path.join(f.project, 'produced.txt'), 'utf8'), 'worker edit');
  assert.equal(fs.existsSync(path.join(f.project, '.ai', 'zcode-worker.lock')), false);
  assert.equal(fs.statSync(path.join(job.job, 'state.json')).mode & 0o777, 0o600);
  const next = await f.submit('Another task', ['--wait', '2']);
  assert.equal(next.status, 'ready_for_review');
});

test('only one worker can own a project; cancellation stops it and unlocks', async t => {
  const f = fixture(t);
  const job = await f.submit('hang', ['--timeout', '30']);
  assert.equal(job.status, 'running');
  const other = await f.submit('competing task');
  assert.equal(other.code, 1);
  assert.match(other.error, /already owns/);
  for (const worker of ['claude', 'hermes']) {
    const otherWorker = await f.submit('competing agent', ['--worker', worker]);
    assert.equal(otherWorker.code, 1); assert.match(otherWorker.error, /already owns/);
  }
  const cancelled = await f.invoke('cancel', '--job', job.job);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(f.project, '.ai', 'zcode-worker.lock')), false);
});

test('timeout cannot be mistaken for successful execution', async t => {
  const f = fixture(t);
  const job = await f.submit('hang', ['--timeout', '1', '--wait', '4']);
  assert.equal(job.status, 'timed_out');
  assert.equal(job.result, null);
});

test('nonzero exit and malformed output both fail closed', async t => {
  const f = fixture(t);
  const failed = await f.submit('error', ['--wait', '2']);
  assert.equal(failed.status, 'failed'); assert.equal(failed.exitCode, 7);
  const malformed = await f.submit('malformed', ['--wait', '2']);
  assert.equal(malformed.status, 'failed'); assert.match(malformed.error, /recognized JSON/);
});

test('bypass modes and oversized task context are rejected before startup', async t => {
  const f = fixture(t);
  const bypass = await f.submit('small task', ['--mode', 'yolo']);
  assert.equal(bypass.code, 1); assert.match(bypass.error, /not supported/);
  const large = await f.submit('x'.repeat(24001));
  assert.equal(large.code, 1); assert.match(large.error, /24000/);
  assert.equal(fs.existsSync(path.join(f.project, '.ai')), false);
});

test('metadata cannot be redirected through a project symlink', async t => {
  const f = fixture(t);
  fs.symlinkSync(os.tmpdir(), path.join(f.project, '.ai'));
  const result = await f.submit('small task');
  assert.equal(result.code, 1); assert.match(result.error, /real directory/);
});

test('app-server selects a session model, preserves low effort and collects info/parts messages', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-protocol-test-'));
  const entry = path.join(root, 'server.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import readline from 'node:readline';
const send = x => process.stdout.write(JSON.stringify(x)+'\\n');
const log = x => fs.appendFileSync('requests.jsonl',JSON.stringify(x)+'\\n');
const snapshot={session:{sessionId:'sess_protocol',status:'idle'},settings:{model:{current:{providerId:'glm',modelId:'GLM-5.3'},available:[{ref:{providerId:'glm',modelId:'GLM-5.3'},providerLabel:'Fixture',reasoning:{levels:[{value:'low'}]}}]}},projection:{status:'idle'},messages:[{info:{role:'assistant'},parts:[{type:'text',text:'Verified protocol result'}]}]};
let create;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);log(m);
 if(m.id==='prefs'){send({id:create.id,result:snapshot});return;}
 if(m.method==='session/create'){create=m;send({id:'prefs',method:'session/requestRuntimePreferences',params:{sessionId:'sess_protocol',scope:'runtime-materialization'}});}
 else if(m.method==='session/setModel')send({id:m.id,result:snapshot});
 else if(m.method==='session/subscribe')send({id:m.id,result:{sessionId:'sess_protocol',eventSeq:0,events:[]}});
 else if(m.method==='session/send')setTimeout(()=>{send({method:'state.updated',params:{sessionId:'sess_protocol',reason:'prompt_completed'}});send({id:m.id,result:{accepted:true}});},50);
 else if(m.method==='session/read')send({id:m.id,result:snapshot});
 else if(m.method==='session/usage')send({id:m.id,result:{inputTokens:42,outputTokens:8,modelRequestCount:1}});
 else if(m.method==='session/close')send({id:m.id,result:{closed:true}});
});`);
  const card = path.join(root, 'task.md'); fs.writeFileSync(card, 'Read the synthetic project');
  const config = path.join(root, 'providers.json');
  fs.writeFileSync(config, JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerId: 'glm', config: { api: { baseUrl: 'http://127.0.0.1:9000' } } }] } } }));
  const env = { ...process.env, ZCODE_WORKER_ENTRY: entry, ZCODE_WORKER_TRANSPORT: 'app-server', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: config, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: config };
  let job;
  t.after(async () => {
    if (job) await exec(process.execPath, [bridge, 'cancel', '--job', job], { env });
    fs.rmSync(root, { recursive: true, force: true });
  });
  const selection = ['--project', root, '--task-file', card, '--worker', 'zcode', '--provider', 'glm', '--model', 'GLM-5.3', '--effort', 'low', '--mode', 'plan'];
  const prepared = JSON.parse((await exec(process.execPath, [bridge, 'prepare', ...selection], { env })).stdout);
  const submitted = await exec(process.execPath, [bridge, 'submit', ...selection, '--prepared-ref', prepared.preparedRef, '--endpoint', prepared.destination.endpoint, '--wait', '3'], { env });
  const state = JSON.parse(submitted.stdout); job = state.job;
  assert.equal(state.status, 'ready_for_review');
  const result = JSON.parse((await exec(process.execPath, [bridge, 'result', '--job', job], { env })).stdout);
  assert.equal(result.summary.trim(), 'Verified protocol result');
  assert.equal(result.usage.modelRequestCount, 1);
  const requests = fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(requests.find(x => x.method === 'session/create').params.toolAllowlist, ['Read', 'Glob', 'Grep']);
  assert.deepEqual(requests.find(x => x.method === 'session/create').params.mcpServers, []);
  assert.equal(requests.find(x => x.id === 'prefs').result.askUserQuestionAutoResolutionEnabled, false);
  assert.equal(requests.find(x => x.method === 'session/setModel').params.persistAsWorkspaceLastUsed, false);
  assert.equal(requests.find(x => x.method === 'session/setModel').params.model.options.reasoningLevel, 'low');
  assert.deepEqual(requests.find(x => x.method === 'session/subscribe').params, { sessionId: 'sess_protocol', deliveryKind: 'desktop-continuous', includeSnapshot: false });
  const stateFile = path.join(job, 'state.json');
  const stored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  stored.status = 'failed'; stored.error = 'Synthetic lost stdout forwarding';
  fs.writeFileSync(stateFile, JSON.stringify(stored));
  const recovered = JSON.parse((await exec(process.execPath, [bridge, 'collect', '--job', job], { env })).stdout);
  assert.equal(recovered.status, 'ready_for_review');
  assert.equal(fs.readFileSync(path.join(root, 'requests.jsonl'), 'utf8').trim().split('\n').length, requests.length, 'collect must not invoke the model or app-server again');
});
