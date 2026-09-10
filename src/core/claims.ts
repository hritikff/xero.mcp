// C1: write idempotency. Two layers.
//   0-6 min  Xero's own Idempotency-Key — cached response, no duplicate.
//   > 6 min  this ledger + a read-before-write, because Xero forgets the key
//            and would treat a reuse as a brand new request.
import { createHash, randomUUID } from 'node:crypto';
import { q } from './db.ts';

// Xero stores keys for 6 minutes. Stop trusting ours at 5.
const KEY_TTL_MS = 5 * 60_000;

export const claimKey = (sourceSystem: string, sourceRecordId: string, allocationIndex: number) =>
  createHash('sha256').update(`${sourceSystem}|${sourceRecordId}|${allocationIndex}`).digest('hex');

/** Four UUIDs, dashes stripped: 128 chars, exactly Xero's maximum. */
export const newIdempotencyKey = () =>
  Array.from({ length: 4 }, () => randomUUID().replace(/-/g, '')).join('');

export const requestHash = (args: unknown) =>
  createHash('sha256').update(JSON.stringify(args)).digest('hex');

export type Claim =
  | { kind: 'proceed'; idempotencyKey: string; recoverFirst: boolean }
  | { kind: 'done'; xeroInvoiceId: string }
  | { kind: 'conflict'; reason: string };

export async function claim(
  key: string, entity: string, reference: string, hash: string,
): Promise<Claim> {
  const fresh = newIdempotencyKey();

  // One round trip. The guard means the UPDATE only fires for a genuine retry
  // of an identical payload; anything else returns zero rows and we look.
  const rows = await q(
    `INSERT INTO teller.invoice_claim
       (claim_key, entity, reference, request_hash, attempt_count,
        last_attempt_at, idempotency_key, key_issued_at)
     VALUES ($1,$2,$3,$4,1,now(),$5,now())
     ON CONFLICT (claim_key) DO UPDATE
       SET attempt_count = teller.invoice_claim.attempt_count + 1,
           last_attempt_at = now(),
           -- reuse the key inside its window, mint a new one past it
           idempotency_key = CASE
             WHEN teller.invoice_claim.key_issued_at > now() - interval '5 minutes'
             THEN teller.invoice_claim.idempotency_key ELSE $5 END,
           key_issued_at = CASE
             WHEN teller.invoice_claim.key_issued_at > now() - interval '5 minutes'
             THEN teller.invoice_claim.key_issued_at ELSE now() END
       WHERE teller.invoice_claim.state IN ('PENDING','FAILED')
         AND teller.invoice_claim.request_hash = EXCLUDED.request_hash
     RETURNING *, (xmax = 0) AS inserted`,
    [key, entity, reference, hash, fresh],
  );

  if (rows.length) {
    const r = rows[0];
    // A reused key means Xero still remembers this request: safe to POST
    // straight away. A fresh key on a retry means we must look first.
    const recoverFirst = !r.inserted && r.idempotency_key === fresh;
    return { kind: 'proceed', idempotencyKey: r.idempotency_key, recoverFirst };
  }

  // Guard rejected the update. Find out which case.
  const [existing] = await q(`SELECT * FROM teller.invoice_claim WHERE claim_key = $1`, [key]);
  if (!existing) return { kind: 'conflict', reason: 'claim vanished mid-flight' };

  // Hash BEFORE state. Checking CONFIRMED first would return the original
  // invoice for a changed payload — the caller would believe an invoice for the
  // new amount exists when it does not. A differing payload is a conflict at
  // every state.
  if (existing.request_hash !== hash) {
    // Only move the state when nothing was confirmed. A CONFIRMED row records a
    // real invoice in Xero; the request is what is wrong, not the row.
    if (existing.state !== 'CONFIRMED') {
      await q(`UPDATE teller.invoice_claim SET state='CONFLICT', last_error=$2 WHERE claim_key=$1`,
              [key, 'payload changed for the same source record']);
    }
    return {
      kind: 'conflict',
      reason: existing.state === 'CONFIRMED'
        ? `invoice ${existing.xero_invoice_id} already exists for this source record with a different payload — halted for review`
        : 'same source record, different payload — halted for review',
    };
  }

  if (existing.state === 'CONFIRMED') return { kind: 'done', xeroInvoiceId: existing.xero_invoice_id };
  return { kind: 'conflict', reason: `claim is ${existing.state}` };
}

export const confirm = (key: string, invoiceId: string) =>
  q(`UPDATE teller.invoice_claim SET state='CONFIRMED', xero_invoice_id=$2, confirmed_at=now()
     WHERE claim_key=$1`, [key, invoiceId]);

/** 4xx only: the request is wrong and will stay wrong. */
export const markFailed = (key: string, error: string) =>
  q(`UPDATE teller.invoice_claim SET state='FAILED', last_error=$2 WHERE claim_key=$1`, [key, error]);

/** Timeouts and 5xx: outcome UNKNOWN. Stays PENDING so the sweeper looks. */
export const markUnknown = (key: string, error: string) =>
  q(`UPDATE teller.invoice_claim SET last_error=$2 WHERE claim_key=$1`, [key, error]);

export const stuck = (olderThanMinutes = 10) =>
  q(`SELECT * FROM teller.invoice_claim
     WHERE state='PENDING' AND last_attempt_at < now() - ($1 || ' minutes')::interval
     ORDER BY last_attempt_at`, [olderThanMinutes]);
