// §4.5 stage 8 (Notify), for every needs_human outcome this system produces.
// Two Gmail permissions, and they are NOT the same ask as ingest:
//   - send: compose and send one email
//   - read: only messages IN A THREAD THIS SERVICE STARTED
// Reading Katie's sponsorship channel or John's whole inbox is a completely
// different, broader grant (§5.1 ingest) and stays a separate approval.
//
// Off by default: GMAIL_SEND_CREDENTIALS unset means escalate() only writes
// the review_request row and logs what WOULD be sent. Wiring this into every
// needs_human call site today costs nothing and turns on later with real
// credentials, the same TELLER_TRACKER_FILE pattern already used for the
// tracker write.
import { q } from '../db.ts';

export type ReviewKind = 'contact_ambiguous' | 'contact_missing' | 'placeholder_match'
  | 'no_capacity' | 'unmapped_event' | 'claim_conflict' | 'extraction_flag';

export type ReviewContext = {
  sourceRecordId: string;
  kind: ReviewKind;
  summary: string;           // becomes the email subject - one line, decidable on its own
  context: Record<string, unknown>;
};

const REVIEWER_EMAIL = process.env.TELLER_REVIEWER_EMAIL; // e.g. kevin@ff.co - who decides

export async function escalate(req: ReviewContext): Promise<number> {
  const [row] = await q<{ id: number }>(
    `INSERT INTO teller.review_request (source_record_id, kind, summary, context, status, sent_to)
     VALUES ($1,$2,$3,$4,'PENDING',$5) RETURNING id`,
    [req.sourceRecordId, req.kind, req.summary, JSON.stringify(req.context), REVIEWER_EMAIL ?? null],
  );

  if (!process.env.GMAIL_SEND_CREDENTIALS) {
    console.log(`(review request #${row.id} logged, no GMAIL_SEND_CREDENTIALS — would email ${REVIEWER_EMAIL ?? '(no reviewer configured)'}: "${req.summary}")`);
    return row.id;
  }

  // The live path: compose, send via Gmail API, capture the thread id, mark
  // SENT. Deliberately unimplemented until GMAIL_SEND_CREDENTIALS exists -
  // see src/tracker/apply.ts's Sheets-swap comment for the same pattern.
  throw new Error('GMAIL_SEND_CREDENTIALS is set but the send path is not built yet');
}

/** Every open (undecided) request - what an operator or a status page would show. */
export const pending = () =>
  q(`SELECT id, source_record_id, kind, summary, status, created_at
     FROM teller.review_request WHERE status IN ('PENDING','SENT') ORDER BY created_at`);

const REPLY_PATTERN = /^\s*(CONFIRM|REJECT)\b/i;

/**
 * Applies a reply once it exists. Deliberately conservative: the first line
 * must be exactly CONFIRM or REJECT - "yeah go ahead" or "looks right" does
 * not decide anything, matching the "match cleanly or refuse" rule used
 * everywhere else in this system (resolveSection, nameHit). An unparseable
 * reply stays PENDING for a human to look at again, never guessed at.
 */
export async function applyReply(requestId: number, replyText: string, from: string): Promise<'CONFIRMED' | 'REJECTED' | 'unparsed'> {
  const m = replyText.trim().match(REPLY_PATTERN);
  if (!m) return 'unparsed';
  const status = m[1].toUpperCase() === 'CONFIRM' ? 'CONFIRMED' : 'REJECTED';
  await q(
    `UPDATE teller.review_request SET status=$2, decided_at=now(), decided_by=$3, decision_text=$4
     WHERE id=$1 AND status IN ('PENDING','SENT')`,
    [requestId, status, from, replyText.slice(0, 500)],
  );
  return status;
}
