// Cross-referenced against the real FFE chart of accounts (2026-09-09 export,
// see chart-of-accounts.json). Every invoice this session created used
// account_code '200' — the DEMO COMPANY's generic Sales account. It does not
// exist in this real chart at all. This is the fix, staged for when
// production credentials exist: it does NOT wire into today's Demo Company
// runs, because sending a real-org code to the Demo Company would just fail.
//
// Confident matches only - an exact "Sponsorship Income - {Section}" or
// equally unambiguous name. Where the chart genuinely doesn't resolve
// cleanly, the section is OMITTED here rather than guessed at - see the
// unresolved list below, which names the real reason for each.
import coa from './chart-of-accounts.json' with { type: 'json' };

export const REVENUE_ACCOUNT_BY_SECTION: Record<string, { code: string; taxCode: string }> = {
  'davos':              { code: '40950', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - FF Davos
  'measa':              { code: '40900', taxCode: 'Zero Rated Income' },     // Sponsorship Income - MEASA (genuinely zero-rated by default)
  'govtech':            { code: '41010', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - GovTech
  'asia deeptech':      { code: '43010', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Asia Deep Tech
  'human x':            { code: '43005', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Human X (NOT 40708 VC Income - FoundersX, a different line - see below)
  'enterprise britain': { code: '40655', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Enterprise Britain
  'europe100':          { code: '40300', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Europe100
  'asia':               { code: '40200', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Asia
  'europe':             { code: '40400', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Europe
  'family office asia': { code: '40505', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Family Office Asia
  'north america':      { code: '40100', taxCode: 'Zero Rated Income' },     // Sponsorship Income - North America (genuinely zero-rated by default)
  'cmo forum':          { code: '40805', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - CMO Forum
  'cfo forum':          { code: '40080', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - CFO Forum
  'ai alliance':        { code: '43003', taxCode: '20% (VAT on Income)' },   // AI Alliance
  'vc drinks':          { code: '40705', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - VC Drinks
  'dinners':            { code: '40601', taxCode: '20% (VAT on Income)' },   // Sponsorship Income - Dinners
  'itf commission':     { code: '43000', taxCode: '20% (VAT on Income)' },   // "ITF Commision" [sic] in Xero - code matches, name spelling doesn't
};

/**
 * Sections with NO confident match, and the real reason each one is
 * unresolved - not "missing", genuinely ambiguous. §1.9's own rule ("must be
 * held as configuration, not derived") applies here too: guessing one of
 * these into the table above would be worse than leaving it out.
 */
export const UNRESOLVED_SECTIONS: Record<string, string> = {
  // Re-scanned against all 56 revenue accounts unfiltered on 2026-09-09, not
  // just names containing "sponsorship"/"VC income" - one real new candidate
  // turned up (VC Summit), two others got a stronger lead. None crosses the
  // "exact, unambiguous name" bar this file requires for a confident match,
  // so all seven stay here - a hypothesis is not a match.
  'global': 'Two candidates, neither confirmed: "40720 VC Income - Global" (name matches, but ' +
    '"VC Income" elsewhere in this chart is consistently a DIFFERENT line from the equivalent ' +
    '"Sponsorship Income -" line for the same event - e.g. Europe has both 40400 Sponsorship and ' +
    '40740 VC Income as separate accounts) or "40000 Sponsorship Income - London" (lowest code in ' +
    'the whole Revenue block, the shape of a default/flagship account, and FF Global has ' +
    'historically been London-based). Leading hypothesis: 40000, precisely because the VC-Income/' +
    'Sponsorship-Income split elsewhere suggests 40720 is Global\'s VC-attendee line, not its ' +
    'sponsorship line. Still a hypothesis, not a match - FFE\'s single biggest revenue line ' +
    '(£3.5M+) is exactly where a wrong guess costs the most. Needs Kevin, not inference.',
  'family office uk': 'Only a generic "40500 Sponsorship Income - Family Office" exists, no ' +
    '"-UK" suffix distinct from Family Office Asia (40505) or Family Office MEASA (40501). ' +
    'Leading hypothesis: 40500 is the unqualified/UK-default line, not confirmed.',
  'fo abu dhabi': 'No "Family Office Abu Dhabi" line at all, even in the unfiltered 56-account ' +
    'scan - only generic Family Office (40500), MEASA (40501), and Asia (40505). Genuinely ' +
    'unmapped, no candidate at all.',
  'vc forum': 'No "VC Forum" line. New candidate from the fuller scan: "40060 Sponsorship Income ' +
    '- VC Summit" - "Summit" and "Forum" naming the same kind of gathering is plausible but not ' +
    'confirmed as the same event. The generic "40700 VC Income" is the fallback if not.',
  'human x amsterdam': 'No "Human X Amsterdam" line distinct from the main "43005 Sponsorship ' +
    'Income - Human X", even unfiltered. May share the parent account or may not exist as its ' +
    'own GL line.',
  'ai hub': 'No "Sponsorship Income - AI Hub" line. "44500 Revenue Share - London AI Hub Ltd" ' +
    'exists but is a different revenue TYPE (a revenue-share arrangement, not sponsorship) - ' +
    'using it would misclassify the income even if the name looks related.',
  'ff india': 'The chart has "40650 Sponsorship Income - India", not "FF India" - plausibly the ' +
    'same thing, not confirmed as the tracker section\'s exact match.',
};

export function lookupRevenueAccount(sectionKey: string) {
  return REVENUE_ACCOUNT_BY_SECTION[sectionKey.toLowerCase()];
}

/** The account row itself, for display/audit - not just the code. */
export function accountDetail(code: string) {
  return (coa.accounts as { code: string }[]).find((a) => a.code === code);
}
