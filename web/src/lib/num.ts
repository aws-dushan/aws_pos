/** Numbers typed by users and rounding (the one copy of each; see 06_Numeric_Precision_Rounding.md). */

/** Parses a typed number ("1,250.5" → 1250.5); NaN when blank or not a number. */
export const parseNum = (s: string | null | undefined): number => (!s || s.trim() === "" ? NaN : Number(s.replace(/,/g, "").trim()));

/** Like `parseNum`, but `blank` when the text is empty (e.g. 0 for an empty debit, null for an optional field); NaN when not a number. */
export function parseNumOr<T>(s: string | null | undefined, blank: T): number | T {
  return !s || s.trim() === "" ? blank : parseNum(s);
}

const formats = new Map<number, Intl.NumberFormat>();
/** An amount with `decimals` decimals (the currency's own: JPY 0, KWD 3). */
export function fmtIn(n: number, decimals: number) {
  let f = formats.get(decimals);
  if (!f) formats.set(decimals, (f = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })));
  return f.format(n);
}

/** Rounds to `decimals` (half away from zero, like the server). */
export const roundTo = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
};

/** Rounds to the 4 decimals a price may have. */
export const round4 = (n: number) => roundTo(n, 4);
