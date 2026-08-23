/**
 * MultiSelectFilter — searchable multi-select popover anchored to its trigger.
 *
 * Contained (max-height + scroll), collision-aware (Radix Popover), with a
 * search box that folds Turkish characters so "İ/I/ı/ç/ğ/ö/ş/ü" all match.
 * Selected values render as removable chips beneath the trigger.
 */

import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
}

/** TR-aware fold for accent-insensitive substring search. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .replace(/İ/g, "i").replace(/ı/g, "i").replace(/i̇/g, "i")
    .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ö/g, "o")
    .replace(/ş/g, "s").replace(/ü/g, "u");
}

interface Props {
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  selectedText: (count: number) => string;
  className?: string;
  disabled?: boolean;
}

export function MultiSelectFilter({
  options, value, onChange, placeholder, searchPlaceholder,
  emptyText, selectedText, className, disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return options;
    return options.filter((o) => fold(o.label).includes(q) || fold(o.value).includes(q));
  }, [options, query]);

  const selectedSet = useMemo(() => new Set(value), [value]);
  const labelFor = useMemo(() => {
    const m = new Map(options.map((o) => [o.value, o.label]));
    return (v: string) => m.get(v) ?? v;
  }, [options]);

  const toggle = (v: string) => {
    if (selectedSet.has(v)) onChange(value.filter((x) => x !== v));
    else onChange([...value, v]);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            className="h-9 justify-between gap-2 font-normal"
          >
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {value.length === 0 ? placeholder : selectedText(value.length)}
            </span>
            <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="w-3.5 h-3.5 shrink-0 opacity-50" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              filtered.map((o) => {
                const checked = selectedSet.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        checked ? "bg-primary border-primary text-primary-foreground" : "border-input",
                      )}
                    >
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>

      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1 py-0 pr-1 text-xs font-normal">
              <span className="max-w-[160px] truncate">{labelFor(v)}</span>
              <button
                type="button"
                onClick={() => toggle(v)}
                className="rounded-sm hover:bg-muted-foreground/20"
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
