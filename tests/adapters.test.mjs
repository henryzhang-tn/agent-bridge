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

const exec = promisify(execFile);
const scripts = fileURLToPath(new URL('../plugins/agent-bridge/scripts/', import.meta.url));
async function mockAPI(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ url: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'glm-5.3-flash' }] }));
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
  const messages = api.requests.filter(x => x.body?.messages && !x.url.includes('count_tokens'));
  assert.ok(messages.length > 0);
  for (const { body } of messages) {
    assert.equal(body.model, f.state.model);
    assert.equal(body.output_config?.effort, 'high');
    assert.ok((body.tools || []).every(x => ['Read', 'Glob', 'Grep'].includes(x.name)));
  }
  assert.ok(!JSON.stringify(result).includes('synthetic-test-key'));
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
