import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseCountry, isUk, billingCountry, decideVat, VAT_CODES } from '../src/core/vat.ts';

const addr = (addressType: string, country: string | undefined) => ({ addressType, country });
const contact = (name: string, addresses: any[]) => ({ name, contactID: 'c-1', addresses });

test('country text is folded before comparison, because Xero stores what was typed', () => {
  assert.equal(normaliseCountry('United Kingdom'), 'UNITEDKINGDOM');
  assert.equal(normaliseCountry('U.K.'), 'UK');
  assert.equal(normaliseCountry('  gb  '), 'GB');
  assert.equal(normaliseCountry(''), null);
  assert.equal(normaliseCountry(undefined), null);
});

test('the UK is the UK however it was written', () => {
  for (const s of ['UK', 'U.K.', 'gb', 'GBR', 'United Kingdom', 'Great Britain', 'England', 'scotland', 'Northern Ireland']) {
    assert.equal(isUk(s), true, `${s} should read as UK`);
  }
  for (const s of ['Ireland', 'France', 'USA', 'Deutschland', 'New Zealand', '', undefined]) {
    assert.equal(isUk(s), false, `${s} should not read as UK`);
  }
});

test('the billing address is what is read', () => {
  const r = billingCountry(contact('X', [addr('STREET', 'France'), addr('POBOX', 'Ireland')]));
  assert.deepEqual(r, { ok: true, country: 'Ireland', source: 'POBOX' });
});

test('the delivery address is NEVER a fallback for a missing billing country', () => {
  // Cam's rule is billing only. An earlier version fell back to STREET when
  // POBOX had no country, which decided VAT from a delivery address - and
  // measured against Demo Company, that fallback was the path EVERY resolving
  // contact took, so it was the normal case rather than an edge one.
  const r = billingCountry(contact('X', [addr('POBOX', undefined), addr('STREET', 'United Kingdom')]));
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /no country on the billing address/);
  // Named in the refusal so it is easy to copy across, but copying it is a
  // person's decision.
  assert.match((r as any).reason, /delivery address says "United Kingdom"/);
});

test('a delivery address alone does not make a contact invoiceable', () => {
  assert.throws(
    () => decideVat('ff-events', contact('Delivery Only Ltd', [addr('STREET', 'United Kingdom')])),
    (e: any) => e.statusCode === 422 && e.code === 'VAT_COUNTRY_UNKNOWN',
  );
});

test('a contradicting delivery address is simply ignored, not resolved', () => {
  // Nothing to reconcile: the billing address is the answer, whatever the
  // delivery address says.
  const d = decideVat('ff-events', contact('X', [addr('POBOX', 'France'), addr('STREET', 'United Kingdom')]));
  assert.equal(d.country, 'France');
  assert.equal(d.rule, 'non-uk-no-vat');
  assert.equal(d.countrySource, 'POBOX');
});

test('no address at all refuses, and says what to fix', () => {
  const r = billingCountry(contact('X', [addr('POBOX', undefined)]));
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /no country on the billing address/);
});

test("Cam's rule: UK customer is charged VAT, anyone else is not", () => {
  const uk = decideVat('ff-events', contact('Sage (UK) Ltd', [addr('POBOX', 'United Kingdom')]));
  assert.equal(uk.taxType, VAT_CODES['ff-events'].standard);
  assert.equal(uk.rule, 'uk-standard-rated');
  assert.equal(uk.country, 'United Kingdom');
  assert.equal(uk.countrySource, 'POBOX');   // always: billing, never delivery

  const fr = decideVat('ff-events', contact('Acme SAS', [addr('POBOX', 'France')]));
  assert.equal(fr.taxType, VAT_CODES['ff-events'].nonUk);
  assert.equal(fr.rule, 'non-uk-no-vat');
});

test('an unknown country is treated as non-UK, not as an error', () => {
  // The rule is binary: UK or not. A country this file has never heard of is
  // still not the UK, and that answer is correct without a country list.
  const d = decideVat('ff-events', contact('Acme Pte', [addr('POBOX', 'Singapore')]));
  assert.equal(d.rule, 'non-uk-no-vat');
});

test('a contact with no country halts the invoice instead of defaulting to 20%', () => {
  assert.throws(
    () => decideVat('ff-events', contact('No Address Ltd', [])),
    (e: any) => e.statusCode === 422 && e.code === 'VAT_COUNTRY_UNKNOWN' && /Nothing was written/.test(e.message),
  );
});

test('every configured entity has both codes set', () => {
  for (const [entity, codes] of Object.entries(VAT_CODES)) {
    assert.ok(codes.standard, `${entity} has no standard code`);
    assert.ok(codes.nonUk, `${entity} has no non-UK code`);
    assert.notEqual(codes.standard, codes.nonUk, `${entity} uses one code for both sides of the rule`);
  }
});
