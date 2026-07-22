import type { PaginatedResponse, PaginationParams } from "./types/common.js";

/**
 * Walk a cursor-paginated endpoint as an async iterable.
 *
 * Stops when the API reports `has_more: false` or omits the cursor for the
 * traversal direction. Filter parameters are preserved across pages — only
 * the active cursor is replaced.
 */
export async function* paginate<T, P extends PaginationParams>(
  fetchPage: (params: P) => Promise<PaginatedResponse<T>>,
  initial: P,
): AsyncGenerator<T, void, undefined> {
  let params: P = { ...initial };
  const backwards = initial.before !== undefined;
  const initialCursor = backwards ? initial.before : initial.after;
  const seenCursors = new Set(initialCursor === undefined ? [] : [initialCursor]);

  while (true) {
    const page = await fetchPage(params);
    for (const item of page.data) yield item;

    if (!page.pagination.has_more) return;
    const cursor = backwards ? page.pagination.previous_cursor : page.pagination.next_cursor;
    if (!cursor) return;
    if (seenCursors.has(cursor)) {
      throw new Error("Pagination cursor did not advance");
    }
    seenCursors.add(cursor);

    if (backwards) {
      const { after: _after, ...remainingParams } = params;
      params = { ...remainingParams, before: cursor } as P;
    } else {
      const { before: _before, ...remainingParams } = params;
      params = { ...remainingParams, after: cursor } as P;
    }
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
