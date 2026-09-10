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
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';

/**
 * Secret -> principal, so one deployment can serve several people with
 * different tool access, not just one shared secret for everyone. Set
 * TELLER_SECRETS as JSON: {"<secret for Kevin>":"U01KEVIN", "<secret for
 * Charlotte>":"U02CHARLOTTE"}. TELLER_SHARED_SECRET/TELLER_MCP_PRINCIPAL
 * still work as a single legacy pair, merged in underneath - existing
 * connector configs (the shared invoice-creator secret) keep working
 * unchanged.
 */
function secretMap(): Record<string, string> {
  const map: Record<string, string> = {};
  if (process.env.TELLER_SHARED_SECRET && process.env.TELLER_MCP_PRINCIPAL) {
    map[process.env.TELLER_SHARED_SECRET] = process.env.TELLER_MCP_PRINCIPAL;
  }
  if (process.env.TELLER_SECRETS) {
    try {
      Object.assign(map, JSON.parse(process.env.TELLER_SECRETS));
    } catch {
      // Malformed JSON must not silently drop the whole map - fail closed on
      // the whole thing rather than serving a partial, surprising subset.
      return {};
    }
  }
  return map;
}

function principalFor(req: Request): string | null {
  const map = secretMap();
  if (Object.keys(map).length === 0) return null; // fail closed: nothing configured means nobody gets in

  // Claude's custom-connector UI only allows a fixed set of standard header
  // names - a custom one like x-teller-secret isn't on that list, so
  // Authorization: Bearer is the actual credential path from there.
  // x-teller-secret stays supported for the smoke-test script and any other
  // caller that isn't UI-restricted.
  const bearer = req.headers.get('authorization');
  const bearerToken = bearer?.startsWith('Bearer ') ? bearer.slice(7) : null;
  const token = req.headers.get('x-teller-secret') ?? bearerToken;
  if (!token) return null;
  return map[token] ?? null;
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
  const principal = principalFor(req);
  const server = buildServer(principal);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return transport.handleRequest(req);
};

export const config = { path: '/mcp' };
