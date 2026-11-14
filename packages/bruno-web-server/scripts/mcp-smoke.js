/**
 * Smoke test for narado's MCP server, using the MCP SDK's client against a running server.
 *
 *   node packages/bruno-web-server/scripts/mcp-smoke.js <workspace-path> [request]
 *
 * Needs a personal token created in narado (Git section, MCP tokens) in $NARADO_MCP_TOKEN.
 */
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const url = process.env.NARADO_MCP_URL || 'http://127.0.0.1:4100/mcp';
const token = process.env.NARADO_MCP_TOKEN;
if (!token) {
  console.error('Set NARADO_MCP_TOKEN to a token created in narado (Git section, MCP tokens).');
  process.exit(1);
}

const show = (label, result) => {
  const body = result.content && result.content[0] ? result.content[0].text : JSON.stringify(result);
  console.log(`\n=== ${label}${result.isError ? ' (error)' : ''}\n${body.length > 1500 ? body.slice(0, 1500) + '\n…' : body}`);
};

(async () => {
  // Without a token: must be refused.
  const anon = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  console.log(`no token -> ${anon.status}`);
  const fromPage = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  console.log(`browser origin -> ${fromPage.status}`);

  const client = new Client({ name: 'narado-smoke', version: '0.0.1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.map((t) => t.name).join(', ')}`);

  const [workspace, request] = process.argv.slice(2);
  show('list_workspaces', await client.callTool({ name: 'list_workspaces', arguments: {} }));
  if (!workspace) return client.close();
  show('list_requests', await client.callTool({ name: 'list_requests', arguments: { workspace } }));
  show('list_environments', await client.callTool({ name: 'list_environments', arguments: { workspace } }));
  if (request) {
    show('get_request', await client.callTool({ name: 'get_request', arguments: { workspace, request } }));
    show('send_request', await client.callTool({ name: 'send_request', arguments: { workspace, request, environment: 'Production', params: { paymentId: 'pay_from_mcp' } } }));
  }
  const names = tools.tools.map((t) => t.name);
  console.log(`\nwrite tools offered: ${['update_request', 'save_changes'].filter((n) => names.includes(n)).join(', ') || 'none (read-only server)'}`);
  await client.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
