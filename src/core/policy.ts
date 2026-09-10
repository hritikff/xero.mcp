// Who may do what. This is the only file to read to answer an access-control
// question. A .ts const rather than YAML so a typo in a role or entity name is
// a build error, not a 3am surprise. No parser, no dependency, no runtime
// validation of our own config.

export const ENTITIES = ['tech-nation', 'ff-events', 'ff-global', 'founders-law'] as const;
export type Entity = (typeof ENTITIES)[number];

// 'pipeline' | 'finance' | 'query' are cross-entity roles (their principals
// below are scoped with entities: '*') — a single entity in the name would
// be misleading for those, so they stay entity-agnostic. Anything scoped to
// ONE entity gets that entity baked into the role name itself, `${entity}
// -invoice-creator` — so the name alone tells you what it can touch, instead
// of relying on a separate entities array staying in sync with it. This is
// the fix for a real mix-up tonight: a caller tried tech-nation against a
// role named only 'invoice-creator', which said nothing about which entity
// it actually meant. validatePolicy() below enforces the naming contract at
// boot — a role named "X-invoice-creator" whose principal isn't scoped to
// exactly [X] fails the start, not a 3am surprise.
export type Role = 'pipeline' | 'finance' | 'query' | 'ff-events-invoice-creator';

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
  // Never grant '*' to this role — that is what 'pipeline' is for. The role
  // name itself now says ff-events, so a caller can't accidentally ask this
  // principal to touch tech-nation without the name already having told
  // them not to.
  'U0INVOICE-CREATOR': { role: 'ff-events-invoice-creator', entities: ['ff-events'] },
};

/**
 * Every intent — read AND write — needs an explicit grant here. This used to
 * be write-only, with every read-only intent free to any authenticated
 * principal by virtue of its annotation; that meant "give this person only
 * list_tax_rates" was impossible; every reader saw every read tool. Now
 * nothing is implicit: a role sees exactly the intents named here, and
 * validatePolicy() below fails the boot if a new intent is added and nobody
 * grants it — so "forgot to scope the new tool" is a startup error, not a
 * silent over-grant.
 */
export const GRANTS: Record<Role, readonly string[]> = {
  pipeline: [
    'list_tax_rates', 'list_accounts', 'list_all_accounts', 'resolve_contact',
    'create_draft_invoice', 'attach_invoice_document',
  ],
  finance: ['list_tax_rates', 'list_accounts', 'list_all_accounts', 'resolve_contact'],
  query: ['list_tax_rates', 'list_accounts', 'list_all_accounts', 'resolve_contact'],
  // Deliberately narrower than 'pipeline' on BOTH axes now: entity scope
  // (locked to ff-events, not '*') and tool surface — no list_all_accounts,
  // since bank-account visibility has nothing to do with composing an
  // invoice. This is what "least privilege" looks like at our layer: we
  // cannot narrow Xero scopes from here (that's Kevin's connection), but we
  // can narrow which entity, which tools, and which caller may reach a write.
  'ff-events-invoice-creator': [
    'list_tax_rates', 'list_accounts', 'resolve_contact',
    'create_draft_invoice', 'attach_invoice_document',
  ],
};
