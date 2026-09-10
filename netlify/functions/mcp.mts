// The MCP door, standalone. Same INTENTS registry, same authorize(), same
// audit table as the original repo's REST door - this file's only job is
// protocol + platform translation. See src/core/intents.ts for the actual
// logic; nothing here duplicates it.
//
// AUTH — read before deploying. Cloud Run's IAM (--no-allow-unauthenticated,
// per-caller run.invoker) has NO Netlify equivalent, and there is no
// Google-issued OIDC token to verify here even if there were. Once this URL
// is public, anyone who finds it can call it unless something checks first.
// This is that check: a per-caller shared secret, fail-closed if unset.
// Replace before this holds anything beyond Demo Company data - it is a
// PoC-grade gate, not a real identity system.
import { INTENTS } from '../../src/core/intents.ts';
import { authorize } from '../../src/core/rbac.ts';
import { PRINCIPALS, GRANTS } from '../../src/core/policy.ts';
import * as audit from '../../src/core/audit.ts';
import { q } from '../../src/core/db.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID, createHash } from 'node:crypto';

/**
 * Legacy fallback only: env-configured secret(s), from before per-person
 * tokens existed. TELLER_SECRETS is a JSON map {secret: principal};
 * TELLER_SHARED_SECRET/TELLER_MCP_PRINCIPAL is a single legacy pair, merged
 * in underneath. Kept so nothing already wired this way breaks - but the
 * real path for a new person is scripts/issue-mcp-token.js, not this.
 */
function legacySecretMap(): Record<string, string> {
  const map: Record<string, string> = {};
  if (process.env.TELLER_SHARED_SECRET && process.env.TELLER_MCP_PRINCIPAL) {
    map[process.env.TELLER_SHARED_SECRET] = process.env.TELLER_MCP_PRINCIPAL;
  }
  if (process.env.TELLER_SECRETS) {
    try { Object.assign(map, JSON.parse(process.env.TELLER_SECRETS)); }
    catch { /* malformed JSON must not silently drop the whole map */ return {}; }
  }
  return map;
}

/**
 * Per-person credentials (migrations/010_mcp_tokens.sql). Each token is its
 * own row, hashed at rest, mapped to a policy.ts principal and a human
 * label - issued and revoked independently via scripts/issue-mcp-token.js
 * and scripts/revoke-mcp-token.js, without a redeploy. This is the real
 * identity path; legacySecretMap() above is only a fallback for whatever
 * was wired before this table existed.
 */
async function principalFor(req: Request): Promise<string | null> {
  const bearer = req.headers.get('authorization');
  const bearerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
  // Claude's custom-connector UI only allows a fixed set of standard header
  // names - a custom one like x-teller-secret isn't on that list, so
  // Authorization: Bearer is the actual credential path from there.
  // x-teller-secret stays supported for the smoke-test script and any other
  // caller that isn't UI-restricted.
  const token = req.headers.get('x-teller-secret') ?? bearerToken;
  if (!token) return null;

  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await q<{ principal: string }>(
    `SELECT principal FROM teller.mcp_token WHERE token_hash = $1 AND revoked_at IS NULL`, [hash],
  );
  if (row) {
    // Best-effort - a slow or failed timestamp bump must never block the
    // actual request.
    q(`UPDATE teller.mcp_token SET last_used_at = now() WHERE token_hash = $1`, [hash]).catch(() => {});
    return row.principal;
  }

  return legacySecretMap()[token] ?? null;
}

function buildServer(principal: string | null): McpServer {
  const server = new McpServer({ name: 'teller', version: '1.0.0' });

  // Tool visibility follows the grant, not just call-time enforcement - an
  // unauthenticated or narrowly-scoped caller does not even see a tool it
  // cannot use. Empty for a null principal: no credential, no tool list.
  const role = principal ? PRINCIPALS[principal]?.role : undefined;
  const allowed = new Set(role ? GRANTS[role] : []);

  for (const [name, intent] of Object.entries(INTENTS)) {
    if (!allowed.has(name)) continue;

    server.registerTool(
      name,
      {
        description: `[role: ${role}] ${name}`,
        inputSchema: intent.schema.shape,
        annotations: {
          readOnlyHint: intent.annotations.readOnly,
          destructiveHint: intent.annotations.destructive,
          idempotentHint: intent.annotations.idempotent,
          openWorldHint: intent.annotations.openWorld,
        },
      },
      async (args) => {
        const requestId = randomUUID();
        const started = Date.now();

        // principal is non-null here: allowed is empty (so this callback
        // would never have been registered) whenever principal is null.
        const base = {
          requestId, ts: new Date().toISOString(), principal: principal!, intent: name,
          entity: (args as { entity?: string })?.entity, argsSha256: audit.hash(args),
        };

        const decision = authorize(principal!, name, args);
        await audit.write({
          ...base, eventType: 'DECISION',
          decision: decision.allow ? 'ALLOW' : 'DENY',
          role: decision.allow ? decision.role : undefined,
          reason: decision.allow ? undefined : decision.reason,
          args,
        });

        if (!decision.allow) {
          return { isError: true, content: [{ type: 'text', text: `${decision.status}: ${decision.reason}` }] };
        }

        try {
          const result = await intent.handler(args, { principal: principal!, role: decision.role, requestId });
          await audit.write({ ...base, eventType: 'OUTCOME', role: decision.role, httpStatus: 200, latencyMs: Date.now() - started });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (e: any) {
          const status = e?.statusCode ?? 502;
          await audit.write({ ...base, eventType: 'OUTCOME', role: decision.role, httpStatus: status, latencyMs: Date.now() - started, reason: e?.message });
          return { isError: true, content: [{ type: 'text', text: `${status}: ${e?.message ?? 'upstream failed'}` }] };
        }
      },
    );
  }
  return server;
}

export default async (req: Request): Promise<Response> => {
  // Stateless, same as the Node door: one server + transport per request, no
  // session held across invocations - matches a serverless function's own
  // lifecycle rather than fighting it.
  const principal = await principalFor(req);
  const server = buildServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
};

export const config = { path: '/mcp' };
