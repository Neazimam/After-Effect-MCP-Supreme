// Visual test driver: converts a rich HTML scene through the real MCP endpoint.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const port = process.env.AE_MCP_PORT || 7654;
const client = new Client({ name: 'visual-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

const html = `<style>
  body { margin:0; background:#101426 }
  .title { position:absolute; left:460px; top:200px; width:1000px; font:700 130px Arial; color:#ffffff; text-align:center; animation:pop 2s ease-out infinite }
  .sub { position:absolute; left:660px; top:400px; width:600px; font:400 40px Arial; color:#8ec5ff; text-align:center }
  .ball { position:absolute; left:300px; top:700px; width:180px; height:180px; border-radius:50%; background:linear-gradient(90deg,#ff3366,#6600ff); box-shadow:0 14px 30px rgba(0,0,0,.5) }
  .bar { position:absolute; left:700px; top:820px; width:520px; height:26px; background:#3ddc97; border-radius:13px; animation:grow 2.5s ease-in-out infinite }
  @keyframes pop { 0% { transform:scale(.4); opacity:0 } 100% { transform:scale(1); opacity:1 } }
  @keyframes grow { 0% { transform:scaleX(.2) } 100% { transform:scaleX(1) } }
</style>
<div class="title">SUPREME</div><div class="sub">html to layers</div><div class="ball"></div><div class="bar"></div>`;

const r = await client.callTool({ name: 'ae_html_to_layers', arguments: { html, compName: 'Visual Test', duration: 6, frameRate: 30 } });
console.log(r.content[0].text.slice(0, 500));
await client.close();
process.exit(0);
