import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const MAX_FILES = 20000, MAX_FILE = 16 * 1024 * 1024, MAX_BYTES = 64 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = value => hash(stable(value));
const reserved = rel => rel.split('/').some(p => p === '.ai' || p === '.git');
const inside = (file, scopes) => scopes.some(s => s === '.' || file === s || file.startsWith(s + '/'));
function id(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid workspace or operation ID'); return value; }
function relative(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\') || value.includes('\0') || value.split('/').includes('..')) throw new Error('Unsafe relative source path');
  const rel = path.posix.normalize(value);
  if (reserved(rel)) throw new Error('Reserved source path');
  return rel;
}
function canonical(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Expected absolute directory');
  const real = fs.realpathSync(value);
  if (!fs.statSync(real).isDirectory()) throw new Error('Expected directory');
  return real;
}
function safePath(root, rel, missing = true) {
  rel = relative(rel); let at = root;
  for (const part of rel === '.' ? [] : rel.split('/')) {
    at = path.join(at, part);
    try { const s = fs.lstatSync(at); if (s.isSymbolicLink()) throw new Error('Source symlinks are unsupported'); }
    catch (e) { if (missing && ['ENOENT', 'ENOTDIR'].includes(e.code)) return path.join(root, rel); throw e; }
  }
  return path.join(root, rel);
}
function directory(value) {
  const parent = path.dirname(value);
  if (!fs.existsSync(parent)) directory(parent);
  if (fs.existsSync(value)) { const s = fs.lstatSync(value); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('Metadata directory must not be a symlink'); }
  else fs.mkdirSync(value, { mode: 0o700 });
  return value;
}
function read(file) {
  const s = fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > MAX_BYTES) throw new Error('Invalid metadata file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function atomic(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Metadata symlink is forbidden');
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`; const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, stable(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function git(cwd, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' });
  try {
    return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.quotePath=true', ...args], { cwd, env, maxBuffer: MAX_BYTES * 2, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  } catch (error) { if (options.allowDifference && error.status === 1) return error.stdout; throw new Error(`Git operation failed: ${String(error.stderr || error.message).slice(0, 2000)}`); }
}
function repository(project) {
  project = canonical(project);
  const top = canonical(git(project, ['rev-parse', '--show-toplevel']).toString().trim());
  if (top !== project) throw new Error('Parallel work requires the Git project root');
  const common = canonical(path.resolve(project, git(project, ['rev-parse', '--git-common-dir']).toString().trim()));
  const base = git(project, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  return { project, repository_id: common, base_revision: base };
}
function goalLocation(project, goal) {
  if (!path.isAbsolute(goal)) throw new Error('Expected absolute goal path');
  goal = path.normalize(goal);
  if (path.dirname(goal) !== path.join(project, '.ai', 'goals')) throw new Error('Goal must belong to the project');
  id(path.basename(goal));
  for (const dir of [path.join(project, '.ai'), path.join(project, '.ai/goals'), goal]) directory(dir);
  if (canonical(goal) !== goal) throw new Error('Goal must use a canonical path');
  return goal;
}
function fileState(root, rel) {
  const file = safePath(root, rel);
  let s; try { s = fs.lstatSync(file); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
  if (s.isDirectory()) return null;
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Source contains a symlink or special file');
  if (s.size > MAX_FILE) throw new Error('Source file exceeds 16 MiB');
  const bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  if (s.ino !== after.ino || s.size !== after.size || s.mtimeMs !== after.mtimeMs) throw new Error('Source changed while snapshotting');
  return { digest: hash(bytes), mode: s.mode & 0o111 ? 0o755 : 0o644, size: bytes.length };
}
function scan(root, scopes = ['.']) {
  root = canonical(root); const entries = new Map(); let files = 0, bytes = 0;
  function walk(rel) {
    if (reserved(rel) || entries.has(rel)) return;
    if (++files > MAX_FILES) throw new Error('Source snapshot exceeds 20000 entries');
    const file = safePath(root, rel); let s;
    try { s = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') { entries.set(rel, null); return; } throw e; }
    if (s.isDirectory()) {
      entries.set(rel, { directory: true });
      for (const child of fs.readdirSync(file).sort()) walk(rel === '.' ? child : `${rel}/${child}`);
    } else {
      const state = fileState(root, rel); bytes += state.size;
      if (bytes > MAX_BYTES) throw new Error('Source snapshot exceeds 64 MiB');
      entries.set(rel, state);
    }
  }
  for (const rel of [...new Set(scopes.map(relative))].sort()) walk(rel);
  return Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));
}
function filesOnly(entries) { return Object.fromEntries(Object.entries(entries).filter(([, v]) => v && !v.directory)); }
function copyFiles(source, destination, entries) {
  directory(destination);
  for (const [rel, state] of Object.entries(entries)) {
    if (!state || state.directory) continue;
    const sourceFile = safePath(source, rel, false), file = safePath(destination, rel);
    directory(path.dirname(file)); fs.copyFileSync(sourceFile, file, fs.constants.COPYFILE_EXCL); fs.chmodSync(file, state.mode);
    if (stable(fileState(destination, rel)) !== stable(state)) throw new Error('Source changed while copying baseline');
  }
}
function trackedClean(project) {
  const tracked = git(project, ['diff', '--name-only', '-z', 'HEAD', '--']).toString().split('\0').filter(Boolean);
  const fresh = git(project, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean);
  if ([...tracked, ...fresh].some(rel => !reserved(rel))) throw new Error('Parallel goals require a clean Git starting point; commit existing changes or use the serial loop');
  // Git's stat cache and assume-unchanged flags must not hide unsaved source changes.
  for (const entry of git(project, ['ls-tree', '-r', '-z', 'HEAD']).toString().split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'), [mode, type, oid] = entry.slice(0, tab).split(' '), rel = entry.slice(tab + 1);
    if (reserved(rel)) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('Parallel goals require regular source files; submodules and tracked symlinks are unsupported');
    const state = fileState(project, rel);
    if (!state) throw new Error('Parallel goals require a clean Git starting point');
    const content = fs.readFileSync(safePath(project, rel, false));
    const object = createHash(oid.length === 64 ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (object !== oid || state.mode !== (mode === '100755' ? 0o755 : 0o644)) throw new Error('Parallel goals require exact committed source bytes and modes; commit changes or use the serial loop');
  }
}
export function inspectProject(project) {
  const info = repository(project); trackedClean(info.project);
  // Ignored files are intentionally not copied into new worktrees (for example .env and node_modules).
  return { ...info, base_fingerprint: hash(git(info.project, ['ls-tree', '-r', '-z', info.base_revision])) };
}
export function snapshotWorkspace(workspace, read_scope) {
  const root = typeof workspace === 'string' ? workspace : workspace.path;
  return digest(scan(root, read_scope));
}
function descriptor(value) {
  const root = canonical(typeof value === 'string' ? value : value.path);
  if (path.basename(path.dirname(root)) !== 'workspaces') throw new Error('Not a managed goal worktree');
  const goal = path.dirname(path.dirname(root)), project = path.dirname(path.dirname(path.dirname(goal)));
  goalLocation(project, goal);
  const record = read(path.join(goal, 'workspace-records', id(path.basename(root)), 'workspace.json'));
  if (record.path !== root || record.goal !== goal || record.project !== project || record.repository_id !== repository(root).repository_id || record.status !== 'ready') throw new Error('Workspace ownership metadata mismatch');
  return record;
}
function manifestValid(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length > MAX_FILES) throw new Error('Invalid artifact manifest');
  for (const [rel, state] of Object.entries(map)) {
    if (relative(rel) !== rel || rel === '.') throw new Error('Invalid artifact file path');
    if (state !== null && (!state || !/^[a-f0-9]{64}$/.test(state.digest) || ![0o644, 0o755].includes(state.mode) || !Number.isInteger(state.size) || state.size < 0 || state.size > MAX_FILE)) throw new Error('Invalid artifact file state');
  }
}
function matches(root, map) { return Object.entries(map).every(([rel, state]) => stable(fileState(root, rel)) === stable(state)); }
function validateArtifact(artifact) {
  if (!artifact || artifact.schema !== 1 || !Array.isArray(artifact.changed_files) || !Array.isArray(artifact.read_scope)) throw new Error('Invalid artifact');
  manifestValid(artifact.preimages); manifestValid(artifact.postimages);
  const names = [...artifact.changed_files].sort();
  if (stable(names) !== stable(Object.keys(artifact.preimages).sort()) || stable(names) !== stable(Object.keys(artifact.postimages).sort()) || new Set(names).size !== names.length) throw new Error('Artifact file manifests disagree');
  const patch = path.resolve(artifact.patch_path), dir = path.dirname(patch);
  if (!path.isAbsolute(artifact.patch_path) || canonical(dir) !== dir || fs.lstatSync(patch).isSymbolicLink()) throw new Error('Unsafe artifact path');
  const st = fs.statSync(patch); if (!st.isFile() || st.size > MAX_BYTES) throw new Error('Invalid artifact patch');
  const bytes = fs.readFileSync(patch);
  if (hash(bytes) !== artifact.patch_fingerprint) throw new Error('Artifact patch fingerprint changed');
  for (const side of ['before', 'after']) {
    const root = path.join(dir, side), map = artifact[side === 'before' ? 'preimages' : 'postimages'];
    if (canonical(root) !== root || !matches(root, map)) throw new Error('Artifact source content changed');
    if (stable(Object.keys(filesOnly(scan(root))).sort()) !== stable(Object.keys(map).filter(k => map[k] !== null).sort())) throw new Error('Artifact contains undeclared source files');
  }
  // Prove the patch changes exactly the declared bytes in an isolated scratch repository.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-patch-'));
  try {
    git(scratch, ['init', '--quiet']); copyFiles(path.join(dir, 'before'), scratch, artifact.preimages);
    if (bytes.length) git(scratch, ['apply', '--check', '--binary', '--', patch]);
    if (bytes.length) git(scratch, ['apply', '--binary', '--', patch]);
    if (!matches(scratch, artifact.postimages) || stable(Object.keys(filesOnly(scan(scratch))).sort()) !== stable(Object.keys(artifact.postimages).filter(k => artifact.postimages[k] !== null).sort())) throw new Error('Artifact patch does not match declared output');
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  return { patch, fingerprint: digest({ patch: artifact.patch_fingerprint, pre: artifact.preimages, post: artifact.postimages, base: artifact.base_revision }) };
}
function applyArtifact(root, artifact) {
  const valid = validateArtifact(artifact);
  if (!matches(root, artifact.preimages)) throw new Error('Artifact source preimage is stale or overlaps an earlier change');
  if (artifact.changed_files.length) {
    git(root, ['apply', '--check', '--binary', '--', valid.patch]);
    git(root, ['apply', '--binary', '--', valid.patch]);
  }
  if (!matches(root, artifact.postimages)) throw new Error('Applied artifact does not match its output fingerprint');
  return valid;
}
export function createWorkspace({ project, goal, workspace_id, base_revision, input_artifacts = [], artifacts }) {
  const info = repository(project); project = info.project; goal = goalLocation(project, goal); workspace_id = id(workspace_id);
  if (!/^[a-f0-9]{40,64}$/.test(base_revision)) throw new Error('Workspace base_revision must be an immutable commit ID');
  const resolved = git(project, ['rev-parse', '--verify', `${base_revision}^{commit}`]).toString().trim();
  if (resolved !== base_revision) throw new Error('Workspace base revision does not resolve exactly');
  input_artifacts = artifacts || input_artifacts;
  if (!Array.isArray(input_artifacts) || input_artifacts.length > 1000) throw new Error('Invalid workspace input artifacts');
  const input_fingerprints = input_artifacts.map(a => validateArtifact(a).fingerprint);
  const recordDir = directory(path.join(directory(path.join(goal, 'workspace-records')), workspace_id));
  const recordFile = path.join(recordDir, 'workspace.json'); const target = path.join(directory(path.join(goal, 'workspaces')), workspace_id);
  if (fs.existsSync(recordFile)) {
    const prior = read(recordFile);
    if (prior.base_revision !== base_revision || stable(prior.input_fingerprints) !== stable(input_fingerprints) || prior.repository_id !== info.repository_id) throw new Error('Workspace ID already has a different frozen baseline');
    if (prior.status !== 'ready') throw new Error('Workspace creation was interrupted; retain it for inspection and use a new attempt ID');
    return { ...descriptor(target), reused: true };
  }
  if (fs.existsSync(target)) throw new Error('Workspace path already exists without ownership metadata');
  const record = { schema: 1, status: 'creating', project, goal, workspace_id, path: target, base_revision, repository_id: info.repository_id, input_fingerprints, baseline_path: path.join(recordDir, 'base') };
  atomic(recordFile, record);
  // A configured checkout filter could execute code or rewrite the immutable baseline.
  const filterConfig = git(project, ['config', '--get-regexp', '^filter\\..*\\.(smudge|process)$'], { allowDifference: true }).toString().trim();
  if (filterConfig) throw new Error('Parallel worktree creation requires checkout filters to be disabled explicitly');
  git(project, ['worktree', 'add', '--detach', '--', target, base_revision]);
  for (const artifact of input_artifacts) {
    if (artifact.base_revision !== base_revision) throw new Error('Input artifact belongs to a different base revision');
    applyArtifact(target, artifact);
  }
  const entries = scan(target); copyFiles(target, record.baseline_path, entries);
  record.baseline_manifest = filesOnly(entries); record.baseline_fingerprint = digest(record.baseline_manifest); record.status = 'ready'; atomic(recordFile, record);
  return record;
}
export function collectArtifact({ workspace, allowed_edits, read_scope, output_dir }) {
  const record = descriptor(workspace), root = record.path;
  if (!Array.isArray(allowed_edits) || !Array.isArray(read_scope)) throw new Error('Artifact scopes must be arrays');
  allowed_edits = allowed_edits.map(relative); read_scope = read_scope.map(relative);
  if (allowed_edits.some(rel => !inside(rel, read_scope))) throw new Error('Artifact edit scope must be within read scope');
  const current = filesOnly(scan(root)), base = record.baseline_manifest;
  if (!matches(record.baseline_path, base) || digest(filesOnly(scan(record.baseline_path))) !== record.baseline_fingerprint) throw new Error('Workspace baseline changed');
  const changed_files = [...new Set([...Object.keys(base), ...Object.keys(current)])].filter(rel => stable(base[rel] || null) !== stable(current[rel] || null)).sort();
  if (changed_files.some(rel => !inside(rel, allowed_edits))) throw new Error('Workspace modified files outside the allowed edit scope');
  if (!path.isAbsolute(output_dir) || !output_dir.startsWith(record.goal + path.sep)) throw new Error('Artifact output must be inside its goal');
  output_dir = path.normalize(output_dir);
  if (!output_dir.startsWith(record.goal + path.sep)) throw new Error('Artifact output escapes its goal');
  let at = record.goal;
  for (const component of path.relative(record.goal, output_dir).split(path.sep)) { at = path.join(at, component); directory(at); }
  output_dir = canonical(output_dir);
  if (!output_dir.startsWith(record.goal + path.sep)) throw new Error('Artifact output escapes its goal');
  const priorFile = path.join(output_dir, 'artifact.json');
  if (fs.existsSync(priorFile)) {
    const prior = read(priorFile);
    if (prior.workspace !== root || prior.base_revision !== record.base_revision || prior.base_fingerprint !== record.baseline_fingerprint || stable(prior.allowed_edits) !== stable(allowed_edits) || stable(prior.read_scope) !== stable(read_scope) || stable(prior.changed_files) !== stable(changed_files) || prior.result_fingerprint !== snapshotWorkspace(root, read_scope)) throw new Error('Artifact output already has different submission content');
    validateArtifact(prior); return { ...prior, reused: true };
  }
  if (fs.readdirSync(output_dir).length) throw new Error('Artifact collection was interrupted; preserve the partial output for inspection and use a new submission ID');
  const before = directory(path.join(output_dir, 'a')), after = directory(path.join(output_dir, 'b'));
  const preimages = Object.fromEntries(changed_files.map(rel => [rel, base[rel] || null]));
  const postimages = Object.fromEntries(changed_files.map(rel => [rel, current[rel] || null]));
  copyFiles(record.baseline_path, before, preimages); copyFiles(root, after, postimages);
  // --no-index compares raw bytes, including ignored/new files, without staging or committing.
  const patch = git(output_dir, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--full-index', '--no-renames', '--no-prefix', '--', 'a', 'b'], { allowDifference: true });
  // Keep Git's own path quoting, including whitespace, Unicode and newline names.
  fs.renameSync(before, path.join(output_dir, 'before')); fs.renameSync(after, path.join(output_dir, 'after'));
  const text = patch.toString();
  if (stable(filesOnly(scan(root))) !== stable(current)) throw new Error('Workspace changed during artifact collection');
  const patch_path = path.join(output_dir, 'change.patch'); fs.writeFileSync(patch_path, text, { flag: 'wx', mode: 0o600 });
  const artifact = { schema: 1, workspace: root, base_revision: record.base_revision, base_fingerprint: record.baseline_fingerprint, result_fingerprint: snapshotWorkspace(root, read_scope), read_scope, allowed_edits, changed_files, patch_path, patch_fingerprint: hash(text), preimages, postimages };
  validateArtifact(artifact); atomic(path.join(output_dir, 'artifact.json'), artifact); return artifact;
}
function withLock(file, fn) {
  const token = randomBytes(16).toString('hex');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  for (let n = 0; n < 3; n++) {
    try { const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, stable({ pid: process.pid, token })); fs.closeSync(fd); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = read(file); if (!Number.isInteger(owner.pid) || owner.pid <= 1 || alive(owner.pid)) throw new Error('Repository integration is already running');
      const gate = file + '.recovery';
      try { fs.mkdirSync(gate); } catch { throw new Error('Repository integration lock recovery requires inspection'); }
      try { const current = read(file); if (current.pid === owner.pid && current.token === owner.token && !alive(current.pid)) fs.unlinkSync(file); }
      finally { fs.rmdirSync(gate); }
      if (n === 2) throw new Error('Could not acquire integration lock');
    }
  }
  try { return fn(); } finally { const owner = read(file); if (owner.token === token) fs.unlinkSync(file); }
}
function projectedIntegrationFingerprint(project, artifact, expected) {
  const entries = scan(project), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-integration-'));
  try {
    if (digest(entries) !== expected) throw new Error('Project source changed while preparing integration');
    git(scratch, ['init', '--quiet']);
    for (const [rel, state] of Object.entries(entries)) if (state?.directory && rel !== '.') directory(path.join(scratch, rel));
    copyFiles(project, scratch, entries);
    applyArtifact(scratch, artifact);
    if (snapshotWorkspace(project, ['.']) !== expected) throw new Error('Project source changed while preparing integration');
    return snapshotWorkspace(scratch, ['.']);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
export function integrateArtifact({ project, goal, operation_id, artifact, expected_fingerprint }) {
  const info = repository(project); project = info.project; goal = goalLocation(project, goal); operation_id = id(operation_id);
  const valid = validateArtifact(artifact);
  if (expected_fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(expected_fingerprint)) throw new Error('Invalid expected integration fingerprint');
  if (artifact.base_revision !== info.base_revision) throw new Error('Project HEAD changed since the artifact baseline');
  // All linked worktrees use the common repository's main .ai lock.
  if (path.basename(info.repository_id) !== '.git') throw new Error('Unsupported shared Git directory layout');
  const shared = directory(path.join(path.dirname(info.repository_id), '.ai'));
  const operationFile = path.join(directory(path.join(goal, 'integrations')), `${operation_id}.json`);
  const pendingFile = path.join(shared, 'integration-pending.json');
  const identity = digest({ project, goal, operation_id, artifact: valid.fingerprint, expected_fingerprint: expected_fingerprint || null });
  return withLock(path.join(shared, 'integration.lock'), () => {
    if (repository(project).base_revision !== artifact.base_revision) throw new Error('Project HEAD changed while acquiring the integration lock');
    const prior = fs.existsSync(operationFile) ? read(operationFile) : null;
    if (prior && prior.identity !== identity) throw new Error('Integration operation ID has different arguments');
    let current = snapshotWorkspace(project, ['.']);
    if (prior?.status === 'integrated') {
      if (current !== prior.source_after_fingerprint) throw new Error('Project source changed after integration; cannot reuse this result as the current source version');
      // Final record is authoritative if a crash interrupted pending-marker cleanup.
      if (fs.existsSync(pendingFile) && read(pendingFile).identity === identity) fs.unlinkSync(pendingFile);
      return { ...prior, reused: true };
    }
    let pending = fs.existsSync(pendingFile) ? read(pendingFile) : null;
    if (pending && pending.identity !== identity) throw new Error('Another integration is incomplete; reconcile its original operation first');
    if (!pending) {
      if (expected_fingerprint !== undefined && current !== expected_fingerprint) throw new Error('Project source fingerprint changed before integration; reconcile the foreign source change first');
      if (!matches(project, artifact.preimages)) throw new Error('Artifact source preimage is stale or overlaps an earlier change');
      const source_after_fingerprint = projectedIntegrationFingerprint(project, artifact, current);
      pending = { schema: 1, identity, operation_id, goal, project, artifact_fingerprint: valid.fingerprint, status: 'applying', changed_files: artifact.changed_files, source_before_fingerprint: current, source_after_fingerprint };
      atomic(pendingFile, pending); atomic(operationFile, pending);
    }
    current = snapshotWorkspace(project, ['.']);
    if (current !== pending.source_after_fingerprint) {
      if (current !== pending.source_before_fingerprint || !matches(project, artifact.preimages)) throw new Error('Integration has partial or external source changes; retained files require inspection before recovery');
      applyArtifact(project, artifact);
    }
    if (snapshotWorkspace(project, ['.']) !== pending.source_after_fingerprint) throw new Error('Project source changed during integration; inspect the retained pending operation');
    const result = { ...pending, status: 'integrated', result_fingerprint: snapshotWorkspace(project, artifact.read_scope), integrated_at: new Date().toISOString() };
    atomic(operationFile, result); fs.unlinkSync(pendingFile); return result;
  });
}
