// §1.9 / §2.5: "the mapping is arbitrary and must be held as configuration,
// not derived." This is that configuration. Verified against the live file
// on 2026-09-09 (POC-PLAN.md §8b) - not transcribed from the spec blind.
//
// Only FFE is populated. TN's Core-tab-driven "Booked" column (§2.4) makes
// its write path structurally different - it needs its own config once
// built, not a copy-paste of this shape.

export type Section = {
  event: string;
  sheet: 'FFE';
  header: number;
  dataStart: number;
  dataEnd: number;
  totalRow: number;
};

// event name (normalised - see normalizeEventName) -> section. Row numbers
// are the file's CURRENT numbering as of the last verified read. A manual
// row-insertion (§4.1) changes these and this config must be updated by
// hand alongside it - that coupling is deliberate, not a TODO.
export const FFE_SECTIONS: Record<string, Section> = {
  'davos':               { event: 'Davos',               sheet: 'FFE', header: 34,  dataStart: 35,  dataEnd: 36,  totalRow: 37 },
  'ff india':            { event: 'FF India',            sheet: 'FFE', header: 39,  dataStart: 40,  dataEnd: 43,  totalRow: 44 },
  'measa':               { event: 'MEASA',               sheet: 'FFE', header: 46,  dataStart: 47,  dataEnd: 55,  totalRow: 56 },
  'fo abu dhabi':        { event: 'FO Abu Dhabi',         sheet: 'FFE', header: 58,  dataStart: 59,  dataEnd: 60,  totalRow: 61 },
  'govtech':             { event: 'GovTech',              sheet: 'FFE', header: 63,  dataStart: 64,  dataEnd: 69,  totalRow: 70 },
  'asia deeptech':       { event: 'Asia Deeptech',        sheet: 'FFE', header: 72,  dataStart: 73,  dataEnd: 74,  totalRow: 75 },
  'human x':             { event: 'FoundersX / Human X',  sheet: 'FFE', header: 77,  dataStart: 78,  dataEnd: 81,  totalRow: 82 },
  'family office uk':    { event: 'Family Office UK',     sheet: 'FFE', header: 84,  dataStart: 85,  dataEnd: 97,  totalRow: 98 },
  'global':              { event: 'Global',               sheet: 'FFE', header: 100, dataStart: 101, dataEnd: 140, totalRow: 141 },
  'enterprise britain':  { event: 'Enterprise Britain',   sheet: 'FFE', header: 143, dataStart: 144, dataEnd: 146, totalRow: 147 },
  'vc forum':            { event: 'VC Forum',             sheet: 'FFE', header: 149, dataStart: 150, dataEnd: 155, totalRow: 156 },
  'europe100':           { event: 'Europe100',            sheet: 'FFE', header: 158, dataStart: 159, dataEnd: 161, totalRow: 162 },
  'asia':                { event: 'Asia',                 sheet: 'FFE', header: 164, dataStart: 165, dataEnd: 180, totalRow: 181 },
  'europe':              { event: 'Europe',                sheet: 'FFE', header: 183, dataStart: 184, dataEnd: 193, totalRow: 194 },
  'family office asia':  { event: 'Family Office Asia',   sheet: 'FFE', header: 196, dataStart: 197, dataEnd: 200, totalRow: 201 },
  'north america':       { event: 'North America',        sheet: 'FFE', header: 203, dataStart: 204, dataEnd: 211, totalRow: 212 },
  'cmo forum':           { event: 'CMO Forum',             sheet: 'FFE', header: 214, dataStart: 215, dataEnd: 220, totalRow: 221 },
  'cfo forum':           { event: 'CFO Forum',             sheet: 'FFE', header: 223, dataStart: 224, dataEnd: 237, totalRow: 238 },
  'ai alliance':         { event: 'AI Alliance',           sheet: 'FFE', header: 240, dataStart: 241, dataEnd: 244, totalRow: 245 },
  'vc drinks':           { event: 'VC Drinks',             sheet: 'FFE', header: 247, dataStart: 248, dataEnd: 250, totalRow: 251 },
  'dinners':             { event: 'Dinners / Bespoke',    sheet: 'FFE', header: 254, dataStart: 255, dataEnd: 263, totalRow: 264 },
  'human x amsterdam':   { event: 'Human X Amsterdam',    sheet: 'FFE', header: 266, dataStart: 267, dataEnd: 267, totalRow: 268 },
  'itf commission':      { event: 'ITF Commission',        sheet: 'FFE', header: 270, dataStart: 271, dataEnd: 272, totalRow: 273 },
  'ai hub':              { event: 'AI Hub',                sheet: 'FFE', header: 275, dataStart: 276, dataEnd: 276, totalRow: 277 },
};

/**
 * Event names in the wild are inconsistent ("Founders Forum Global",
 * "FF Global 2026", "Global") - this is a small, explicit alias table, not
 * fuzzy matching. An unmapped name must fail loudly (undefined), never guess.
 */
const ALIASES: Record<string, keyof typeof FFE_SECTIONS> = {
  'founders forum global': 'global',
  'ff global': 'global',
  'europe 100': 'europe100',
  // the tracker's own section header literally reads "FoundersX / Human X" -
  // both names refer to the same section, found live (SVB, INV-23913).
  'founders x': 'human x',
  'foundersx': 'human x',
  // every section also resolves by its own key - "CFO Forum" -> 'cfo forum' etc.
  ...Object.fromEntries(Object.keys(FFE_SECTIONS).map((k) => [k, k as keyof typeof FFE_SECTIONS])),
};

export function resolveSection(eventName: string): Section | undefined {
  const key = ALIASES[eventName.trim().toLowerCase()];
  return key ? FFE_SECTIONS[key] : undefined;
}

/**
 * Free text (an invoice line description, a Slack message) rarely equals an
 * event name exactly - "Sponsorship Agreement for Founders CFO Forum" needs
 * to match the section 'CFO Forum'. Longest alias found as a substring wins,
 * so "cfo forum" beats a shorter accidental match. No match -> undefined,
 * never a guess.
 */
export function findSectionInText(text: string): Section | undefined {
  const lower = text.toLowerCase();
  const hit = Object.keys(ALIASES).filter((a) => lower.includes(a)).sort((a, b) => b.length - a.length)[0];
  return hit ? FFE_SECTIONS[ALIASES[hit]] : undefined;
}
