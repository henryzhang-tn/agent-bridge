import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKERS = ['zcode', 'claude', 'codex', 'hermes'];
export function entryFor(worker) {
  if (worker === 'zcode') return process.env.ZCODE_WORKER_ENTRY || '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
  if (worker === 'codex') {
    if (process.env.CODEX_WORKER_ENTRY) return process.env.CODEX_WORKER_ENTRY;
    const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    if (fs.existsSync(bundled)) return bundled;
    const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'codex'));
    return candidates.find(p => fs.existsSync(p)) || candidates[0];
  }
  if (worker === 'hermes') return process.env.HERMES_WORKER_PYTHON || path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/python');
  if (worker !== 'claude') throw new Error('Unknown worker: ' + worker);
  if (process.env.CLAUDE_WORKER_ENTRY) return process.env.CLAUDE_WORKER_ENTRY;
  const candidates = (process.env.PATH || '').split(path.delimiter).map(p => path.join(p, 'claude'));
  candidates.push(path.join(os.homedir(), '.local/bin/claude'));
  const nvm = path.join(os.homedir(), '.nvm/versions/node');
  if (fs.existsSync(nvm)) {
    candidates.push(...fs.readdirSync(nvm).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(v => path.join(nvm, v, 'bin/claude')));
  }
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}
export function workers() {
  return WORKERS.map(worker => {
    const entry = entryFor(worker);
    return { worker, installed: !!entry && fs.existsSync(entry), entry,
      runtime: { zcode: 'Z Code app-server', claude: 'Claude Code headless CLI with configured third-party inference',
        codex: 'Codex CLI app-server with its configured model provider', hermes: 'Installed Hermes AIAgent runtime in an isolated job profile' }[worker],
      modes: ['plan', 'edit'] };
  });
}
