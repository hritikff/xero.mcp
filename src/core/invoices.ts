// What exists in Xero, and what Xero said. invoice_claim answers "have we done
// this?"; this answers "what did it become?".
import { createHash } from 'node:crypto';
import { q } from './db.ts';
import { xero, xeroError } from '../adapters/xero.ts';
import { fromXero } from './money.ts';

const day = (v: unknown) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' ? v.slice(0, 10) : null;
const minor = (v: unknown) => (typeof v === 'number' ? fromXero(v) : null);

/** Persist the created invoice, whole response included. */
/** Find the intake row this invoice was built from, if any. Never throws —
 *  a write with no matching intake (e.g. the fixture-only PoC tests) is valid. */
async function findIntakeId(sourceRecordId?: string): Promise<number | null> {
  if (!sourceRecordId) return null;
  const [row] = await q<{ intake_id: number }>(
    `SELECT intake_id FROM teller.intake WHERE source_record_id = $1`, [sourceRecordId],
  );
  return row?.intake_id ?? null;
}

export async function record(
  entity: string, claimKey: string, inv: any, shortCode?: string,
  intakeId?: number | null, sourceRecordId?: string,
) {
  // Looked up automatically so the caller cannot forget to wire it, the way
  // the live handler did — that is what actually produced the null intake_id.
  intakeId = intakeId ?? await findIntakeId(sourceRecordId);
  await q(
    `INSERT INTO teller.invoice
       (xero_invoice_id, entity, claim_key, intake_id, invoice_number, reference, status,
        contact_id, contact_name, currency, line_amount_types, sub_total_minor,
        total_tax_minor, total_minor, rounding_minor, invoice_date, due_date,
        updated_date_utc, deep_link, warnings, xero_response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (xero_invoice_id) DO UPDATE
       SET status = EXCLUDED.status, invoice_number = EXCLUDED.invoice_number,
           intake_id = COALESCE(EXCLUDED.intake_id, teller.invoice.intake_id),
           sub_total_minor = EXCLUDED.sub_total_minor, total_tax_minor = EXCLUDED.total_tax_minor,
           total_minor = EXCLUDED.total_minor, rounding_minor = EXCLUDED.rounding_minor,
           updated_date_utc = EXCLUDED.updated_date_utc, deep_link = EXCLUDED.deep_link,
           warnings = EXCLUDED.warnings, xero_response = EXCLUDED.xero_response`,
    [inv.invoiceID, entity, claimKey, intakeId ?? null, inv.invoiceNumber ?? null,
     inv.reference ?? null, inv.status, inv.contact?.contactID ?? null, inv.contact?.name ?? null,
     inv.currencyCode ?? null, inv.lineAmountTypes ?? null,
     minor(inv.subTotal), minor(inv.totalTax), minor(inv.total), minor(inv.roundingAmount ?? 0),
     day(inv.date), day(inv.dueDate),
     inv.updatedDateUTC instanceof Date ? inv.updatedDateUTC.toISOString() : null,
     shortCode ? `https://go.xero.com/app/${shortCode}/invoicing/view/${inv.invoiceID}` : null,
     JSON.stringify(inv.warnings ?? []), JSON.stringify(inv)],
  );
}

/** Xero rejects some characters; a double extension is fine but spaces are not. */
export const safeFileName = (n: string) =>
  n.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(-100);

/**
 * Attach the source document, best effort. NEVER throws into the write path:
 * an invoice without its contract attached is a far smaller problem than a
 * duplicate invoice, so this records state and returns.
 */
export async function attachFromIntake(
  entity: string, invoiceId: string, sourceRecordId: string, includeOnline = false,
): Promise<{ file?: string; state: string; error?: string }> {
  const [doc] = await q(
    `SELECT doc_filename, doc_data, doc_sha256, octet_length(doc_data) AS bytes
       FROM teller.intake WHERE source_record_id = $1 AND doc_data IS NOT NULL`,
    [sourceRecordId],
  );
  if (!doc) return { state: 'no_document' };

  const file = safeFileName(doc.doc_filename ?? 'contract.pdf');

  const [existing] = await q(
    `SELECT state FROM teller.invoice_attachment WHERE xero_invoice_id = $1 AND file_name = $2`,
    [invoiceId, file],
  );
  if (existing?.state === 'ATTACHED') return { file, state: 'ATTACHED' };

  await q(
    `INSERT INTO teller.invoice_attachment
       (xero_invoice_id, file_name, state, mime_type, bytes, sha256, include_online, attempts)
     VALUES ($1,$2,'PENDING','application/pdf',$3,$4,$5,1)
     ON CONFLICT (xero_invoice_id, file_name) DO UPDATE
       SET state = 'PENDING', attempts = teller.invoice_attachment.attempts + 1`,
    [invoiceId, file, doc.bytes, doc.doc_sha256, includeOnline],
  );

  try {
    const { client, tenantId } = await xero(entity, 'write');
    const r = await client.accountingApi.createInvoiceAttachmentByFileName(
      tenantId, invoiceId, file, doc.doc_data, includeOnline,
    );
    const a = r.body.attachments?.[0];
    await q(
      `UPDATE teller.invoice_attachment
          SET state='ATTACHED', attachment_id=$3, xero_url=$4, mime_type=$5,
              attached_at=now(), last_error=NULL
        WHERE xero_invoice_id=$1 AND file_name=$2`,
      [invoiceId, file, a?.attachmentID ?? null, a?.url ?? null, a?.mimeType ?? 'application/pdf'],
    );
    return { file, state: 'ATTACHED' };
  } catch (e: any) {
    const detail = JSON.stringify(xeroError(e)).slice(0, 500);
    // Xero refuses a duplicate filename. That means it is already there —
    // read-before-write, same as the claim ledger.
    if (/already exists|duplicate/i.test(detail)) {
      await q(
        `UPDATE teller.invoice_attachment SET state='ATTACHED', attached_at=now(),
                last_error='adopted: already present in Xero'
          WHERE xero_invoice_id=$1 AND file_name=$2`, [invoiceId, file]);
      return { file, state: 'ATTACHED' };
    }
    await q(
      `UPDATE teller.invoice_attachment SET state='FAILED', last_error=$3
        WHERE xero_invoice_id=$1 AND file_name=$2`, [invoiceId, file, detail]);
    return { file, state: 'FAILED', error: detail };
  }
}
