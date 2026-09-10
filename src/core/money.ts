// Amounts exist as integer minor units. These two functions are the ONLY
// places a decimal appears, because xero-node types every amount as `number`
// and the boundary is a double whether we like it or not.

/** minor units -> the decimal string Xero wants. Integer maths only. */
export function toDecimal(minor: number, dp = 2): string {
  if (!Number.isInteger(minor)) throw new Error(`not minor units: ${minor}`);
  const s = Math.abs(minor).toString().padStart(dp + 1, '0');
  return `${minor < 0 ? '-' : ''}${s.slice(0, -dp)}.${s.slice(-dp)}`;
}

/**
 * A Xero number -> minor units. Rejects excess precision rather than rounding
 * it: measured, Math.round(3487.455*100)=348746 while toFixed(2) gives 348745,
 * and that value is the live tracker units bug. A silent round here would be
 * us creating the penny variance instead of catching it.
 */
export function fromXero(n: number, dp = 2): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`not a number: ${n}`);
  const fixed = n.toFixed(dp);
  if (Number(fixed) !== n) throw new Error(`amount ${n} carries more than ${dp} decimal places`);
  return Number(fixed.replace('.', ''));
}

/**
 * Split a total across weighted lines so the parts sum to the total EXACTLY.
 * Largest-remainder method, integer arithmetic only — no float anywhere, so
 * there is no rounding to drift. Ties go to the earliest line, which makes the
 * result deterministic and therefore safe inside an idempotent request hash.
 *
 * This is §4.5 stage 5: line amounts come from the tracker allocation, and the
 * allocation has to add up before Xero ever sees it.
 */
export function allocate(totalMinor: number, weights: number[]): number[] {
  if (!Number.isInteger(totalMinor)) throw new Error(`not minor units: ${totalMinor}`);
  if (!weights.length) throw new Error('no weights');
  if (weights.some((w) => !Number.isInteger(w) || w < 0)) throw new Error('weights must be non-negative integers');
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must sum to more than zero');

  const num = weights.map((w) => totalMinor * w);
  const parts = num.map((n) => Math.floor(n / sum));
  const rems = num.map((n) => n % sum);

  // Hand the spare units to the largest remainders, earliest line breaking ties.
  const order = rems.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
  let spare = totalMinor - parts.reduce((a, b) => a + b, 0);
  for (let k = 0; spare > 0; k++, spare--) parts[order[k % order.length].i] += 1;

  const check = parts.reduce((a, b) => a + b, 0);
  if (check !== totalMinor) throw new Error(`allocation lost money: ${check} != ${totalMinor}`);
  return parts;
}
