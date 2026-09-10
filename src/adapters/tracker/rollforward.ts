// §4.5 stage 7, the immediate half: the moment create_draft_invoice succeeds,
// decide whether - and where - it can be safely written into the tracker.
//
// This is deliberately a PLANNING function, not a writer. It touches no file
// and no network. Every unsafe case it can detect, it refuses rather than
// guesses - the two live dry-runs this session proved that guessing on a
// real financial file is how a real number gets silently corrupted.
//
// The other half of stage 7 - re-checking PAID/existing rows on a schedule -
// is a different algorithm (payments sync, §5.7) and does not belong here.

import { resolveSection, type Section } from './sections.ts';

export type XeroStatus = 'DRAFT' | 'SUBMITTED' | 'AUTHORISED' | 'PAID' | 'VOIDED' | 'DELETED';

export type TrackerInvoice = {
  eventName: string;
  clientName: string;
  amountMinor: number;     // net, matches the E column's "GBP net" convention
  invoiceNumber: string;
  deepLink: string;
  status: XeroStatus;
  amountDueMinor: number;
  invoiceDateISO: string;  // YYYY-MM-DD
  dueDateISO?: string;      // YYYY-MM-DD - needed for the house note format
  paidDateISO?: string;    // first Payments[].Date, if any
  reference: string;       // our TLR-... reference - traceability in the note
};

/** One row as it exists today in the tracker's detail section. */
export type ExistingRow = {
  row: number;
  d: string | null; e: number | null; f: string | null; g: string | null;
};

export type RowValues = {
  d: string; e: number; f: 'Paid' | 'Not Paid' | 'Paid 2025'; g: string;
  gLink: string; h: string; i: string;
};

export type Plan =
  | { action: 'fill'; section: string; row: number; values: RowValues }
  | { action: 'skip'; reason: string }
  // section is present whenever it was actually resolved before the refusal
  // (a placeholder match, no spare capacity) and absent when it genuinely
  // never was (no mapping for the event at all) - never forced either way.
  | { action: 'needs_human'; reason: string; section?: string };

/**
 * §1.6's enum is Paid / Not Paid / Paid 2025 - three values, no VOIDED, no
 * DRAFT. A freshly-created invoice (the only kind this function ever sees,
 * since it runs right after create_draft_invoice) is always unpaid, so in
 * practice this always resolves to 'Not Paid' today - the Paid/Paid 2025
 * branches exist for when this same function is reused by the payments sync
 * (§5.7) re-evaluating an EXISTING row later, not for the create-time path.
 */
export function statusBucket(inv: TrackerInvoice, trackerYear: number): RowValues['f'] | null {
  if (inv.status === 'VOIDED' || inv.status === 'DELETED') return null; // no safe bucket - needs_human
  if (inv.amountDueMinor > 0) return 'Not Paid';
  const paidYear = inv.paidDateISO ? Number(inv.paidDateISO.slice(0, 4)) : trackerYear;
  return paidYear < trackerYear ? 'Paid 2025' : 'Paid';
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const dateForSheet = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}-${MON[Number(m) - 1]}-${y.slice(2)}`;
};

/**
 * "6 Sep 2026" - the tracker's own house style for the H (notes) column,
 * confirmed against three live production entries on 2026-09-10 (Vercel,
 * Bound, Adyen - all real invoices this session's pipeline also processed).
 * No leading zero on the day; dateForSheet's "06-Sep-26" is a DIFFERENT
 * format used only in the I (date) column - the two must not be confused.
 */
const dateForNote = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${Number(d)} ${MON[Number(m) - 1]} ${y}`;
};

export function planRollForward(
  inv: TrackerInvoice,
  existingRows: ExistingRow[],
  trackerYear: number,
): Plan {
  const section = resolveSection(inv.eventName);
  if (!section) {
    return { action: 'needs_human', reason: `no section mapping for event "${inv.eventName}" - add it to sections.ts` };
  }

  // Idempotency, first. Re-running this for the same invoice must never
  // produce a second row - same discipline as C1's claim ledger, applied to
  // the spreadsheet instead of Xero.
  const already = existingRows.find((r) => r.g === inv.invoiceNumber);
  if (already) return { action: 'skip', reason: `already at row ${already.row}` };

  const bucket = statusBucket(inv, trackerYear);
  if (!bucket) {
    return { action: 'needs_human', reason: `status ${inv.status} has no safe bucket in the §1.6 enum` };
  }

  // The safe path only: a genuinely blank row already inside the section's
  // existing formula range. If none exists, this is the "Global had zero
  // spare rows" case from earlier - a human decides whether to insert one,
  // following §4.1 exactly, with the section config updated to match
  // afterward. This function will never attempt that on its own.
  // §1.7's placeholder enum: a human may already have pre-filled this exact
  // deal as "Not invoiced" or "Waiting for contract", anticipating the
  // invoice this run just raised. Filling a DIFFERENT blank row instead
  // produces what looks like a duplicate entry - this is the real bug this
  // session's first live run surfaced (Bound / Bound Rates Limited, CFO
  // Forum, both £12,000, two rows apart). A fuzzy name match is exactly the
  // kind of ambiguity resolve_contact already refuses to resolve silently
  // elsewhere in this system - so this does the same: name a candidate,
  // stop, let a human confirm it is the same deal before touching it.
  const nameHit = (a: string, b: string) => {
    const x = a.toLowerCase().trim(), y = b.toLowerCase().trim();
    return x.length > 2 && y.length > 2 && (x.includes(y) || y.includes(x));
  };
  const placeholder = existingRows.find((r) =>
    r.d && /^(not invoiced|waiting for contract)$/i.test(r.g ?? '') && nameHit(r.d, inv.clientName));
  if (placeholder) {
    return {
      action: 'needs_human', section: section.event,
      reason: `row ${placeholder.row} ("${placeholder.d}") looks like a pre-existing placeholder for this same deal - confirm before filling a different row`,
    };
  }

  const blank = existingRows.find((r) => r.d == null && r.e == null && r.f == null && r.g == null);
  if (!blank) {
    return {
      action: 'needs_human', section: section.event,
      reason: `section "${section.event}" has no spare capacity (rows ${section.dataStart}-${section.dataEnd} full) - insert a row manually per §4.1, then update sections.ts`,
    };
  }

  return {
    action: 'fill',
    section: section.event,
    row: blank.row,
    values: {
      d: inv.clientName,
      e: Math.round(inv.amountMinor / 100),   // the sheet's E column is whole £, not minor units
      f: bucket,
      g: inv.invoiceNumber,
      gLink: inv.deepLink,
      // "Invoiced {date} — due {date}" - the tracker's own established
      // convention (§1.2's H "Notes" column), not an invented format. A
      // human reading this row cannot tell it apart from one they wrote
      // themselves, which is the actual goal - not "the bot did this".
      h: inv.dueDateISO
        ? `Invoiced ${dateForNote(inv.invoiceDateISO)} — due ${dateForNote(inv.dueDateISO)}`
        : `Invoiced ${dateForNote(inv.invoiceDateISO)}`,
      i: dateForSheet(inv.invoiceDateISO),
    },
  };
}
