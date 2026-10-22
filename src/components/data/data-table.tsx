"use client";

import * as React from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Column meta conventions:
 *  - meta.numeric: right-align the cell and header
 *  - meta.total: value (or (rows) => value) rendered in a totals footer row
 */
export interface DataTableColumnMeta<TData> {
  numeric?: boolean;
  total?: React.ReactNode | ((rows: TData[]) => React.ReactNode);
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  onRowClick?: (row: TData) => void;
  emptyMessage?: string;
  className?: string;
  /**
   * Pin the first column while the table scrolls sideways, so the reference
   * number stays visible. Below lg only - on desktop the table usually fits,
   * and a detaching column there is a change nobody asked for. Set false for
   * narrow tables that never overflow.
   */
  stickyFirstColumn?: boolean;
  /**
   * Register mode: the table box takes exactly the screen height left below
   * the title/filters, the rows scroll INSIDE it and the column header (with
   * the sort arrows) stays pinned — so the page itself never scrolls and the
   * filters stay put.
   */
  fillViewport?: boolean;
  /**
   * Register mode shows a plain "N records" line under the box; pages whose
   * own pagination bar already counts the rows turn it off.
   */
  showCount?: boolean;
}

/** Below this the box would show too few rows; the page scrolls instead. */
const MIN_FILL_HEIGHT = 240;

/**
 * Caps a register's table box at the screen height left between what sits
 * above it (header, title, filters) and below it (count, pagination, page
 * padding), so the rows scroll inside the box and the page itself never does.
 *
 * Each pass lifts the cap and measures the box at its natural height first —
 * a cap measured against a short list would otherwise stick when more rows
 * arrive. It's all done on the element in one go (no React state), so nothing
 * paints in between and the box keeps its scroll position. Re-measured on
 * window resize, page layout changes (the phone's Filters panel, chips
 * wrapping) and row changes.
 */
export function useFillHeight(enabled: boolean) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollTop = el.scrollTop;
        el.style.maxHeight = "";
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const below = document.documentElement.scrollHeight - (rect.bottom + window.scrollY);
        const cap = Math.max(MIN_FILL_HEIGHT, Math.floor(window.innerHeight - top - below));
        el.style.maxHeight = `${cap}px`;
        el.scrollTop = scrollTop;
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    // the table itself: rows added/removed don't resize a capped box
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      ro.disconnect();
      el.style.maxHeight = "";
    };
  }, [enabled]);

  return ref;
}

/**
 * A second, sideways scrollbar fixed above the column headings, linked to the
 * table box — a wide register can be slid to its far columns from the top,
 * without going down to the box's own bottom scrollbar. The two stay in step
 * whichever one moves (setting the same scrollLeft fires no scroll event, so
 * they don't ping-pong). It's only shown while the table is wider than its
 * box. The spacer inside it is sized to the table's full width.
 */
function useTopScrollbar(boxRef: React.RefObject<HTMLDivElement>, enabled: boolean) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const spacerRef = React.useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = React.useState(false);

  React.useEffect(() => {
    const box = boxRef.current;
    const bar = barRef.current;
    const spacer = spacerRef.current;
    if (!enabled || !box || !bar || !spacer) return;
    const size = () => {
      spacer.style.width = `${box.scrollWidth}px`;
      setOverflows(box.scrollWidth > box.clientWidth + 1);
      bar.scrollLeft = box.scrollLeft;
    };
    const fromBar = () => {
      box.scrollLeft = bar.scrollLeft;
    };
    const fromBox = () => {
      bar.scrollLeft = box.scrollLeft;
    };
    size();
    bar.addEventListener("scroll", fromBar, { passive: true });
    box.addEventListener("scroll", fromBox, { passive: true });
    const ro = new ResizeObserver(size);
    ro.observe(box);
    if (box.firstElementChild) ro.observe(box.firstElementChild);
    return () => {
      bar.removeEventListener("scroll", fromBar);
      box.removeEventListener("scroll", fromBox);
      ro.disconnect();
    };
  }, [boxRef, enabled]);

  return { barRef, spacerRef, overflows };
}

const PAGE_SIZES = [25, 50, 100];

/**
 * bg-card matches the surface the table sits on, so rows passing underneath
 * are hidden rather than showing through. The hairline plus a short shadow
 * marks the seam without drawing a full border.
 */
const STICKY_BASE =
  "sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border)),6px_0_8px_-8px_rgb(0_0_0/0.35)] lg:static lg:z-auto lg:bg-transparent lg:shadow-none";
const STICKY_CELL = `${STICKY_BASE} bg-card`;
/** the totals row sits on bg-muted/50, so its pinned cell has to match */
const STICKY_FOOT = `${STICKY_BASE} bg-muted`;

/*
 * Register mode pins the header to the top of the scrolling box and the
 * totals to its bottom. A collapsed table's cell borders scroll away with the
 * rows, so the seams are drawn as inset shadows on the cells instead: a
 * hairline plus a soft fade where the rows slide underneath. The first-column
 * variants keep the pinned column's right seam below lg.
 */
