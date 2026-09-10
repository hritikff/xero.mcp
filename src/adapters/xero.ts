// One Xero connection per (entity, mode), with the access token cached for its
// 30-minute life. Shared by the server and scripts/connect-check.js.
import { XeroClient } from 'xero-node';

export type Mode = 'read' | 'write';
type Conn = { client: XeroClient; tenantId: string; shortCode?: string; expiresAt: number };

const cache = new Map<string, Conn>();

// Production reads XERO_TECH_NATION_WRITE_CLIENT_ID etc. from Secret Manager.
// The PoC has one Demo Company connection, so every key falls back to it.
function creds(entity: string, mode: Mode) {
  const p = `XERO_${entity.toUpperCase().replace(/-/g, '_')}_${mode.toUpperCase()}_`;
  const clientId = process.env[p + 'CLIENT_ID'] ?? process.env.XERO_CLIENT_ID;
  const clientSecret = process.env[p + 'CLIENT_SECRET'] ?? process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`no Xero credentials for ${entity}:${mode}`);
  return { clientId, clientSecret };
}

export async function xero(entity: string, mode: Mode): Promise<Conn> {
  const key = `${entity}:${mode}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit;

  const client = new XeroClient({ ...creds(entity, mode), grantType: 'client_credentials', httpTimeout: 20_000 });
  const token = await client.getClientCredentialsToken();
  await client.updateTenants(false);
  const tenantId = client.tenants[0].tenantId;
  // Org shortCode builds the go.xero.com deep link the tracker needs (stage 7).
  // One call per connection lifetime, cached with the token.
  let shortCode: string | undefined;
  try {
    shortCode = (await client.accountingApi.getOrganisations(tenantId)).body.organisations?.[0]?.shortCode;
  } catch { /* deep links are a convenience, not a precondition */ }

  const conn = { client, tenantId, shortCode, expiresAt: Date.now() + Number(token.expires_in) * 1000 };
  cache.set(key, conn);
  return conn;
}

/** C2 drives backoff from these. Present on every Xero response, including 429s. */
export function limits(res: any) {
  const h = res?.headers ?? {};
  return {
    day: h['x-daylimit-remaining'],
    minute: h['x-minlimit-remaining'],
    appMinute: h['x-appminlimit-remaining'],
    problem: h['x-rate-limit-problem'],
    retryAfter: h['retry-after'],
  };
}

/** The SDK rejects with { response, body }, not an Error. Make it loggable. */
export function xeroError(e: any) {
  if (!e?.response) return { message: e?.message ?? String(e) };
  return { status: e.response.status, limits: limits(e.response), body: e.body ?? e.response.data };
}
