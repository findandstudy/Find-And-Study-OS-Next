import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { clampClientPaginationPage } from "@/lib/tablePagination";

interface TablePaginationProps {
  currentPage: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}

export const TABLE_PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200, 500, 1000, 5000] as const;

export function TablePagination({
  currentPage,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [...TABLE_PAGE_SIZE_OPTIONS],
}: TablePaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const from = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, totalItems);

  function getVisiblePages(): (number | "...")[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: (number | "...")[] = [1];
    if (currentPage > 3) pages.push("...");
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    if (currentPage < totalPages - 2) pages.push("...");
    if (totalPages > 1) pages.push(totalPages);
    return pages;
  }

  if (totalItems === 0 && !onPageSizeChange) return null;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-2 py-3">
      <div className="text-sm text-muted-foreground">
        {totalItems > 0 ? (
          <span>{from}–{to} / {totalItems}</span>
        ) : (
          <span>No records</span>
        )}
      </div>

      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <div className="flex items-center gap-1.5 mr-4">
            <span className="text-sm text-muted-foreground whitespace-nowrap">Rows:</span>
            <Select value={String(pageSize)} onValueChange={v => onPageSizeChange(Number(v))}>
              <SelectTrigger className="h-8 w-[70px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map(s => (
                  <SelectItem key={s} value={String(s)}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(1)}
            disabled={currentPage <= 1}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          {getVisiblePages().map((p, i) =>
            p === "..." ? (
              <span key={`e${i}`} className="px-1 text-muted-foreground text-sm">...</span>
            ) : (
              <Button
                type="button"
                key={p}
                variant={p === currentPage ? "default" : "outline"}
                size="icon"
                className="h-8 w-8 text-sm"
                onClick={() => onPageChange(p as number)}
              >
                {p}
              </Button>
            )
          )}

          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage >= totalPages}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function useTablePagination(defaultPageSize = 25) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeRaw] = useState(defaultPageSize);
  const totalRef = useRef<number | null>(null);

  // `paginate()` is optional: server-side lists pass page/limit to the API and
  // render the returned page directly. Reset this marker on every render so
  // only a client-side `paginate()` call from the current render enables the
  // out-of-range clamp below.
  totalRef.current = null;

  function setPageSize(size: number) {
    setPageSizeRaw(size);
    setPage(1);
  }

  function resetPage() {
    setPage(1);
  }

  function paginate<T>(items: T[]): { paged: T[]; total: number } {
    const total = items.length;
    totalRef.current = total;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    return { paged: items.slice(start, start + pageSize), total };
  }

  // Clamp an out-of-range page (e.g. the data shrank while we were on a later
  // page) AFTER the render commits — never during it. The previous version
  // called setPage() inside paginate(), which runs in the render phase, so it
  // scheduled a state update mid-render; under certain prod data/render timings
  // that can trip React's update-depth guard (minified error #185). Doing the
  // clamp in an effect keeps behaviour identical (the page still snaps back into
  // range) while staying loop-safe: once page is within range the condition is
  // false and no further update is scheduled.
  useEffect(() => {
    const safePage = clampClientPaginationPage(page, pageSize, totalRef.current);
    if (safePage !== page) setPage(safePage);
  });

  return { page, pageSize, setPage, setPageSize, resetPage, paginate };
}
