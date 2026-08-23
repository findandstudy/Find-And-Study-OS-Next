import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter as FilterIcon, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { TableHead } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export type ColumnSortDir = "asc" | "desc";

export type ColumnFilterOption = { value: string; label: string };

export type ColumnFilterConfig =
  | {
      type: "text";
      value: string;
      onChange: (v: string) => void;
      placeholder?: string;
      label?: string;
    }
  | {
      type: "select";
      value: string;
      onChange: (v: string) => void;
      options: ColumnFilterOption[];
      allLabel?: string;
      allValue?: string;
      /** Hide the auto-injected "All" option (e.g. gated by permissions). */
      hideAll?: boolean;
      label?: string;
    }
  | {
      type: "searchable-select";
      value: string;
      onChange: (v: string) => void;
      options: ColumnFilterOption[];
      allLabel?: string;
      allValue?: string;
      label?: string;
      placeholder?: string;
    };

export interface ColumnHeaderProps<TKey extends string = string> {
  label: string;
  className?: string;
  align?: "left" | "right" | "center";
  sort?: {
    sortKey: TKey;
    current: { key: TKey; dir: ColumnSortDir };
    onSort: (k: TKey) => void;
  };
  filter?: ColumnFilterConfig;
  /** Render as raw <th> instead of shadcn <TableHead>. */
  asTh?: boolean;
  /** Extra classes for the inner clickable wrapper (rare). */
  innerClassName?: string;
}

function isFilterActive(f: ColumnFilterConfig | undefined): boolean {
  if (!f) return false;
  if (f.type === "text") return f.value.trim().length > 0;
  if (f.type === "select") return f.value !== (f.allValue ?? "all");
  if (f.type === "searchable-select") return f.value !== (f.allValue ?? "all");
  return false;
}

function SearchableSelectFilter({
  filter,
}: {
  filter: Extract<ColumnFilterConfig, { type: "searchable-select" }>;
}) {
  const [q, setQ] = React.useState("");
  const allValue = filter.allValue ?? "all";
  const active = filter.value !== allValue;

  const filtered = React.useMemo(() => {
    const lower = q.toLowerCase().trim();
    if (!lower) return filter.options;
    return filter.options.filter(o => o.label.toLowerCase().includes(lower));
  }, [q, filter.options]);

  return (
    <div className="space-y-2" onClick={e => e.stopPropagation()}>
      <Input
        autoFocus
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={filter.placeholder ?? "Search…"}
        className="h-7 text-xs"
      />
      <div className="max-h-52 overflow-y-auto rounded border border-border text-sm">
        <button
          type="button"
          className={cn(
            "w-full text-left px-2.5 py-1.5 hover:bg-muted transition-colors",
            !active && "bg-primary/10 font-medium text-primary",
          )}
          onClick={() => { filter.onChange(allValue); setQ(""); }}
        >
          {filter.allLabel ?? "All"}
        </button>
        {filtered.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={cn(
              "w-full text-left px-2.5 py-1.5 hover:bg-muted transition-colors",
              filter.value === opt.value && "bg-primary/10 font-medium text-primary",
            )}
            onClick={() => { filter.onChange(opt.value); setQ(""); }}
          >
            {opt.label}
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="px-2.5 py-3 text-xs text-muted-foreground text-center">No results</p>
        )}
      </div>
    </div>
  );
}

function FilterControl({ filter, onClose }: { filter: ColumnFilterConfig; onClose: () => void }) {
  const active = isFilterActive(filter);
  const allValue = filter.type === "select" ? filter.allValue ?? "all"
    : filter.type === "searchable-select" ? filter.allValue ?? "all"
    : "";
  return (
    <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-semibold">{filter.label || "Filter"}</Label>
        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => {
              if (filter.type === "text") filter.onChange("");
              else filter.onChange(allValue);
            }}
          >
            <X className="w-3 h-3 mr-1" /> Clear
          </Button>
        )}
      </div>

      {filter.type === "text" ? (
        <Input
          autoFocus
          value={filter.value}
          placeholder={filter.placeholder || "Search…"}
          className="h-8 text-sm"
          onChange={(e) => filter.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose();
          }}
        />
      ) : filter.type === "searchable-select" ? (
        <SearchableSelectFilter filter={filter} />
      ) : (
        <Select
          value={filter.value}
          onValueChange={(v) => {
            filter.onChange(v);
          }}
        >
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {!filter.hideAll && <SelectItem value={allValue}>{filter.allLabel || "All"}</SelectItem>}
            {filter.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function ColumnHeader<TKey extends string = string>(props: ColumnHeaderProps<TKey>) {
  const { label, className, align = "left", sort, filter, asTh, innerClassName } = props;
  const [open, setOpen] = React.useState(false);
  const sortActive = sort && sort.current.key === sort.sortKey;
  const filterActive = isFilterActive(filter);
  const justify = align === "right" ? "justify-end" : align === "center" ? "justify-center" : "justify-start";

  const sortIcon = sort ? (
    <button
      type="button"
      title="Sort"
      className={cn(
        "inline-flex items-center justify-center text-muted-foreground/60 hover:text-foreground transition-colors",
        sortActive && "text-foreground",
      )}
      onClick={(e) => {
        e.stopPropagation();
        sort.onSort(sort.sortKey);
      }}
    >
      {sortActive ? (
        sort.current.dir === "asc" ? <ArrowUp className="w-3.5 h-3.5" /> : <ArrowDown className="w-3.5 h-3.5" />
      ) : (
        <ArrowUpDown className="w-3.5 h-3.5" />
      )}
    </button>
  ) : null;

  const filterIcon = filter ? (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={filterActive ? "Filter active — click to edit" : "Filter"}
          className={cn(
            "relative inline-flex items-center justify-center transition-colors",
            filterActive ? "text-primary" : "text-muted-foreground/60 hover:text-foreground",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <FilterIcon className={cn("w-3.5 h-3.5", filterActive && "fill-primary/20")} />
          {filterActive && (
            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align === "right" ? "end" : align === "center" ? "center" : "start"}
        className="w-64 p-3"
        onClick={(e) => e.stopPropagation()}
        onInteractOutside={(e) => {
          const target = (e.detail as { originalEvent?: Event } | undefined)
            ?.originalEvent?.target;
          if (
            target instanceof Element &&
            target.closest(
              "[role='listbox'],[role='option'],[data-radix-select-viewport]",
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <FilterControl filter={filter} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  ) : null;

  const content = (
    <div className={cn("flex items-center gap-1.5 select-none", justify, innerClassName)}>
      <span className={cn(sort && "cursor-pointer")} onClick={() => sort?.onSort(sort.sortKey)}>
        {label}
      </span>
      {sortIcon}
      {filterIcon}
    </div>
  );

  if (asTh) {
    return (
      <th className={cn("py-3 px-3 font-semibold text-muted-foreground", className)}>
        {content}
      </th>
    );
  }

  return (
    <TableHead className={cn("hover:bg-muted/50 transition-colors", className)}>
      {content}
    </TableHead>
  );
}

export default ColumnHeader;
