# xero-mcp

The Xero MCP door, extracted from the main `Teller` gateway repo and
deployed standalone on Netlify Functions, as a fast trial of hosting outside
GCP. **Nothing in `/src/core` or `/src/adapters` was rewritten** — every file
here is a copy of the original, with only import paths adjusted for the new
directory layout. The RBAC decision, the audit trail, the Xero adapter, and
the `Money` boundary are the same code, same behaviour, same tests passing
against them in the main repo.

## What's different from the GCP version

- **Transport**: `WebStandardStreamableHTTPServerTransport` (Request/Response),
  not the Node-specific one — this is what makes it run on Netlify's
  web-standard function runtime at all.
- **Auth**: Cloud Run's IAM has no Netlify equivalent. This uses a single
  shared-secret header (`x-teller-secret`) instead — read
  `netlify/functions/mcp.mts`'s header comment before deploying. It is a
  PoC-grade gate: whoever holds the secret acts as one fixed principal
  (`TELLER_MCP_PRINCIPAL`), not per-person identity.
- **Roll-forward is off.** No local filesystem, no Python runtime on Netlify
  Functions — `TELLER_TRACKER_FILE` stays unset, which the code already
  treats as a deliberate no-op, same as it does locally.
- **Rate limiting**: same as the main repo today — Xero's own `429` +
  `Retry-After`, read and respected. There is no in-process token bucket to
  lose by running on a platform with unbounded concurrent instances, because
  one was never built (see the main repo's `POC-PLAN.md` §C2 for the
  documented `pg_advisory_xact_lock` escape hatch if this ever needs one).

## Deploy

```bash
netlify deploy --prod
```

Then set the real values for every var in `.env.example` in Netlify's own
environment variable settings — never in a committed file.

## Structure

```
src/core/       rbac.ts, audit.ts, claims.ts, money.ts, policy.ts, db.ts,
                intents.ts, invoices.ts, log.ts, review/escalate.ts
src/adapters/   xero.ts, tracker/*  (roll-forward's plan/apply split,
                inert here - see above)
netlify/functions/mcp.mts   the only new file - protocol + platform glue
```
