// Cloud Run entrypoint. netlify/functions/mcp.mts's default export is already
// a pure Fetch-API handler, (req: Request) => Promise<Response>, with zero
// Netlify-specific APIs used anywhere in it — so this is a thin adapter from
// Node's http.IncomingMessage/ServerResponse to that same handler, not a
// second implementation. The MCP door's actual logic lives in exactly one
// place regardless of which platform is running it.
//
// Every response observed from this server, on Netlify or here, has been a
// single complete event then close — never an open multi-event stream — so
// buffering the full body is what actually happens today, not a shortcut
// that loses something a real stream would have needed.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import mcpHandler from './netlify/functions/mcp.mts';

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
    for await (const chunk of req) chunks.push(chunk as Buffer);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const val of Array.isArray(v) ? v : [v]) headers.append(k, val);
  }
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const body = Buffer.from(await response.arrayBuffer());
  headers['content-length'] = String(body.length);
  res.writeHead(response.status, headers);
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const webReq = await toWebRequest(req);
    const webRes = await mcpHandler(webReq);
    await writeWebResponse(webRes, res);
  } catch (e: any) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`internal error: ${e?.message ?? e}`);
  }
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => console.log(`teller-mcp listening on :${port}`));
