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

test('billing address wins over street address', () => {
  const r = billingCountry(contact('X', [addr('STREET', 'France'), addr('POBOX', 'Ireland')]));
  assert.deepEqual(r, { ok: true, country: 'Ireland', source: 'POBOX' });
});

test('street address is the fallback when only it is filled in', () => {
  const r = billingCountry(contact('X', [addr('POBOX', undefined), addr('STREET', 'United Kingdom')]));
  assert.deepEqual(r, { ok: true, country: 'United Kingdom', source: 'STREET' });
});

test('two addresses on opposite sides of the rule refuse rather than pick one', () => {
  const r = billingCountry(contact('X', [addr('POBOX', 'United Kingdom'), addr('STREET', 'France')]));
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /opposite sides/);
});

test('two addresses that disagree but agree on the VAT answer do not refuse', () => {
  // London vs Manchester: both UK, same tax code either way, nothing to resolve.
  const r = billingCountry(contact('X', [addr('POBOX', 'United Kingdom'), addr('STREET', 'England')]));
  assert.equal(r.ok, true);
});

test('no country anywhere refuses, and says what to fix', () => {
  const r = billingCountry(contact('X', [addr('POBOX', undefined)]));
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /no country/);
});

test("Cam's rule: UK customer is charged VAT, anyone else is not", () => {
  const uk = decideVat('ff-events', contact('Sage (UK) Ltd', [addr('POBOX', 'United Kingdom')]));
  assert.equal(uk.taxType, VAT_CODES['ff-events'].standard);
  assert.equal(uk.rule, 'uk-standard-rated');
  assert.equal(uk.country, 'United Kingdom');
  assert.equal(uk.countrySource, 'POBOX');

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
