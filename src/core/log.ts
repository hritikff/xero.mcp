// One call, two destinations: a durable row in Postgres (so "what happened
// to this document" is one query, not scrollback) and structured JSON on
// stdout (so it's visible live and Cloud Logging picks it up for free, same
// pattern as audit.ts). Never throws - a logging failure must not take down
// the pipeline it's describing.
import { q } from './db.ts';

export type Stage = 'ingest' | 'extract' | 'resolve_contact' | 'create_contact'
  | 'create_invoice' | 'attach' | 'roll_forward';
export type Status = 'started' | 'done' | 'failed' | 'needs_human' | 'skipped';

const ICON: Record<Status, string> = {
  started: '▶', done: '✓', failed: '✗', needs_human: '⚠', skipped: '·',
};

export async function stage(sourceRecordId: string, name: Stage, status: Status, detail?: unknown) {
  const ts = new Date().toISOString();
  console.log(`${ICON[status]} [${ts}] ${name.padEnd(16)} ${status.padEnd(12)} ${sourceRecordId}` +
    (detail ? `  ${JSON.stringify(detail)}` : ''));
  try {
    await q(
      `INSERT INTO teller.pipeline_log (source_record_id, stage, status, detail) VALUES ($1,$2,$3,$4)`,
      [sourceRecordId, name, status, detail ? JSON.stringify(detail) : null],
    );
  } catch (e: any) {
    console.error(`  (log write failed, continuing: ${e?.message ?? e})`);
  }
}

/** Every stage of one document's run, in order - the query "what happened here". */
export const history = (sourceRecordId: string) =>
  q(`SELECT stage, status, detail, ts FROM teller.pipeline_log WHERE source_record_id = $1 ORDER BY ts`,
    [sourceRecordId]);
