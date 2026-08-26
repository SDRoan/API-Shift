/**
 * String heuristics used by rename inference. Pure, no dependencies.
 * These decide whether a removal plus an addition is really a rename, so they
 * stay deliberately conservative. A false rename makes a codemod rewrite
 * correct code, which is worse than missing a rename entirely.
 */

/** Standard Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length] ?? 0;
}

/** Edit distance mapped to 0..1, where 1 means identical. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Lowercase and strip separators, so userId, user_id, and USER-ID all collapse. */
export function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

/**
 * Whether two field names look like the same concept renamed. Covers the three
 * shapes that show up in real specs: a casing change (userId to user_id), a unit
 * suffix (amount to amount_cents), and a small spelling edit (recipient to
 * receipient).
 */
export function namesRelated(from: string, to: string): boolean {
  const a = normalizeName(from);
  const b = normalizeName(to);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  const addedLength = longer.length - shorter.length;

  // A unit or qualifier suffix, for example amount to amount_cents. The added
  // part is capped so amount does not pair with amountOfSomethingElseEntirely.
  if (longer.startsWith(shorter) && addedLength <= 8) return true;

  // A prefix qualifier, for example id to charge_id.
  if (longer.endsWith(shorter) && addedLength <= 8) return true;

  return similarity(a, b) >= 0.7;
}

/**
 * Path similarity ignoring template parameter names, so /charges/{id} and
 * /payments/{chargeId} compare on their literal segments.
 */
export function pathSimilarity(from: string, to: string): number {
  const strip = (p: string): string => p.replace(/\{[^}]*\}/g, '{}');
  return similarity(strip(from), strip(to));
}
