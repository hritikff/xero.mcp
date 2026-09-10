// One registry. Adding an intent means adding an entry here — never a route,
// never an RBAC list. That is the whole reason there is exactly one HTTP route.
import { z } from 'zod';
import { ENTITIES } from './policy.ts';
import { Invoice, LineAmountTypes } from 'xero-node';
import { xero, limits, xeroError } from '../adapters/xero.ts';
import { toDecimal, fromXero } from './money.ts';
import * as claims from './claims.ts';
import * as invoices from './invoices.ts';
import * as tracker from '../adapters/tracker/index.ts';
import * as review from './review/escalate.ts';

/** MCP annotations, declared explicitly. The spec defaults omissions to
 *  destructive/non-idempotent, and roles derive from readOnly — so a missing
 *  annotation would silently widen access. Required, not optional. */
export type Annotations = {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type Ctx = { principal: string; role: string; requestId: string };

export type Intent = {
  schema: z.ZodType<any>;
  annotations: Annotations;
  handler: (args: any, ctx: Ctx) => Promise<unknown>;
};

const Entity = z.enum(ENTITIES);
/** Integer minor units. The only way an amount exists. */
const Money = z.number().int().finite();

/**
 * Everything that must happen after Xero has confirmed an invoice exists —
 * persist, attach, roll forward — lives here, in ONE place, called from BOTH
 * a fresh creation and an idempotent replay of an earlier one. This is the
 * fix for a real bug found live: the replay path used to return immediately
 * without ever attempting attachment or roll-forward, so a crash partway
 * through post-processing (as genuinely happened once, from a DB constraint
 * bug) left those steps permanently skipped on every retry, even though
 * retrying is exactly when they should be attempted again — both are
 * independently idempotent (attachment checks its own state; roll-forward
 * checks for an existing row), so re-running them on a replay is always safe.
 */
async function finishInvoice(
  entity: string, sourceRecordId: string, claimKey: string, inv: any,
  attachOnline: boolean, created: boolean, xeroResponse?: any,
) {
  const conn = await xero(entity, 'write');
  await invoices.record(entity, claimKey, inv, conn.shortCode, null, sourceRecordId);

  const attachment = await invoices.attachFromIntake(entity, inv.invoiceID, sourceRecordId, attachOnline);
  const rollForward = await tracker.rollForwardInvoice(entity, sourceRecordId, inv);

  return {
    invoiceID: inv.invoiceID, created, claimKey,
    status: inv.status, subTotalMinor: fromXero(inv.subTotal), attachment, rollForward,
    deepLink: conn.shortCode ? `https://go.xero.com/app/${conn.shortCode}/invoicing/view/${inv.invoiceID}` : undefined,
    warnings: inv.warnings ?? [], _limits: xeroResponse ? limits(xeroResponse) : undefined,
  };
}

export const INTENTS: Record<string, Intent> = {
  // ---- reads -------------------------------------------------------------
  list_tax_rates: {
    schema: z.object({ entity: Entity }).strict(),
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    handler: async ({ entity }) => {
      const { client, tenantId } = await xero(entity, 'read');
      const r = await client.accountingApi.getTaxRates(tenantId);
      return {
        _limits: limits(r.response),
        taxRates: (r.body.taxRates ?? [])
          .filter((t) => t.canApplyToRevenue)
          .map((t) => ({ taxType: t.taxType, name: t.name, rate: t.effectiveRate })),
      };
    },
  },

  list_accounts: {
    schema: z.object({ entity: Entity }).strict(),
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    handler: async ({ entity }) => {
      const { client, tenantId } = await xero(entity, 'read');
      const r = await client.accountingApi.getAccounts(tenantId, undefined, 'Type=="REVENUE"');
      return {
        _limits: limits(r.response),
        accounts: (r.body.accounts ?? []).map((a) => ({ code: a.code, name: a.name })),
      };
    },
  },

  // Full chart of accounts, unfiltered - list_accounts stays REVENUE-only on
  // purpose (that is what invoice line items are picked from). This is the
  // general-purpose read: bank, expense, asset, liability accounts too, for
  // anyone asking a broader bookkeeping question rather than composing an
  // invoice.
  list_all_accounts: {
    schema: z.object({ entity: Entity }).strict(),
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    handler: async ({ entity }) => {
      const { client, tenantId } = await xero(entity, 'read');
      const r = await client.accountingApi.getAccounts(tenantId);
      return {
        _limits: limits(r.response),
        accounts: (r.body.accounts ?? []).map((a) => ({
          code: a.code, name: a.name, type: a.type, status: a.status, class: a.class,
        })),
      };
    },
  },

  // Read access to invoices themselves - status, amounts, who they're for -
  // separate from resolve_contact (who a client IS) and list_accounts (the
  // chart, not what's been billed against it). Uses the SDK's typed
  // `statuses` array and `searchTerm` param, same as resolve_contact - never
  // a raw `where` string built from caller input. `type` is the one
  // exception: Xero has no typed param for it, only a `where` clause, but
  // the value is a closed two-option zod enum we construct ourselves - no
  // caller-supplied text ever reaches it, same safety property as a typed
  // param, just without SDK support for one. summaryOnly trims the response
  // to what a reader actually needs.
  //
  // ACCREC = money owed TO the entity (sales invoices - what list_invoices
  // returned before this existed). ACCPAY = money the entity owes (bills -
  // "what are we waiting to pay"). Xero stores both in the same Invoices
  // table; nothing before this call distinguished them.
  list_invoices: {
    schema: z
      .object({
        entity: Entity,
        type: z.enum(['ACCREC', 'ACCPAY']).optional(),
        statuses: z.array(z.enum(['DRAFT', 'SUBMITTED', 'AUTHORISED', 'PAID', 'VOIDED', 'DELETED'])).optional(),
        search: z.string().min(2).max(200).optional(),
        page: z.number().int().positive().optional(),
      })
      .strict(),
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    handler: async ({ entity, type, statuses, search, page }) => {
      const { client, tenantId } = await xero(entity, 'read');
      const where = type === 'ACCREC' ? 'Type=="ACCREC"' : type === 'ACCPAY' ? 'Type=="ACCPAY"' : undefined;
      const r = await client.accountingApi.getInvoices(
        tenantId, undefined, where, undefined, undefined, undefined, undefined,
        statuses, page, undefined, undefined, undefined, true, undefined, search,
      );
      return {
        _limits: limits(r.response),
        invoices: (r.body.invoices ?? []).map((i) => ({
          invoiceID: i.invoiceID, invoiceNumber: i.invoiceNumber, reference: i.reference,
          type: i.type, contact: i.contact?.name, status: i.status,
          total: i.total, amountDue: i.amountDue, date: i.date, dueDate: i.dueDate,
        })),
      };
    },
  },

  resolve_contact: {
    schema: z.object({ entity: Entity, name: z.string().min(2).max(200) }).strict(),
    annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    handler: async ({ entity, name }) => {
      const { client, tenantId } = await xero(entity, 'read');
      // searchTerm, not a where clause: no user string reaches the filter parser.
      const r = await client.accountingApi.getContacts(
        tenantId, undefined, undefined, undefined, undefined, undefined, undefined, true, name,
      );
      const candidates = (r.body.contacts ?? []).map((c) => ({ contactID: c.contactID, name: c.name }));
      // Ambiguity is the caller's problem to escalate. Never auto-pick, never create.
      return { _limits: limits(r.response), candidates, ambiguous: candidates.length !== 1 };
    },
  },

  // ---- the only write ----------------------------------------------------
  create_draft_invoice: {
    schema: z
      .object({
        entity: Entity,
        contact_id: z.string().uuid(),
        // Charset-restricted because this value reaches Xero's `where`
        // parser. No quotes, no &&/||, so nothing to escape.
        reference: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
        source_record_id: z.string().min(1).max(128),
        allocation_index: z.number().int().nonnegative(),
        due_date: z.string().date().optional(),
        // Whether the attached contract is visible on the online invoice the
        // customer sees. Defaults to false: internal reference, not a send.
        attach_online: z.boolean().optional(),
        line_items: z
          .array(
            z
              .object({
                description: z.string().min(1).max(4000),
                amount_minor: Money,
                account_code: z.string().min(1).max(10),
                tax_type: z.string().min(1).max(50),
              })
              .strict(),
          )
          .min(1)
          .max(50),
      })
      // .strict() is load-bearing: without it Zod silently DROPS unknown keys,
      // so a smuggled `status: "AUTHORISED"` would pass validation unnoticed
      // instead of being rejected. status is not a parameter, by construction.
      .strict(),
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
    handler: async (a, ctx) => {
      const key = claims.claimKey('teller', a.source_record_id, a.allocation_index);
      const c = await claims.claim(key, a.entity, a.reference, claims.requestHash(a));

      if (c.kind === 'done') {
        // A previous attempt already got as far as a confirmed Xero invoice
        // but may have crashed before attachment/roll-forward finished (this
        // exact case happened live: a DB constraint bug threw mid-way
        // through the FIRST Vercel/INV-24107 run, after Xero confirmation).
        // Re-running post-processing here is safe on its own — attachment
        // checks its own state, roll-forward checks for an existing row —
        // so a retry actually finishes what crashed, instead of silently
        // returning as if everything downstream had already completed.
        const rconn = await xero(a.entity, 'read');
        const refetched = (await rconn.client.accountingApi.getInvoice(rconn.tenantId, c.xeroInvoiceId)).body.invoices[0];
        return finishInvoice(a.entity, a.source_record_id, key, refetched, a.attach_online ?? false, false);
      }
      if (c.kind === 'conflict') {
        await review.escalate({
          sourceRecordId: a.source_record_id, kind: 'claim_conflict',
          summary: `Conflicting write for ${a.source_record_id}: ${c.reason}`,
          context: { entity: a.entity, reference: a.reference, reason: c.reason, submittedArgs: a },
        });
        throw Object.assign(new Error(c.reason), { statusCode: 409 });
      }

      const { client, tenantId } = await xero(a.entity, 'write');

      // The key has lapsed past Xero's 6-minute memory, so look before writing.
      // This is what heals "Xero committed, our confirm failed".
      if (c.recoverFirst) {
        const found = await client.accountingApi.getInvoices(
          tenantId, undefined, `Reference=="${a.reference}"`,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, true,
        );
        const existing = found.body.invoices?.[0];
        if (existing?.invoiceID) {
          await claims.confirm(key, existing.invoiceID);
          return { invoiceID: existing.invoiceID, created: false, recovered: true, claimKey: key };
        }
      }

      const expectedSubTotal = a.line_items.reduce((t: number, l: any) => t + l.amount_minor, 0);
      const payload = {
        invoices: [{
          type: Invoice.TypeEnum.ACCREC,
          contact: { contactID: a.contact_id },
          status: Invoice.StatusEnum.DRAFT,   // hardcoded; not a parameter
          lineAmountTypes: LineAmountTypes.Exclusive,
          reference: a.reference,
          dueDate: a.due_date,
          lineItems: a.line_items.map((l: any) => ({
            description: l.description,
            quantity: 1,
            unitAmount: Number(toDecimal(l.amount_minor)),
            lineAmount: Number(toDecimal(l.amount_minor)),  // explicit: Xero recomputes otherwise
            accountCode: l.account_code,
            taxType: l.tax_type,
          })),
        }],
      };

      let res;
      try {
        res = await client.accountingApi.createInvoices(
          tenantId, payload as any, false, undefined, c.idempotencyKey,
        );
      } catch (e: any) {
        const status = e?.response?.status;
        const detail = JSON.stringify(xeroError(e)).slice(0, 500);
        // 4xx is wrong and will stay wrong. Anything else is an UNKNOWN outcome
        // and must stay PENDING for the sweeper — marking it FAILED here is the
        // bug that creates duplicate invoices.
        if (status >= 400 && status < 500) await claims.markFailed(key, detail);
        else await claims.markUnknown(key, detail);
        throw e;
      }

      const inv = res.body.invoices?.[0];
      if (!inv?.invoiceID || inv.statusAttributeString === 'ERROR') {
        await claims.markFailed(key, JSON.stringify(inv?.validationErrors ?? 'no invoice returned'));
        throw Object.assign(new Error('Xero rejected the invoice'), {
          statusCode: 422, validationErrors: inv?.validationErrors,
        });
      }

      // C4. Xero's arithmetic, not ours, is what has to agree.
      const actual = fromXero(inv.subTotal!);
      if (actual !== expectedSubTotal || fromXero(inv.roundingAmount ?? 0) !== 0) {
        await claims.markUnknown(key, `total mismatch: sent ${expectedSubTotal}, Xero says ${actual}`);
        throw Object.assign(
          new Error(`total mismatch: expected ${expectedSubTotal} minor units, Xero returned ${actual}`),
          { statusCode: 500, invoiceID: inv.invoiceID },
        );
      }

      // Acceptance test 2 needs the process to die between the POST and the
      // confirm. Env-gated and refuses to arm in production.
      if (process.env.TELLER_FAULT === 'after_post_before_confirm' && process.env.NODE_ENV !== 'production') {
        throw Object.assign(new Error('injected fault: died after POST, before confirm'), { statusCode: 500 });
      }

      await claims.confirm(key, inv.invoiceID);
      return finishInvoice(a.entity, a.source_record_id, key, inv, a.attach_online ?? false, true, res.response);
    },
  },

  // Companion to create_draft_invoice for callers that hold the source
  // document themselves (an MCP client with a PDF in its own context) rather
  // than going through the intake pipeline's teller.intake table — see
  // invoices.ts's attachFromIntake for that path. Same write grant, same
  // entity scoping; this just skips the DB-backed intake lookup.
  attach_invoice_document: {
    schema: z
      .object({
        entity: Entity,
        invoice_id: z.string().uuid(),
        file_name: z.string().min(1).max(200),
        // Base64-encoded file bytes. Kept well under Netlify's function
        // request-body ceiling (~6MB) - 8MB of base64 is ~6MB of source file.
        content_base64: z.string().min(1).max(8_000_000),
        mime_type: z.string().min(1).max(100).default('application/pdf'),
        include_online: z.boolean().optional(),
      })
      .strict(),
    annotations: { readOnly: false, destructive: false, idempotent: true, openWorld: true },
    handler: async (a) => {
      const file = invoices.safeFileName(a.file_name);
      const bytes = Buffer.from(a.content_base64, 'base64');
      const { client, tenantId } = await xero(a.entity, 'write');
      try {
        const r = await client.accountingApi.createInvoiceAttachmentByFileName(
          tenantId, a.invoice_id, file, bytes, a.include_online ?? false,
        );
        const at = r.body.attachments?.[0];
        return { _limits: limits(r.response), file, state: 'ATTACHED', attachmentId: at?.attachmentID, url: at?.url };
      } catch (e: any) {
        const detail = xeroError(e);
        // Xero refuses a re-upload of the same filename on the same invoice -
        // that means it is already there, same read-before-write logic as
        // attachFromIntake uses for the intake-pipeline path.
        if (/already exists|duplicate/i.test(JSON.stringify(detail))) {
          return { file, state: 'ATTACHED', note: 'already present in Xero' };
        }
        throw e;
      }
    },
  },
};

/** role: query == every readOnly intent. Derived, never maintained. */
export const readOnlyIntents = () =>
  Object.entries(INTENTS).filter(([, i]) => i.annotations.readOnly).map(([n]) => n);