const HEAD_SEAM = "shadow-[inset_0_-1px_0_hsl(var(--border)),0_6px_8px_-8px_rgb(0_0_0/0.25)]";
const HEAD_SEAM_FIRST =
  "bg-sunken shadow-[inset_0_-1px_0_hsl(var(--border)),1px_0_0_0_hsl(var(--border)),6px_0_8px_-8px_rgb(0_0_0/0.35)] lg:shadow-[inset_0_-1px_0_hsl(var(--border)),0_6px_8px_-8px_rgb(0_0_0/0.25)]";
const FOOT_SEAM = "shadow-[inset_0_1px_0_hsl(var(--border)),0_-6px_8px_-8px_rgb(0_0_0/0.25)]";
const FOOT_SEAM_FIRST =
  "shadow-[inset_0_1px_0_hsl(var(--border)),1px_0_0_0_hsl(var(--border)),6px_0_8px_-8px_rgb(0_0_0/0.35)] lg:shadow-[inset_0_1px_0_hsl(var(--border)),0_-6px_8px_-8px_rgb(0_0_0/0.25)]";

export function DataTable<TData, TValue>({
  columns,
  data,
  onRowClick,
  emptyMessage = "No records found.",
  className,
  stickyFirstColumn = true,
  fillViewport = false,
  showCount = true,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const fillRef = useFillHeight(fillViewport);
  const topBar = useTopScrollbar(fillRef, fillViewport);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // register mode scrolls every row of the page inside its box — a second,
    // client-side page split under the server's pagination bar was clutter
    ...(fillViewport ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    initialState: { pagination: { pageSize: 25 } },
  });

  const hasTotals = columns.some(
    (c) => (c.meta as DataTableColumnMeta<TData> | undefined)?.total !== undefined
  );

  return (
    // min-w-0 so a wide table scrolls inside its own border rather than
    // stretching the page - without it the flex/grid parent refuses to shrink
    <div className={cn("min-w-0 space-y-2", className)}>
      <div className="min-w-0 rounded-md border">
        {/* sideways scrollbar fixed above the headings (desktop: phones
            swipe sideways and show no draggable bar anyway) */}
        {fillViewport && (
          <div
            ref={topBar.barRef}
            aria-hidden
            className={cn(
              "scroll-thin hidden overflow-x-auto overflow-y-hidden border-b",
              topBar.overflows && "md:block"
            )}
          >
            <div ref={topBar.spacerRef} className="h-px" />
          </div>
        )}
        <Table
          wrapperRef={fillViewport ? fillRef : undefined}
          wrapperClassName={fillViewport ? "scroll-thin overscroll-contain rounded-md" : undefined}
        >
          {/* pinned inside the scrolling box; z above the pinned first column */}
          <TableHeader className={cn(fillViewport && "sticky top-0 z-20")}>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header, idx) => {
                  const meta = header.column.columnDef.meta as
                    | DataTableColumnMeta<TData>
                    | undefined;
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        "whitespace-nowrap text-xs",
                        meta?.numeric && "text-right",
                        stickyFirstColumn && idx === 0 && STICKY_CELL,
                        fillViewport &&
                          (stickyFirstColumn && idx === 0 ? HEAD_SEAM_FIRST : HEAD_SEAM)
                      )}
                    >
                      {header.isPlaceholder ? null : canSort ? (
                        <button
                          type="button"
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-foreground",
                            meta?.numeric && "flex-row-reverse"
                          )}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && "cursor-pointer")}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                >
                  {row.getVisibleCells().map((cell, idx) => {
                    const meta = cell.column.columnDef.meta as
                      | DataTableColumnMeta<TData>
                      | undefined;
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "whitespace-nowrap",
                          meta?.numeric && "text-right tabular-nums",
                          stickyFirstColumn && idx === 0 && STICKY_CELL
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell
                  colSpan={columns.length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {hasTotals && data.length > 0 && (
            // register mode: totals stay in view at the bottom of the box
            <TableFooter className={cn(fillViewport && "sticky bottom-0 z-20 border-t-0")}>
              <TableRow className={cn(fillViewport && "hover:bg-transparent")}>
                {table.getVisibleLeafColumns().map((column, idx) => {
                  const meta = column.columnDef.meta as DataTableColumnMeta<TData> | undefined;
                  const total =
                    typeof meta?.total === "function"
                      ? (meta.total as (rows: TData[]) => React.ReactNode)(data)
                      : meta?.total;
                  return (
                    <TableCell
                      key={column.id}
                      className={cn(
                        meta?.numeric && "text-right tabular-nums",
                        stickyFirstColumn && idx === 0 && STICKY_FOOT,
                        fillViewport &&
                          (stickyFirstColumn && idx === 0 ? FOOT_SEAM_FIRST : FOOT_SEAM)
                      )}
                    >
                      {idx === 0 && total === undefined ? "Total" : total}
                    </TableCell>
                  );
                })}
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>

      {fillViewport ? (
        // register mode: no client-side pager — one count line at most
        showCount && (
          <div className="text-xs text-muted-foreground">
            {data.length} record{data.length === 1 ? "" : "s"}
          </div>
        )
      ) : (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <div>
          {data.length} record{data.length === 1 ? "" : "s"}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={String(table.getState().pagination.pageSize)}
            onValueChange={(v) => table.setPageSize(Number(v))}
          >
            <SelectTrigger className="h-8 w-[80px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((s) => (
                <SelectItem key={s} value={String(s)}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="whitespace-nowrap">
            Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      )}
    </div>
  );
}
