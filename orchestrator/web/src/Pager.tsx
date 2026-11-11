/** How many rows a long table shows at once; a company's lists run to thousands. */
export const PAGE_SIZE = 50;

/**
 * Previous and next for a list shown a page at a time, and which page this is. `more`, when
 * the server says whether a next page exists, decides Next instead of the count, which can
 * lag a list that changed between pages.
 */
export function Pager({ page, total, pageSize = PAGE_SIZE, more, onPage, label }: { page: number; total: number; pageSize?: number; more?: boolean; onPage: (page: number) => void; label: string }) {
  const pages = Math.max(page, Math.ceil(total / pageSize));
  if (pages <= 1 && !more) return null;
  return (
    <nav className="pager" aria-label={label}>
      <button type="button" className="secondary small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span>Page {page} of {pages}</span>
      <button type="button" className="secondary small" disabled={more === undefined ? page >= pages : !more} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

/** The rows of one page, and the page itself held within range when the list shrinks. */
export function pageOf<T>(rows: T[], page: number, pageSize = PAGE_SIZE): { shown: T[]; page: number } {
  const last = Math.max(1, Math.ceil(rows.length / pageSize));
  const at = Math.min(page, last);
  return { shown: rows.slice((at - 1) * pageSize, at * pageSize), page: at };
}
