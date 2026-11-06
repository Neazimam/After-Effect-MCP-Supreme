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
  return r;
};
await run('ae_status');
await run('ae_get_project');
await run('ae_add_layer', { type: 'text', text: 'Hello', fontSize: 120, color: '#ff3366' });
await run('ae_set_property', { layer: 1, path: 'Transform/Nope', value: 1 });   // exercises the error path
await run('ae_execute_script', { code: 'return app.project.numItems;' });
await run('ae_html_to_layers', {
  html: `<style>
    body { margin:0; background:#0f1020 }
    .title { position:absolute; left:560px; top:400px; width:800px; font:700 110px Arial; color:#ffffff; text-align:center; animation:pop 2s ease-out infinite }
    .ball { position:absolute; left:860px; top:600px; width:200px; height:200px; border-radius:50%; background:linear-gradient(90deg,#ff3366,#6600ff); box-shadow:8px 16px 24px rgba(0,0,0,.5); animation:roll 3s linear infinite }
    @keyframes pop { 0% { transform:scale(.5); opacity:0 } 100% { transform:scale(1); opacity:1 } }
    @keyframes roll { 0% { transform:translateX(0) } 100% { transform:translateX(500px) } }
  </style>
  <div class="title">SUPREME</div><div class="ball"></div>`,
  compName: 'Smoke HTML', duration: 6, frameRate: 30,
});
await run('ae_viewport');
await client.close();
