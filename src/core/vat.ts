// VAT follows the CUSTOMER's location, not the revenue account's default tax
// code. Cam's rule, stated 2026-09-16: a UK-based customer is always charged
// VAT; a customer anywhere else is not, whatever the chart of accounts would
// have defaulted to.
//
// That rule is why tax_type stopped being a required caller-supplied string on
// create_draft_invoice. A per-call string is a per-call chance to get a real
// customer's VAT wrong, and nothing downstream would have caught it: Xero
// accepts any valid code without an opinion on whether it is the RIGHT code
// for that customer, and the tracker records whatever Xero returns. The
// pipeline hardcoded OUTPUT2 (20%) on every invoice it ever created.
//
// Deliberately NOT modelled here: EC reverse charge, VAT MOSS, place-of-supply
// rules for digital services, and the difference between zero-rated, exempt
// and outside-scope on a VAT return. Cam's rule is binary and this implements
// exactly that rule and no more. A case needing the nuance should refuse here
// and be handled by a person in Xero, which leaves a human audit trail that a
// silent special case in this file would not.

import type { Entity } from './policy.ts';

export type VatCodes = {
  /** Applied when the customer is in the UK. */
  standard: string;
  /** Applied when the customer is anywhere else. */
  nonUk: string;
};

/**
 * Xero tax TYPE codes, per entity. These are org-specific strings and not
 * something to guess at: assertTaxTypeExists() below checks the configured
 * code against the org's real tax rates before an invoice is built, and its
 * error names every code the org does have.
 *
 * `nonUk` is the one value still awaiting Cam's confirmation. "No VAT" in a UK
 * Xero org can mean ZERORATEDOUTPUT (zero rated income), EXEMPTOUTPUT (exempt
 * income) or NONE (no VAT), and those are NOT interchangeable on a VAT return
 * even though all three put £0 of VAT on the invoice. ZERORATEDOUTPUT is the
 * literal reading of the rule as stated; changing it is a one-line edit here,
 * not a change to any handler.
 */
export const VAT_CODES: Record<Entity, VatCodes> = {
  'tech-nation': { standard: 'OUTPUT2', nonUk: 'ZERORATEDOUTPUT' },
  'ff-events': { standard: 'OUTPUT2', nonUk: 'ZERORATEDOUTPUT' },
  'ff-global': { standard: 'OUTPUT2', nonUk: 'ZERORATEDOUTPUT' },
  'founders-law': { standard: 'OUTPUT2', nonUk: 'ZERORATEDOUTPUT' },
};

// Xero stores country as free text typed by whoever made the contact, so the
// comparison folds case and punctuation: "U.K." and "united kingdom" both
// land on a member of this set. The constituent nations are here because
// people type "England" far more often than "United Kingdom".
const UK = new Set([
  'UK', 'GB', 'GBR', 'UNITEDKINGDOM', 'UNITEDKINGDOMOFGREATBRITAINANDNORTHERNIRELAND',
  'GREATBRITAIN', 'BRITAIN', 'ENGLAND', 'SCOTLAND', 'WALES', 'NORTHERNIRELAND',
]);

