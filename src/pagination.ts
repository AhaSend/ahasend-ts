import type { PaginatedResponse, PaginationParams } from "./types/common.js";

/**
 * Walk a cursor-paginated endpoint as an async iterable.
 *
 * Stops when the API reports `has_more: false` or omits `next_cursor`.
 * Filter parameters are preserved across pages — only the cursor is replaced.
 */
export async function* paginate<T, P extends PaginationParams>(
  fetchPage: (params: P) => Promise<PaginatedResponse<T>>,
  initial: P,
): AsyncGenerator<T, void, undefined> {
  let params: P = { ...initial };

  while (true) {
    const page = await fetchPage(params);
    for (const item of page.data) yield item;

    if (!page.pagination.has_more) return;
    const next = page.pagination.next_cursor;
    if (!next) return;

    const { before: _before, ...remainingParams } = params;
    params = { ...remainingParams, after: next } as P;
  }
}

/**
 * Drain a paginated endpoint into an array. Convenience wrapper around
 * `paginate` for callers who genuinely want the whole list.
 */
export async function collect<T, P extends PaginationParams>(
  fetchPage: (params: P) => Promise<PaginatedResponse<T>>,
  initial: P,
  limit = Infinity,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(fetchPage, initial)) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
