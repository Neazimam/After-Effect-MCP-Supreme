// Acts like an AI client: node scripts/smoke-test.mjs [clientName]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const name = process.argv[2] || 'smoke-test';
const port = process.env.AE_MCP_PORT || 7654;
const client = new Client({ name, version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

const { tools } = await client.listTools();
console.log(`[${name}] ${tools.length} tools:`, tools.map((t) => t.name).join(', '));

const run = async (tool, args = {}) => {
  const r = await client.callTool({ name: tool, arguments: args });
  console.log(`\n> ${tool}${r.isError ? '  (ERROR)' : ''}\n${r.content[0].text.slice(0, 300)}`);
};
await run('ae_status');
await run('ae_get_project');
await run('ae_add_layer', { type: 'text', text: 'Hello', fontSize: 120, color: '#ff3366' });
await run('ae_set_property', { layer: 1, path: 'Transform/Nope', value: 1 });   // exercises the error path
await run('ae_execute_script', { code: 'return app.project.numItems;' });
await client.close();
