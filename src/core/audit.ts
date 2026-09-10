// Two append-only events per call: DECISION before the side effect, OUTCOME
// after, correlated by requestId. Two rows rather than insert-then-update,
// because append-only is the property we claim - and Xero's own security
// standard requires immutable logs retained a minimum of one year.
import { createHash } from 'node:crypto';
import { q } from './db.ts';

export type AuditEvent = {
  requestId: string;
  eventType: 'DECISION' | 'OUTCOME';
  principal: string;
  role?: string;
  intent: string;
  entity?: string;
  decision?: 'ALLOW' | 'DENY';
  reason?: string;
  args?: unknown;
  argsSha256: string;
  httpStatus?: number;
  latencyMs?: number;
  warnings?: unknown;
  rateLimits?: unknown;
  claimKey?: string;
};

const INLINE_CAP = 64 * 1024; // beyond this, args spill to GCS and args_uri points at it

/**
 * Synchronous and in the request path. If this throws, the caller MUST fail the
 * request: an unauditable write must not happen. The Cloud Logging line stays as
 * a convenience copy for BigQuery - it is no longer the system of record.
 */
export async function write(e: AuditEvent): Promise<void> {
  const json = JSON.stringify(e.args ?? null);
  const oversized = json.length > INLINE_CAP;

  await q(
    `INSERT INTO teller.audit_event
       (request_id, event_type, principal, role, intent, entity, decision, reason,
        args, args_sha256, args_uri, http_status, latency_ms, warnings, rate_limits, claim_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [e.requestId, e.eventType, e.principal, e.role ?? null, e.intent, e.entity ?? null,
     e.decision ?? null, e.reason ?? null,
     oversized ? null : json, e.argsSha256,
     // ponytail: GCS spill lands with the pipeline. Until then an oversized
     // payload keeps its hash, so truncation stays detectable.
     oversized ? 'pending:gcs' : null,
     e.httpStatus ?? null, e.latencyMs ?? null,
     e.warnings ? JSON.stringify(e.warnings) : null,
     e.rateLimits ? JSON.stringify(e.rateLimits) : null,
     e.claimKey ?? null],
  );

  console.log(JSON.stringify({ severity: 'NOTICE', logName: 'teller.audit', ...e, args: undefined }));
}

export const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex');
