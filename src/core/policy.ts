// Who may do what. This is the only file to read to answer an access-control
// question. A .ts const rather than YAML so a typo in a role or entity name is
// a build error, not a 3am surprise. No parser, no dependency, no runtime
// validation of our own config.

export const ENTITIES = ['tech-nation', 'ff-events', 'ff-global', 'founders-law'] as const;
export type Entity = (typeof ENTITIES)[number];

export type Role = 'pipeline' | 'finance' | 'query' | 'invoice-creator';

/**
 * Principals are Cloud Run service-account emails, or a Slack user id that the
 * query bot forwards as the acting user. Absent from this map = denied.
 */
export const PRINCIPALS: Record<string, { role: Role; entities: readonly Entity[] | '*' }> = {
  'teller-pipeline@ff-teller.iam.gserviceaccount.com': { role: 'pipeline', entities: '*' },
  'teller-payments-sync@ff-teller.iam.gserviceaccount.com': { role: 'query', entities: '*' },
  'U01KEVIN': { role: 'finance', entities: '*' },
  'U02CHARLOTTE': { role: 'query', entities: ['tech-nation'] },
  // Least-privilege test principal, 2026-09-09: one intent, one entity.
  // Never grant '*' to this role — that is what 'pipeline' is for.
  'U0INVOICE-CREATOR': { role: 'invoice-creator', entities: ['ff-events'] },
};

/**
 * Writes need an explicit grant. Reads are NOT listed here — they derive from
 * each intent's readOnly annotation, so adding a read intent grants nothing new
 * and there is no second list to forget to update.
 */
export const WRITE_GRANTS: Record<Role, readonly string[]> = {
  pipeline: ['create_draft_invoice'],
  finance: [],
  query: [],
  // Deliberately identical grant to 'pipeline' — the difference is entity
  // scope (locked to ff-events, not '*') and principal (a named test
  // identity, not the automated Cloud Run job). Same intent, narrower blast
  // radius. This is what "least privilege" looks like at our layer: we
  // cannot narrow Xero scopes from here (that's Kevin's connection), but we
  // can narrow which entity and which caller may reach the write at all.
  'invoice-creator': ['create_draft_invoice'],
};
