import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { inspectProject, createWorkspace, snapshotWorkspace, collectArtifact, integrateArtifact } from '../plugins/agent-bridge/scripts/goal-workspaces.mjs';
const git = (dir, args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function fixture(t) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-workspaces-')));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  git(project, ['init', '--quiet']); git(project, ['config', 'user.name', 'Fixture']); git(project, ['config', 'user.email', 'fixture@example.invalid']);
  fs.mkdirSync(path.join(project, 'src')); fs.writeFileSync(path.join(project, 'src/a.txt'), 'one\n'); fs.writeFileSync(path.join(project, 'src/b.txt'), 'two\n'); fs.writeFileSync(path.join(project, '.gitignore'), '.ai/\nignored/\n');
  git(project, ['add', '.']); git(project, ['commit', '--quiet', '-m', 'initial']);
  const info = inspectProject(project), goal = path.join(project, '.ai/goals/test');
  const workspace = (id, input_artifacts = []) => createWorkspace({ project, goal, workspace_id: id, base_revision: info.base_revision, input_artifacts });
  const artifact = (w, id, allowed_edits = ['src'], read_scope = ['src']) => collectArtifact({ workspace: w, allowed_edits, read_scope, output_dir: path.join(goal, 'artifacts', id) });
  const integrate = (a, id) => integrateArtifact({ project, goal, operation_id: id, artifact: a });
  return { project, goal, info, workspace, artifact, integrate };
}
test('isolated workspaces preserve index and collect binary, additions, deletions and executable modes', t => {
  const f = fixture(t), w = f.workspace('first');
  const index = fs.readFileSync(path.join(f.info.repository_id, 'index'));
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'new\r\nbytes\r\n'); fs.unlinkSync(path.join(w.path, 'src/b.txt'));
  fs.writeFileSync(path.join(w.path, 'src/new file.bin'), Buffer.from([0, 255, 4, 5])); fs.writeFileSync(path.join(w.path, 'src/run.sh'), '#!/bin/sh\n'); fs.chmodSync(path.join(w.path, 'src/run.sh'), 0o755);
  const a = f.artifact(w, 'one'); assert.deepEqual(a.changed_files, ['src/a.txt', 'src/b.txt', 'src/new file.bin', 'src/run.sh']);
  assert.equal(a.result_fingerprint, snapshotWorkspace(w, ['src'])); assert.deepEqual(fs.readFileSync(path.join(f.info.repository_id, 'index')), index);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'one\n');
  const result = f.integrate(a, 'one'); assert.equal(result.status, 'integrated');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'new\r\nbytes\r\n'); assert.equal(fs.existsSync(path.join(f.project, 'src/b.txt')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.project, 'src/new file.bin')), Buffer.from([0, 255, 4, 5])); assert.ok(fs.statSync(path.join(f.project, 'src/run.sh')).mode & 0o111);
  assert.deepEqual(fs.readFileSync(path.join(f.info.repository_id, 'index')), index); assert.equal(git(f.project, ['rev-parse', 'HEAD']), f.info.base_revision);
  assert.equal(f.integrate(a, 'one').reused, true);
  assert.equal(f.artifact(w, 'one').reused, true);
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'later');
  assert.throws(() => f.artifact(w, 'one'), /different submission/);
});
test('seeded dependency baseline emits only new task delta and keeps target uncommitted', t => {
  const f = fixture(t), w1 = f.workspace('one'); fs.writeFileSync(path.join(w1.path, 'src/a.txt'), 'dependency\n');
  const a = f.artifact(w1, 'one'); f.integrate(a, 'one');
  const w2 = f.workspace('two', [a]); assert.equal(fs.readFileSync(path.join(w2.path, 'src/a.txt'), 'utf8'), 'dependency\n');
  fs.writeFileSync(path.join(w2.path, 'src/b.txt'), 'dependent\n');
  const b = f.artifact(w2, 'two', ['src/b.txt']); assert.deepEqual(b.changed_files, ['src/b.txt']); f.integrate(b, 'two');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'dependency\n'); assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'dependent\n');
  assert.equal(f.workspace('two', [a]).reused, true);
  assert.throws(() => f.workspace('two'), /different frozen baseline/);
});
test('stale overlapping artifacts are rejected but disjoint results integrate', t => {
  const f = fixture(t), one = f.workspace('one'), two = f.workspace('two'), three = f.workspace('three');
  fs.writeFileSync(path.join(one.path, 'src/a.txt'), 'first\n'); fs.writeFileSync(path.join(two.path, 'src/a.txt'), 'second\n'); fs.writeFileSync(path.join(three.path, 'src/b.txt'), 'third\n');
  const a = f.artifact(one, 'one'), b = f.artifact(two, 'two'), c = f.artifact(three, 'three'); f.integrate(a, 'one');
  assert.throws(() => f.integrate(b, 'two'), /stale|overlap/); f.integrate(c, 'three'); assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'third\n');
});
test('snapshot binds contents, ignores metadata, and rejects symlink and special sources', t => {
  const f = fixture(t), w = f.workspace('one'); const before = snapshotWorkspace(w, ['src']);
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'ONE\n'); assert.notEqual(snapshotWorkspace(w, ['src']), before);
  fs.mkdirSync(path.join(w.path, '.ai')); fs.writeFileSync(path.join(w.path, '.ai/log'), 'ignored'); const snap = snapshotWorkspace(w, ['.']); fs.writeFileSync(path.join(w.path, '.ai/log'), 'changed'); assert.equal(snapshotWorkspace(w, ['.']), snap);
  fs.symlinkSync('/tmp', path.join(w.path, 'src/escape')); assert.throws(() => snapshotWorkspace(w, ['src']), /symlink/);
});
test('collect rejects scope violations, ignored output, changed baselines and escaping output paths', t => {
  const f = fixture(t), w = f.workspace('one'); fs.mkdirSync(path.join(w.path, 'ignored')); fs.writeFileSync(path.join(w.path, 'ignored/output.txt'), 'unexpected');
  assert.throws(() => f.artifact(w, 'ignored'), /outside.*scope/); fs.rmSync(path.join(w.path, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'change');
  assert.throws(() => collectArtifact({ workspace: w, allowed_edits: ['src'], read_scope: ['src'], output_dir: path.join(f.goal, '../escape') }), /inside|escapes/);
  fs.writeFileSync(path.join(w.baseline_path, 'src/a.txt'), 'tamper'); assert.throws(() => f.artifact(w, 'tamper'), /baseline changed/);
});
test('dirty projects reject parallel start, existing ignored files are not copied', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.project, 'ignored')); fs.writeFileSync(path.join(f.project, 'ignored/secret'), 'private');
  inspectProject(f.project); const w = f.workspace('one'); assert.equal(fs.existsSync(path.join(w.path, 'ignored')), false);
  fs.writeFileSync(path.join(f.project, 'untracked'), 'work'); assert.throws(() => inspectProject(f.project), /clean Git/); fs.unlinkSync(path.join(f.project, 'untracked'));
  git(f.project, ['update-index', '--assume-unchanged', 'src/a.txt']);
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'work'); assert.throws(() => inspectProject(f.project), /clean Git|exact committed/);
});
test('artifact tampering, wrong operation reuse, and shared repository lock fail closed', t => {
  const f = fixture(t), w = f.workspace('one'); fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'change\n'); const a = f.artifact(w, 'one');
  const lock = path.join(f.project, '.ai/integration.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  assert.throws(() => f.integrate(a, 'one'), /already running/); fs.unlinkSync(lock); f.integrate(a, 'one');
  assert.throws(() => f.integrate({ ...a, base_revision: '0'.repeat(40) }, 'one'), /HEAD changed/);
  fs.appendFileSync(a.patch_path, '\nmalformed'); assert.throws(() => f.integrate(a, 'two'), /fingerprint changed/);
});
test('crash after apply is reconciled from exact postimages without duplicate changes', t => {
  const f = fixture(t), w = f.workspace('one'); fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'change\n'); const a = f.artifact(w, 'one');
  const result = f.integrate(a, 'one'); const op = path.join(f.goal, 'integrations/one.json'); const pending = { ...result, status: 'applying' };
  delete pending.result_fingerprint; delete pending.integrated_at;
  fs.writeFileSync(op, JSON.stringify(pending)); fs.writeFileSync(path.join(f.project, '.ai/integration-pending.json'), JSON.stringify(pending));
  const recovered = f.integrate(a, 'one'); assert.equal(recovered.status, 'integrated'); assert.equal(fs.existsSync(path.join(f.project, '.ai/integration-pending.json')), false);
  fs.writeFileSync(path.join(f.project, '.ai/integration-pending.json'), JSON.stringify(pending));
  assert.equal(f.integrate(a, 'one').reused, true); assert.equal(fs.existsSync(path.join(f.project, '.ai/integration-pending.json')), false);
});
test('empty research artifact is valid and review workspace sees proposed changes without target mutation', t => {
  const f = fixture(t), w = f.workspace('one'); const empty = f.artifact(w, 'empty', []); assert.deepEqual(empty.changed_files, []); f.integrate(empty, 'empty');
  fs.writeFileSync(path.join(w.path, 'src/a.txt'), 'proposal\n'); const a = f.artifact(w, 'proposal'); const reviewer = f.workspace('review', [a]);
  assert.equal(fs.readFileSync(path.join(reviewer.path, 'src/a.txt'), 'utf8'), 'proposal\n'); assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt'), 'utf8'), 'one\n');
  const reviewArtifact = f.artifact(reviewer, 'review', []); assert.deepEqual(reviewArtifact.changed_files, []);
});

