import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Server-rendered pager for register/report pages. Page state lives in the
 * `page` search param; all other params are preserved so filters survive
 * paging (FilterBar drops `page` whenever a filter changes).
 */
export function PaginationBar({
  page,
  pageSize,
  total,
  basePath,
  searchParams,
  hideSinglePage = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
  /** the copy above the table: nothing to page through -> render nothing,
      rather than a second "N rows" line */
  hideSinglePage?: boolean;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) {
    if (hideSinglePage) return null;
    return (
      <div className="flex items-center justify-end text-xs text-muted-foreground">
        {total} row{total === 1 ? "" : "s"}
      </div>
    );
  }
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== "page") sp.set(k, v);
    }
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">
        {first}–{last} of {total} rows
      </span>
      <div className="flex items-center gap-1">
        <Button asChild={page > 1} size="sm" variant="outline" disabled={page <= 1}>
          {page > 1 ? (
            <Link href={href(page - 1)}>
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </Link>
          ) : (
            <span>
              <ChevronLeft className="mr-1 h-4 w-4" /> Prev
            </span>
          )}
        </Button>
        <span className="px-2 text-xs tabular-nums text-muted-foreground">
          {page} / {pages}
        </span>
        <Button asChild={page < pages} size="sm" variant="outline" disabled={page >= pages}>
          {page < pages ? (
            <Link href={href(page + 1)}>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </Link>
          ) : (
            <span>
              Next <ChevronRight className="ml-1 h-4 w-4" />
            </span>
          )}
        </Button>
      </div>
    </div>
  );
}

/** Clamp the `page` search param to a usable positive integer. */
export function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
