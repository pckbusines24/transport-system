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
}

/** Below this the box would show too few rows; the page scrolls instead. */
const MIN_FILL_HEIGHT = 240;

/**
 * Height for a register's table box: the viewport minus everything above it
 * (header, title, filters) and everything below it (record count, pagination,
 * page padding). Re-measured when the window or the page layout changes —
 * e.g. the phone's Filters panel opening, or filter chips wrapping.
 */
function useFillHeight(enabled: boolean) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [height, setHeight] = React.useState<number | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        // what sits under the box doesn't depend on the box's own height, so
        // setting it can't feed back into the next measurement
        const below = document.documentElement.scrollHeight - (rect.bottom + window.scrollY);
        const next = Math.max(MIN_FILL_HEIGHT, Math.floor(window.innerHeight - top - below));
        setHeight((prev) => (prev === next ? prev : next));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    const ro = new ResizeObserver(measure);
    ro.observe(document.body);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      ro.disconnect();
    };
  }, [enabled]);

  return { ref, height };
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

export function DataTable<TData, TValue>({
  columns,
  data,
  onRowClick,
  emptyMessage = "No records found.",
  className,
  stickyFirstColumn = true,
  fillViewport = false,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const fill = useFillHeight(fillViewport);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
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
        <Table
          wrapperRef={fillViewport ? fill.ref : undefined}
          wrapperClassName={fillViewport ? "overscroll-contain" : undefined}
          wrapperStyle={fillViewport && fill.height ? { maxHeight: fill.height } : undefined}
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
                        stickyFirstColumn && idx === 0 && STICKY_CELL
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
            <TableFooter>
              <TableRow>
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
                        stickyFirstColumn && idx === 0 && STICKY_FOOT
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
    </div>
  );
}
