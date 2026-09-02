/**
 * Coverage name filter: conversations whose display name contains any configured
 * fragment must stay turned off, so the observer never stores or digests them.
 */

export function parseFilterTerms(raw: string | null | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

export function filterPatterns(terms: string[]): string[] {
  return terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
}

export function conversationNameMatchesFilter(name: string | null | undefined, terms: string[]): boolean {
  if (!name || !terms.length) return false;
  const haystack = name.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}
