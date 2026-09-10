// The join between "an invoice was just created" and "should the tracker be
// touched at all". TELLER_TRACKER_FILE unset means every call here is a
// deliberate, cheap no-op - so this can be wired into the write path today
// without risk, and switched on later by setting one env var, not by
// shipping new code.
import { q } from '../../core/db.ts';
import { planRollForward, type TrackerInvoice } from './rollforward.ts';
import { readExistingRows, applyFill } from './apply.ts';
import { resolveSection } from './sections.ts';
import { escalate } from '../../core/review/escalate.ts';

export type RollForwardOutcome =
  | { action: 'off' }
  | { action: 'fill'; section: string; row: number }
  | { action: 'skip' | 'needs_human'; reason: string };

export async function rollForwardInvoice(
  entity: string, sourceRecordId: string, inv: any,
): Promise<RollForwardOutcome> {
  const file = process.env.TELLER_TRACKER_FILE;
  if (!file) return { action: 'off' };

  const record = async (state: 'DONE' | 'NEEDS_HUMAN', extra: Record<string, unknown> = {}) => {
    await q(
      `INSERT INTO teller.tracker_write (xero_invoice_id, tracker_file, section, state, target_row, reason, attempts, written_at)
       VALUES ($1,'FFE',$2,$3,$4,$5,1, CASE WHEN $3='DONE' THEN now() END)
       ON CONFLICT (xero_invoice_id, tracker_file) DO UPDATE
         SET state = EXCLUDED.state, target_row = EXCLUDED.target_row, reason = EXCLUDED.reason,
             attempts = teller.tracker_write.attempts + 1, written_at = EXCLUDED.written_at`,
      [inv.invoiceID, extra.section ?? null, state, extra.row ?? null, extra.reason ?? null],
    );
  };

  const [intakeRow] = await q<{ event_name: string }>(
    `SELECT event_name FROM teller.intake WHERE source_record_id = $1`, [sourceRecordId],
  );
  if (!intakeRow?.event_name) {
    await record('NEEDS_HUMAN', { reason: 'no intake.event_name to resolve a section from' });
    return { action: 'needs_human', reason: 'no event_name on the intake row' };
  }

  const trackerInv: TrackerInvoice = {
    eventName: intakeRow.event_name,
    clientName: inv.contact?.name ?? 'unknown',
    amountMinor: Math.round((inv.subTotal ?? 0) * 100),
    invoiceNumber: inv.invoiceNumber,
    deepLink: inv.deepLink ?? '',
    status: inv.status,
    amountDueMinor: Math.round((inv.amountDue ?? inv.total ?? 0) * 100),
    invoiceDateISO: inv.date instanceof Date ? inv.date.toISOString().slice(0, 10) : String(inv.date ?? ''),
    dueDateISO: inv.dueDate instanceof Date ? inv.dueDate.toISOString().slice(0, 10) : undefined,
    reference: inv.reference,
  };

  const section = resolveSection(trackerInv.eventName);
  if (!section) {
    await record('NEEDS_HUMAN', { reason: `no section mapping for "${trackerInv.eventName}"` });
    return { action: 'needs_human', reason: `no section mapping for "${trackerInv.eventName}"` };
  }

  try {
    const rows = await readExistingRows(file, section);
    const plan = planRollForward(trackerInv, rows, new Date().getFullYear());

    if (plan.action === 'fill') {
      await applyFill(file, plan.row, plan.values);
      await record('DONE', { section: plan.section, row: plan.row });
      return { action: 'fill', section: plan.section, row: plan.row };
    }
    if (plan.action === 'needs_human') {
      await record('NEEDS_HUMAN', { reason: plan.reason, section: plan.section });
      await escalate({
        sourceRecordId, kind: plan.reason.includes('placeholder') ? 'placeholder_match'
          : plan.reason.includes('no spare capacity') ? 'no_capacity' : 'unmapped_event',
        summary: `Roll-forward needs a decision: ${trackerInv.clientName} (${trackerInv.invoiceNumber})`,
        context: { entity, ...trackerInv, reason: plan.reason, section: plan.section },
      });
    }
    return plan;
  } catch (e: any) {
    // File I/O failure. Never throw into the write path - the invoice
    // already exists in Xero and that is what matters.
    await record('NEEDS_HUMAN', { reason: `tracker write failed: ${e?.message ?? e}` });
    return { action: 'needs_human', reason: `tracker write failed: ${e?.message ?? e}` };
  }
}
