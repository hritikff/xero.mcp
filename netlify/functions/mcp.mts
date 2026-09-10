// The MCP door, standalone. Same INTENTS registry, same authorize(), same
// audit table as the original repo's REST door - this file's only job is
// protocol + platform translation. See src/core/intents.ts for the actual
// logic; nothing here duplicates it.
//
// AUTH — read before deploying. Cloud Run's IAM (--no-allow-unauthenticated,
// per-caller run.invoker) has NO Netlify equivalent, and there is no
// Google-issued OIDC token to verify here even if there were. Once this URL
// is public, anyone who finds it can call it unless something checks first.
// This is that check: a single shared-secret header, fail-closed if unset.
// Replace before this holds anything beyond Demo Company data - it is a
// PoC-grade gate, not a real identity system.
import { INTENTS } from '../../src/core/intents.ts';
import { authorize } from '../../src/core/rbac.ts';
import * as audit from '../../src/core/audit.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';

function principalFor(req: Request): string | null {
  const secret = process.env.TELLER_SHARED_SECRET;
  if (!secret) return null; // fail closed: unset means nobody gets in, not everybody
  if (req.headers.get('x-teller-secret') !== secret) return null;
  // One shared secret = one principal for the whole deployment, by design -
  // there is no per-caller identity without a real auth system. Whoever holds
  // the secret IS this principal. Keep the role this maps to as narrow as
  // the deployment's actual purpose, in src/core/policy.ts.
  return process.env.TELLER_MCP_PRINCIPAL ?? null;
}

function buildServer(principal: string | null): McpServer {
  const server = new McpServer({ name: 'teller', version: '1.0.0' });

  for (const [name, intent] of Object.entries(INTENTS)) {
    server.registerTool(
      name,
      {
        description: `[role: ${intent.annotations.readOnly ? 'any read role' : 'explicit write grant required'}] ${name}`,
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

        if (!principal) {
          return { isError: true, content: [{ type: 'text', text: 'unauthenticated: missing or wrong x-teller-secret' }] };
        }

        const base = {
          requestId, ts: new Date().toISOString(), principal, intent: name,
          entity: (args as { entity?: string })?.entity, argsSha256: audit.hash(args),
        };

        const decision = authorize(principal, name, args);
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
          const result = await intent.handler(args, { principal, role: decision.role, requestId });
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
