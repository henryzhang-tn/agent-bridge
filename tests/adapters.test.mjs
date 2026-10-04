import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { entryFor } from '../plugins/agent-bridge/scripts/workers.mjs';
import { readProgress } from '../plugins/agent-bridge/scripts/zcode-progress.mjs';

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL('../plugins/agent-bridge/scripts/', import.meta.url));
async function mockAPI(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }, { id: 'glm-5.3' }] }));
    if (req.url.includes('count_tokens')) return res.end('{"input_tokens":100}');
    if (req.url.includes('chat/completions')) {
      const completion = { id: 'mock-completion', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'MOCK_CONNECTED' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } };
      if (!body.stream) return res.end(JSON.stringify(completion));
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'MOCK_CONNECTED' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    if (req.url.includes('/messages')) {
      const message = { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'MOCK_CONNECTED' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 5 } };
      if (!body.stream) return res.end(JSON.stringify(message));
      res.setHeader('Content-Type', 'text/event-stream');
      for (const [type, payload] of [
        ['message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'MOCK_CONNECTED' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
        ['message_stop', {}],
      ]) res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...payload }) + '\n\n');
      return res.end();
    }
    res.statusCode = 404; res.end('{"error":"unsupported mock route"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: 'http://127.0.0.1:' + server.address().port, requests };
}
function jobFixture(t, worker) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-adapter-'));
  const job = path.join(root, 'job'); fs.mkdirSync(job, { mode: 0o700 });
  const state = { id: 'mock-' + worker, worker, job, project: root, mode: 'plan', provider: worker === 'hermes' ? 'zai' : '127.0.0.1', model: 'glm-5.3-flash', effort: 'high', entry: entryFor(worker) };
  fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(job, 'prompt.md'), 'Synthetic test. No tools or external actions.');
  fs.writeFileSync(path.join(job, 'task.md'), 'Return MOCK_CONNECTED only.');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, job, state };
}

test('real Claude CLI sends chosen model/effort to mock API with only read tools and no global context', { timeout: 45000, skip: !fs.existsSync(entryFor('claude')) }, async t => {
  const f = jobFixture(t, 'claude'), api = await mockAPI(t);
  fs.writeFileSync(path.join(f.job, 'state.json'), JSON.stringify({ ...f.state, destination: { provider: f.state.provider, endpoint: api.url } }));
  const settings = path.join(f.root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_AUTH_TOKEN: 'synthetic-test-key', ANTHROPIC_MODEL: 'other-model' },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'exit 97' }] }] } }));
  await exec(process.execPath, [path.join(scripts, 'claude-adapter.mjs'), f.job], { timeout: 40000, env: { ...process.env, CLAUDE_WORKER_SETTINGS: settings }, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(fs.readFileSync(path.join(f.job, 'adapter-result.json'), 'utf8'));
  assert.equal(result.projection.status, 'idle'); assert.equal(result.response, 'MOCK_CONNECTED');
  assert.equal(result.effortEvidence.sentToRuntime, 'high');
  assert.equal(result.effortEvidence.runtimeConfirmed, null);
  assert.equal(result.effortEvidence.providerConfirmed, null);
  const progress = readProgress(f.job);
  assert.equal(progress.monitoring, 'subscribed');
  assert.equal(progress.sessionId, result.sessionId);
  assert.ok(progress.responseCharacters > 0, 'real CLI emits streamed activity');
  const resumedJob = path.join(f.root, 'resumed'); fs.mkdirSync(resumedJob);
  fs.writeFileSync(path.join(resumedJob, 'state.json'), JSON.stringify({ ...f.state, id: 'mock-claude-resumed', job: resumedJob,
    destination: { provider: f.state.provider, endpoint: api.url },
    resume: { mode: 'native', sessionId: result.sessionId, runtimeProfile: path.join(f.job, 'claude-runtime') } }));
  fs.writeFileSync(path.join(resumedJob, 'prompt.md'), 'Continue the previous synthetic task. No tools or external actions.');
  fs.writeFileSync(path.join(resumedJob, 'task.md'), 'Return MOCK_CONNECTED again.');
  await exec(process.execPath, [path.join(scripts, 'claude-adapter.mjs'), resumedJob], { timeout: 40000,
    env: { ...process.env, CLAUDE_WORKER_SETTINGS: settings }, maxBuffer: 1024 * 1024 });
  const resumed = JSON.parse(fs.readFileSync(path.join(resumedJob, 'adapter-result.json'), 'utf8'));
  assert.equal(resumed.sessionId, result.sessionId, 'Claude actually reopened its persisted session');
  assert.equal(resumed.response, 'MOCK_CONNECTED');
  assert.equal(resumed.projection.status, 'idle');
  const messages = api.requests.filter(x => x.body?.messages && !x.url.includes('count_tokens'));
  assert.ok(messages.length > 0);
  for (const { body } of messages) {
    assert.equal(body.model, f.state.model);
    assert.equal(body.output_config?.effort, 'high');
    assert.ok((body.tools || []).every(x => ['Read', 'Glob', 'Grep'].includes(x.name)));
  }
  assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
});

