// Narrowing a long list by name as the visitor types, one page at a time.
//
// Archive items and ZIP collections can list thousands of files, so the
// library shows a filtered page rather than rendering them all. Matching is
// every whitespace-separated word, case-insensitively, anywhere in the name.

export const LIBRARY_PAGE_SIZE = 50;

export interface FilteredPage<T> {
  items: T[];
  /** 1-based, clamped into range. */
  page: number;
  pageCount: number;
  totalMatches: number;
}

function terms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  return terms(query).every((term) => haystack.includes(term));
}

export function filterAndPage<T>(
  entries: readonly T[],
  query: string,
  page: number,
  nameOf: (entry: T) => string,
  pageSize = LIBRARY_PAGE_SIZE,
): FilteredPage<T> {
  const words = terms(query);
  const matches = words.length === 0
    ? entries.slice()
    : entries.filter((entry) => {
      const name = nameOf(entry).toLowerCase();
      return words.every((word) => name.includes(word));
    });
  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  return {
    items: matches.slice((current - 1) * pageSize, current * pageSize),
    page: current,
    pageCount,
    totalMatches: matches.length,
  };
}
