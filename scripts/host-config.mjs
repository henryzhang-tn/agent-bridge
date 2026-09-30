#!/usr/bin/env node
// Print configuration only; never writes the user's host settings or credentials.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HOSTS } from '../plugins/agent-bridge/scripts/destination.mjs';

const [host, directory] = process.argv.slice(2);
if (!HOSTS.includes(host) || (directory && !path.isAbsolute(directory))) {
  process.stderr.write('Usage: node scripts/host-config.mjs codex|claude|zcode|hermes|generic [ABSOLUTE_PLUGIN_DIR]\n');
  process.exit(1);
}
const root = fs.realpathSync(directory || fileURLToPath(new URL('../plugins/agent-bridge/', import.meta.url)));
const server = { command: process.execPath, args: [path.join(root, 'scripts/mcp-server.mjs')], env: { AGENT_BRIDGE_HOST: host } };
console.log(JSON.stringify(host === 'hermes' ? { mcp_servers: { agent_bridge: server }, skills: { external_dirs: [path.join(root, 'skills')] } }
  : { mcpServers: { agent_bridge: server } }, null, 2));