test('full-model max effort reaches the real Claude CLI mock API without claiming provider confirmation', { timeout: 45000, skip: !fs.existsSync(entryFor('claude')) }, async t => {
  const f = jobFixture(t, 'claude'), api = await mockAPI(t);
  const settings = path.join(f.root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: api.url, ANTHROPIC_AUTH_TOKEN: 'synthetic-test-key' } }));
  fs.writeFileSync(path.join(f.job, 'state.json'), JSON.stringify({ ...f.state, model: 'glm-5.3', effort: 'max', destination: { provider: f.state.provider, endpoint: api.url } }));
  await exec(process.execPath, [path.join(scripts, 'claude-adapter.mjs'), f.job], { timeout: 40000, env: { ...process.env, CLAUDE_WORKER_SETTINGS: settings }, maxBuffer: 1024 * 1024 });
  const messages = api.requests.filter(x => x.body?.messages && !x.url.includes('count_tokens'));
  assert.ok(messages.length > 0);
  for (const { body } of messages) {
    assert.equal(body.model, 'glm-5.3');
    assert.equal(body.output_config?.effort, 'max');
  }
  const result = JSON.parse(fs.readFileSync(path.join(f.job, 'adapter-result.json')));
  assert.equal(result.effortEvidence.requested, 'max');
  assert.equal(result.effortEvidence.sentToRuntime, 'max');
  assert.equal(result.effortEvidence.runtimeConfirmed, null);
  assert.equal(result.effortEvidence.providerConfirmed, null);
});

