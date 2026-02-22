#!/usr/bin/env node
// ── MCP Server Entry Point ────────────────────────────────────────────────
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { registerPrompts } from './prompts.js';

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'agentrem',
    version: '0.1.0',
  });

  registerTools(server);
  registerResources(server);
  registerPrompts(server);

  return server;
}

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main if this file is the entry point
const isMain = process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts');
if (isMain) {
  main().catch((err) => {
    console.error('MCP server error:', err);
    process.exit(1);
  });
}
