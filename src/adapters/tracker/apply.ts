// The thin, swappable "how to write it" layer. planRollForward decides WHAT
// to write; this decides HOW. Production's real target is Google Sheets
// (§4.5 stage 7: "in place, no formula loss") - this xlsx adapter exists for
// local testing against the file this session has been verifying against.
// Swap point: replace readExistingRows/applyFill's bodies with Sheets API
// calls; planRollForward and its tests do not change at all.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExistingRow, RowValues, Section } from './rollforward.ts';
const run = promisify(execFile);

const PY = (code: string, args: string[]) =>
  run('python3', ['-c', code, ...args], { maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);

export async function readExistingRows(file: string, section: Section): Promise<ExistingRow[]> {
  const out = await PY(`
import sys, json, openpyxl
ws = openpyxl.load_workbook(sys.argv[1])['2026 Invoice tracker']
rows = []
for r in range(int(sys.argv[2]), int(sys.argv[3])+1):
    rows.append({"row": r, "d": ws.cell(r,4).value, "e": ws.cell(r,5).value,
                 "f": ws.cell(r,6).value, "g": ws.cell(r,7).value})
print(json.dumps(rows))`,
    [file, String(section.dataStart), String(section.dataEnd)]);
  return JSON.parse(out);
}

/**
 * Fills a row that is already inside the section's existing formula range -
 * the ONLY case this ever runs, by construction of planRollForward. No
 * formula is written or altered, so none of the §4.1 hazards apply here.
 */
export async function applyFill(file: string, row: number, v: RowValues): Promise<void> {
  await PY(`
import sys, json, openpyxl
from openpyxl.styles import Font
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['2026 Invoice tracker']
r = int(sys.argv[2])
v = json.loads(sys.argv[3])
ws.cell(r,4).value = v['d']
ws.cell(r,5).value = v['e']; ws.cell(r,5).number_format = '#,##0'
ws.cell(r,6).value = v['f']
ws.cell(r,7).value = v['g']
ws.cell(r,7).hyperlink = v['gLink']
ws.cell(r,7).font = Font(name='Arial', size=11, color='0563C1', underline='single')
ws.cell(r,8).value = v['h']
ws.cell(r,9).value = v['i']
wb.save(sys.argv[1])`,
    [file, String(row), JSON.stringify(v)]);
}

/**
 * Updates a placeholder row IN PLACE, once a human has confirmed the match
 * planRollForward flagged. Never called automatically - see rollforward.ts's
 * placeholder-detection comment for why. D is left untouched deliberately:
 * "Bound" staying "Bound" (rather than being overwritten with the Xero legal
 * name) preserves whatever the human originally wrote there.
 */
export async function applyPlaceholderUpdate(file: string, row: number, v: RowValues): Promise<void> {
  await PY(`
import sys, json, openpyxl
from openpyxl.styles import Font
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['2026 Invoice tracker']
r = int(sys.argv[2])
v = json.loads(sys.argv[3])
ws.cell(r,6).value = v['f']
ws.cell(r,7).value = v['g']
ws.cell(r,7).hyperlink = v['gLink']
ws.cell(r,7).font = Font(name='Arial', size=11, color='0563C1', underline='single')
ws.cell(r,8).value = v['h']
ws.cell(r,9).value = v['i']
wb.save(sys.argv[1])`,
    [file, String(row), JSON.stringify(v)]);
}