test('real Hermes runtime sends explicit GLM effort and restricts plan tools in an isolated profile', { timeout: 45000, skip: !fs.existsSync(entryFor('hermes')) }, async t => {
  const f = jobFixture(t, 'hermes'), api = await mockAPI(t);
  fs.writeFileSync(path.join(f.job, 'state.json'), JSON.stringify({ ...f.state, destination: { provider: f.state.provider, endpoint: api.url } }));
  const home = path.join(f.root, 'source-home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: glm-5.3-flash\n  provider: zai\n');
  fs.writeFileSync(path.join(home, '.env'), 'GLM_API_KEY=synthetic-test-key\nGLM_BASE_URL=' + api.url + '\n');
  fs.writeFileSync(path.join(home, 'SOUL.md'), 'PRIVATE_MEMORY_MUST_NOT_LEAK');
  await exec(entryFor('hermes'), [path.join(scripts, 'hermes-adapter.py'), f.job], { timeout: 40000, env: { ...process.env, HERMES_WORKER_HOME: home }, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(fs.readFileSync(path.join(f.job, 'adapter-result.json'), 'utf8'));
  assert.equal(result.projection.status, 'idle'); assert.equal(result.response, 'MOCK_CONNECTED');
  const progress = readProgress(f.job);
  assert.equal(progress.monitoring, 'subscribed');
  assert.equal(progress.sessionId, result.sessionId);
  assert.ok(progress.responseCharacters > 0, 'real Hermes callback emits streamed activity');
  const calls = api.requests.filter(x => x.url.includes('chat/completions'));
  assert.ok(calls.length > 0);
  for (const { body } of calls) {
    assert.equal(body.model, f.state.model);
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.thinking?.type, 'enabled');
    assert.ok((body.tools || []).every(x => ['read_file', 'search_files'].includes(x.function.name)));
    assert.ok(!JSON.stringify(body).includes('PRIVATE_MEMORY_MUST_NOT_LEAK'));
  }
  assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
  assert.ok(!fs.readFileSync(path.join(f.job, 'hermes-runtime/config.yaml'), 'utf8').includes('synthetic-test-key'));
});

test('full-model max effort reaches the real Hermes mock API', { timeout: 45000, skip: !fs.existsSync(entryFor('hermes')) }, async t => {
  const f = jobFixture(t, 'hermes'), api = await mockAPI(t);
  const home = path.join(f.root, 'source-home'); fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: glm-5.3\n  provider: zai\n');
  fs.writeFileSync(path.join(home, '.env'), 'GLM_API_KEY=synthetic-test-key\nGLM_BASE_URL=' + api.url + '\n');
  fs.writeFileSync(path.join(f.job, 'state.json'), JSON.stringify({ ...f.state, model: 'glm-5.3', effort: 'max', destination: { provider: f.state.provider, endpoint: api.url } }));
  await exec(entryFor('hermes'), [path.join(scripts, 'hermes-adapter.py'), f.job], { timeout: 40000, env: { ...process.env, HERMES_WORKER_HOME: home }, maxBuffer: 1024 * 1024 });
  const calls = api.requests.filter(x => x.url.includes('chat/completions'));
  assert.ok(calls.length > 0);
  for (const { body } of calls) assert.equal(body.reasoning_effort, 'max');
  const result = JSON.parse(fs.readFileSync(path.join(f.job, 'adapter-result.json')));
  assert.equal(result.effortEvidence.requested, 'max');
  assert.equal(result.effortEvidence.sentToRuntime, 'max');
  assert.equal(result.effortEvidence.providerConfirmed, null);
});

// Synthetic worker executables: no real Claude CLI, Hermes runtime or inference.
// They verify only that every adapter persists compact progress for its worker.
test('claude adapter persists progress from a synthetic CLI without streaming telemetry', async t => {
  const f = jobFixture(t, 'claude');
  const cli = path.join(f.root, 'fake-claude.mjs');
  fs.writeFileSync(cli, `let text = '';
process.stdin.on('data', d => { text += d; });
process.stdin.on('end', () => {
  if (text.includes('BLOCKER')) process.stdout.write(JSON.stringify({ is_error: true, subtype: 'permission_denied', result: '', session_id: 'sess_claude_fake', permission_denials: [{}], usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: {} }));
  else process.stdout.write(JSON.stringify({ is_error: false, result: 'CLAUDE_FAKE_DONE', session_id: 'sess_claude_fake', usage: { input_tokens: 3, output_tokens: 1 }, modelUsage: { 'glm-5.3-flash': { inputTokens: 3, outputTokens: 1 } } }));
});
`);
  const settings = path.join(f.root, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_AUTH_TOKEN: 'synthetic-test-key', ANTHROPIC_MODEL: 'glm-5.3-flash' } }));
  for (const blocker of [false, true]) {
    const job = path.join(f.root, 'job-' + (blocker ? 'blocked' : 'ok'));
    fs.mkdirSync(job, { mode: 0o700 });
    fs.writeFileSync(path.join(job, 'state.json'), JSON.stringify({ ...f.state, job, id: path.basename(job), entry: cli }));
    fs.writeFileSync(path.join(job, 'prompt.md'), 'Synthetic claude progress test.');
    fs.writeFileSync(path.join(job, 'task.md'), blocker ? 'BLOCKER task' : 'Plain task');
    await exec(process.execPath, [path.join(scripts, 'claude-adapter.mjs'), job], { timeout: 30000, env: { ...process.env, CLAUDE_WORKER_SETTINGS: settings, CLAUDE_WORKER_ENTRY: cli }, maxBuffer: 1024 * 1024 });
    const progress = readProgress(job);
    assert.ok(progress, 'claude jobs persist progress.json');
    assert.equal(progress.source, 'claude-cli');
    assert.equal(progress.worker, 'claude');
    assert.equal(progress.sessionId, 'sess_claude_fake');
    if (blocker) {
      assert.equal(progress.assessment.attention, 'host_interaction_required');
    } else {
      assert.equal(progress.assessment.activity, 'unknown', 'no streaming telemetry means unknown, never a stall');
      assert.match(progress.assessment.note, /not evidence of a stall/);
    }
    if (blocker) {
      assert.equal(progress.phase, 'blocked');
      assert.equal(progress.hostInteractionRequired, true);
      const result = JSON.parse(fs.readFileSync(path.join(job, 'adapter-result.json'), 'utf8'));
      assert.match(result.notes.join('; '), /denied 1 tool request/);
    } else {
      assert.equal(progress.phase, 'completed');
      assert.ok(!JSON.stringify(progress).includes('synthetic-test-key'));
    }
  }
});

