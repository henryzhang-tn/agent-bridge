import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProgressTracker, readProgress } from '../plugins/agent-bridge/scripts/zcode-progress.mjs';

function fixture(t) {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-progress-'));
  let time = Date.now(), seq = 0;
  const tracker = createProgressTracker(job, { now: () => time });
  t.after(() => { tracker.close(); fs.rmSync(job, { recursive: true, force: true }); });
  tracker.bindSession('sess_progress'); tracker.monitoring('subscribed');
  const event = (type, payload, extra) => tracker.observe({ sessionId: 'sess_progress', seq: ++seq, type, payload, ...extra });
  return { job, tracker, event, advance: ms => { time += ms; }, read: () => readProgress(job, time) };
}

test('reasoning activity advances without file edits and heartbeat/status reads do not reset idle time', t => {
  const f = fixture(t);
  f.tracker.state('prompt_started');
  f.advance(5000);
  assert.equal(f.read().idleSeconds, 5);
  f.event('model.streaming', { kind: 'reasoning_delta', delta: 'PRIVATE_REASONING' });
  assert.equal(f.read().phase, 'reasoning');
  assert.equal(f.read().idleSeconds, 0);
  f.advance(230000);
  f.tracker.state('heartbeat');
  assert.equal(f.read().idleSeconds, 230);
  f.event('model.streaming', { kind: 'reasoning_delta', delta: 'MORE_PRIVATE_REASONING' });
  assert.equal(f.read().idleSeconds, 0);
  f.event('model.streaming', { kind: 'text_delta', delta: 'PRIVATE_RESPONSE' });
  f.tracker.close();
  assert.equal(f.read().phase, 'responding');
  assert.ok(f.read().reasoningCharacters > 0);
  assert.ok(!fs.readFileSync(path.join(f.job, 'progress.json'), 'utf8').includes('PRIVATE'));
  assert.equal(fs.statSync(path.join(f.job, 'progress.json')).mode & 0o777, 0o600);
});

test('tool lifecycle handles parallel tools, failures, duplicate events and safe numeric progress', t => {
  const f = fixture(t);
  f.event('tool.updated', { kind: 'scheduled', toolCallId: 'read1', toolName: 'Read', input: { secret: 'PRIVATE_INPUT' } });
  f.event('tool.updated', { kind: 'started', toolCallId: 'read1' });
  f.event('tool.updated', { kind: 'started', toolCallId: 'bash1', toolName: 'Bash' });
  assert.equal(f.read().tools.active, 2);
  f.event('tool.updated', { kind: 'progress', toolCallId: 'bash1', elapsedMs: 500, stdoutBytes: 80, stdoutTail: 'PRIVATE_OUTPUT' });
  f.tracker.close();
  assert.equal(f.read().tools.current.find(x => x.id === 'bash1').stdoutBytes, 80);
  f.event('tool.updated', { kind: 'result', toolCallId: 'read1', result: { success: true, content: 'PRIVATE_RESULT' }, duration: 7 });
  f.event('tool.updated', { kind: 'result', toolCallId: 'read1', result: { success: true } });
  f.event('tool.updated', { kind: 'started', toolCallId: 'read1' });
  f.event('tool.updated', { kind: 'result', toolCallId: 'bash1', result: { success: false, error: 'PRIVATE_ERROR' } });
  f.event('tool.updated', { kind: 'error', toolCallId: 'edit1', toolName: 'Edit', error: { message: 'PRIVATE_ERROR' } });
  const p = f.read();
  assert.equal(p.phase, 'waiting_for_model');
  assert.equal(p.tools.total, 3); assert.equal(p.tools.active, 0);
  assert.equal(p.tools.completed, 1); assert.equal(p.tools.failed, 2);
  assert.deepEqual(p.tools.byName.Read, { total: 1, completed: 1, failed: 0 });
  assert.equal(p.tools.lastCompleted.name, 'Edit');
  assert.ok(!JSON.stringify(p).includes('PRIVATE'));
});

test('replayed events and other sessions cannot inflate counts or freshness', t => {
  const f = fixture(t);
  f.event('model.streaming', { kind: 'reasoning_delta', delta: '123' }); f.tracker.close();
  f.advance(9000);
  f.event('model.streaming', { kind: 'reasoning_delta', delta: '123' }, { seq: 1 });
  f.event('tool.updated', { kind: 'started', toolCallId: 'foreign', toolName: 'Read' }, { sessionId: 'sess_other' });
  assert.equal(f.read().reasoningCharacters, 3); assert.equal(f.read().idleSeconds, 9);
  assert.equal(f.read().tools.total, 0);
});

test('permission blockers are visible without approval contents or automatic approval', t => {
  const f = fixture(t);
  f.event('permission.requested', { requestId: 'p1', toolCallId: 'read1', toolName: 'Read', input: 'PRIVATE_PERMISSION' });
  assert.equal(f.read().phase, 'blocked'); assert.equal(f.read().pendingInteractions, 1);
  f.event('model.streaming', { kind: 'reasoning_delta', delta: '123' }); f.tracker.close();
  assert.equal(f.read().phase, 'blocked');
  f.event('permission.resolved', { requestId: 'p1', decision: 'deny' });
  assert.equal(f.read().phase, 'waiting_for_model');
  f.tracker.blocked('session/requestPermission');
  assert.equal(f.read().hostInteractionRequired, true);
  assert.equal(f.read().phase, 'blocked');
  assert.ok(!JSON.stringify(f.read()).includes('PRIVATE'));
});

test('terminal status preserves progress and old, missing or corrupt files report unknown', t => {
  const f = fixture(t);
  f.event('tool.updated', { kind: 'result', toolCallId: 'read1', toolName: 'Read', result: { success: true } });
  f.tracker.finish();
  assert.equal(f.read().phase, 'completed'); assert.equal(f.read().tools.completed, 1);
  f.tracker.finish(true); assert.equal(f.read().phase, 'failed');
  fs.writeFileSync(path.join(f.job, 'progress.json'), '{broken'); assert.equal(f.read(), null);
  fs.writeFileSync(path.join(f.job, 'progress.json'), '{"schema":1,"jobId":"other"}'); assert.equal(f.read(), null);
  fs.unlinkSync(path.join(f.job, 'progress.json')); assert.equal(f.read(), null);
});
