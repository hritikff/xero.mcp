// Standalone smoke test: drives the deployed Netlify MCP endpoint exactly
// like a real client (Claude Desktop included) would - initialize, list
// tools, call one read-only tool. Run with:
//   TELLER_SHARED_SECRET=... node scripts/test-mcp-client.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TELLER_MCP_URL ?? 'https://xero-mcp.netlify.app/mcp';
const secret = process.env.TELLER_SHARED_SECRET;
if (!secret) {
  console.error('Set TELLER_SHARED_SECRET in the environment first.');
  process.exit(1);
}

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { 'x-teller-secret': secret } },
});
const client = new Client({ name: 'teller-smoke-test', version: '1.0.0' });

await client.connect(transport);
console.log('connected:', client.getServerVersion());

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name));

const result = await client.callTool({ name: 'list_tax_rates', arguments: { entity: 'ff-events' } });
console.log('list_tax_rates result:', JSON.stringify(result, null, 2).slice(0, 500));

await client.close();