/** Free text from Xero folded to something comparable: "U.K." -> "UK". */
export function normaliseCountry(raw: string | undefined | null): string | null {
  const s = (raw ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  return s.length ? s : null;
}

export function isUk(raw: string | undefined | null): boolean {
  const s = normaliseCountry(raw);
  return s !== null && UK.has(s);
}

export type CountryRead =
  | { ok: true; country: string; source: 'POBOX' | 'STREET' }
  | { ok: false; reason: string };

/**
 * Xero contacts carry two addresses. POBOX is the one Xero prints on an
 * invoice as the billing address, so it wins; STREET is the fallback for a
 * contact where only one address was ever filled in. Cam's instruction was
 * billing address only, never delivery.
 *
 * Two addresses naming countries on OPPOSITE sides of the UK rule is not
 * something to resolve by precedence: one of them is wrong, and which one is
 * wrong is exactly what decides whether this customer pays 20% or nothing.
 * That refuses. Two addresses that disagree but both sit on the same side of
 * the rule (London and Manchester) do not refuse, because the answer is the
 * same either way.
 */
export function billingCountry(contact: any): CountryRead {
  const addrs: any[] = contact?.addresses ?? [];
  const pick = (t: string) => {
    const a = addrs.find((x) => x.addressType === t && normaliseCountry(x.country));
    return a ? String(a.country).trim() : null;
  };
  const pobox = pick('POBOX');
  const street = pick('STREET');

  if (pobox && street && isUk(pobox) !== isUk(street)) {
    return {
      ok: false,
      reason: `billing address says "${pobox}" and street address says "${street}", which fall on opposite sides of the UK VAT rule`,
    };
  }

  const country = pobox ?? street;
  if (!country) return { ok: false, reason: 'no country set on either address' };
  return { ok: true, country, source: pobox ? 'POBOX' : 'STREET' };
}

export type VatDecision = {
  taxType: string;
  country: string;
  countrySource: 'POBOX' | 'STREET';
  rule: 'uk-standard-rated' | 'non-uk-no-vat';
};

/**
 * The decision itself, returned rather than applied, so the caller can put it
 * in the response and the audit row. "Why does this invoice have no VAT on it"
 * should be answerable from the record, not by re-running this function.
 */
export function decideVat(entity: Entity, contact: any): VatDecision {
  const codes = VAT_CODES[entity];
  if (!codes) {
    throw Object.assign(new Error(`no VAT codes configured for entity "${entity}"`), { statusCode: 500 });
  }

  const read = billingCountry(contact);
  if (!read.ok) {
    throw Object.assign(
      new Error(
        `cannot determine VAT for contact "${contact?.name ?? contact?.contactID}": ${read.reason}. ` +
        `VAT follows the customer's location, so set the billing country on this contact in Xero and retry. Nothing was written.`,
      ),
      { statusCode: 422, code: 'VAT_COUNTRY_UNKNOWN' },
    );
  }

  const uk = isUk(read.country);
  return {
    taxType: uk ? codes.standard : codes.nonUk,
    country: read.country,
    countrySource: read.source,
    rule: uk ? 'uk-standard-rated' : 'non-uk-no-vat',
  };
}

// Per-entity, per-process. A Netlify cold start empties it, which is the
// correct trade: one extra read on a cold invocation against never serving a
// tax code the org stopped having.
const rateCache = new Map<string, Map<string, { name?: string; rate?: number }>>();

/**
 * The configured code has to be a code THIS org actually has. Xero would
 * reject an unknown taxType on its own, but its error does not say what the
 * valid options were; this one does, which is the difference between a
 * one-line fix and an afternoon. Revenue-applicable only, same filter
 * list_tax_rates uses, because these codes only ever go on a sales invoice.
 */
export async function assertTaxTypeExists(
  entity: string, taxType: string, client: any, tenantId: string,
): Promise<{ name?: string; rate?: number }> {
  let rates = rateCache.get(entity);
  if (!rates) {
    const r = await client.accountingApi.getTaxRates(tenantId);
    rates = new Map(
      (r.body.taxRates ?? [])
        .filter((t: any) => t.canApplyToRevenue)
        .map((t: any) => [t.taxType, { name: t.name, rate: t.effectiveRate }]),
    );
    rateCache.set(entity, rates!);
  }

  const hit = rates!.get(taxType);
  if (!hit) {
    throw Object.assign(
      new Error(
        `tax type "${taxType}" is configured for ${entity} but that org has no such revenue tax rate. ` +
        `Available: ${[...rates!.keys()].join(', ') || '(none)'}. Fix VAT_CODES in src/core/vat.ts.`,
      ),
      { statusCode: 500, code: 'VAT_CODE_NOT_IN_ORG' },
    );
  }
  return hit;
}