test('quoted paths and file to directory replacements preserve exact artifact bytes', t => {
  const f = fixture(t), w = f.workspace('one');
  fs.unlinkSync(path.join(w.path, 'src/a.txt')); fs.mkdirSync(path.join(w.path, 'src/a.txt'));
  fs.writeFileSync(path.join(w.path, 'src/a.txt/new\n文件 before.txt'), 'nested\n');
  const a = f.artifact(w, 'one'); f.integrate(a, 'one');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/a.txt/new\n文件 before.txt'), 'utf8'), 'nested\n');
});

test('shared-lock retry checks the original full source version before creating an intent', t => {
  const f = fixture(t), w = f.workspace('one'); fs.writeFileSync(path.join(w.path, 'src/b.txt'), 'proposal\n'); const a = f.artifact(w, 'one');
  const expected_fingerprint = snapshotWorkspace(f.project, ['.']);
  const args = { project: f.project, goal: f.goal, operation_id: 'one', artifact: a, expected_fingerprint };
  const lock = path.join(f.project, '.ai/integration.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'other' }));
  assert.throws(() => integrateArtifact(args), /already running/); fs.unlinkSync(lock);
  fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'foreign\n');
  assert.throws(() => integrateArtifact(args), /fingerprint changed/);
  assert.equal(fs.readFileSync(path.join(f.project, 'src/b.txt'), 'utf8'), 'two\n');
  assert.equal(fs.existsSync(path.join(f.project, '.ai/integration-pending.json')), false);
});
test('completed or pending integration replay cannot adopt changes outside its artifact', t => {
  const f = fixture(t), w = f.workspace('one'); fs.writeFileSync(path.join(w.path, 'src/b.txt'), 'proposal\n'); const a = f.artifact(w, 'one');
  const args = { project: f.project, goal: f.goal, operation_id: 'one', artifact: a, expected_fingerprint: snapshotWorkspace(f.project, ['.']) };
  const result = integrateArtifact(args); fs.writeFileSync(path.join(f.project, 'src/a.txt'), 'foreign\n');
  assert.throws(() => integrateArtifact(args), /source changed after/);
  const pending = { ...result, status: 'applying' };
  fs.writeFileSync(path.join(f.goal, 'integrations/one.json'), JSON.stringify(pending)); fs.writeFileSync(path.join(f.project, '.ai/integration-pending.json'), JSON.stringify(pending));
  assert.throws(() => integrateArtifact(args), /external source changes/);
});
