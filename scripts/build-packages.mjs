#!/usr/bin/env node
// Generate thin host manifests from one identity and one execution core.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugins/agent-bridge/', import.meta.url));
const identity = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const { $schema, ...metadata } = identity;
const write = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
};
const server = host => ({ command: '${CLAUDE_PLUGIN_ROOT}/scripts/launch-mcp', env: { AGENT_BRIDGE_HOST: host } });
// Common file is also read by Claude/Z Code; inline host entries replace it.
write('mcp/codex.json', { mcpServers: { agent_bridge: { command: './scripts/launch-mcp', cwd: '.', env: { AGENT_BRIDGE_HOST: 'codex' },
  env_vars: ['PATH', 'HOME', 'CODEX_MCP_NODE_PATH', 'AGENT_BRIDGE_NODE_PATH'], startup_timeout_sec: 10, tool_timeout_sec: 60 } } });
write('.mcp.json', { mcpServers: { agent_bridge: server('generic') } });
write('mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: { agent_bridge: { type: 'stdio', command: './scripts/launch-mcp', env: { AGENT_BRIDGE_HOST: 'codex' } } } });
write('.codex-plugin/plugin.json', { ...metadata, skills: './skills/', mcpServers: './mcp/codex.json', interface: {
  displayName: 'Agent Bridge', shortDescription: '当前宿主调度 Z Code、Claude Code、Hermes，明确模型和发送范围。',
  longDescription: 'Host-led worker selection, destination preflight, async execution and independent acceptance.',
  developerName: metadata.author.name, category: 'Productivity', capabilities: ['Read', 'Write'],
  defaultPrompt: '使用 Agent Bridge 完成任务，由当前宿主选择 worker 和模型，核对目的地授权后执行并验收。' } });
for (const host of ['claude', 'zcode']) write(`.${host}-plugin/plugin.json`, {
  ...metadata, skills: './skills/', mcpServers: { agent_bridge: server(host) },
});
console.log('Generated Codex, Claude Code, Z Code and portable manifests.');