test('hermes adapter persists progress and approval blockers from a synthetic runtime', { skip: !fs.existsSync(entryFor('hermes')) }, async t => {
  const f = jobFixture(t, 'hermes');
  const home = path.join(f.root, 'source-home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: glm-5.3-flash\n  provider: zai\n');
  fs.writeFileSync(path.join(home, '.env'), 'GLM_API_KEY=synthetic-test-key\nGLM_BASE_URL=http://127.0.0.1:1\n');
  const runtime = path.join(f.root, 'fake-runtime');
  fs.mkdirSync(path.join(runtime, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'run_agent.py'), `class AIAgent:
    def __init__(self, **kwargs):
        self.session_id = "sess_hermes_fake"
        self.tools = []
        self.kwargs = kwargs
    def run_conversation(self, user_message):
        from tools.terminal_tool import trigger
        trigger()  # invoke the adapter-installed approval callback
        return {"completed": True, "final_response": "HERMES_FAKE_DONE", "model": self.kwargs.get("model"), "provider": self.kwargs.get("provider"), "input_tokens": 2, "output_tokens": 1}
`);
  fs.writeFileSync(path.join(runtime, 'tools', 'terminal_tool.py'), `_callback = None
def set_approval_callback(cb):
    global _callback
    _callback = cb
def trigger():
    return _callback() if _callback else None
`);
  await exec(entryFor('hermes'), [path.join(scripts, 'hermes-adapter.py'), f.job], { timeout: 30000, env: { ...process.env, HERMES_WORKER_HOME: home, HERMES_WORKER_REPO: runtime }, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(fs.readFileSync(path.join(f.job, 'adapter-result.json'), 'utf8'));
  assert.match(result.response, /HERMES_FAKE_DONE/);
  assert.match(result.notes.join('; '), /interactive approval/);
  assert.equal(result.sessionId, 'sess_hermes_fake');
  const progress = readProgress(f.job);
  assert.ok(progress, 'hermes jobs persist progress.json');
  assert.equal(progress.source, 'hermes-runtime');
  assert.equal(progress.worker, 'hermes');
  assert.equal(progress.sessionId, 'sess_hermes_fake');
  assert.equal(progress.hostInteractionRequired, true);
  assert.equal(progress.phase, 'blocked');
  assert.equal(progress.monitoring, 'unsupported');
  assert.equal(progress.assessment.attention, 'host_interaction_required');
  assert.ok(!JSON.stringify(progress).includes('synthetic-test-key'));
  assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
});
