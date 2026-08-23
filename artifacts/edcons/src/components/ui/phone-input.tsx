import * as React from "react";
import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CountryFlag } from "@/components/CountryFlag";
import { PHONE_CODES } from "@/lib/nationalities";
import { useDialCodeCountries } from "@/hooks/use-countries";

const regionNames = typeof Intl !== "undefined" && (Intl as any).DisplayNames
  ? new (Intl as any).DisplayNames(["en"], { type: "region" })
  : null;

function countryName(iso: string): string {
  try { return regionNames?.of(iso) || iso; } catch { return iso; }
}

const COUNTRY_CODES = PHONE_CODES
  .map(p => ({ code: p.country, dial: p.code, name: countryName(p.country) }))
  .sort((a, b) => parseInt(a.dial.replace("+", ""), 10) - parseInt(b.dial.replace("+", ""), 10));

function parsePhone(fullPhone: string): { dialCode: string; number: string } {
  if (!fullPhone) return { dialCode: "+90", number: "" };
  const cleaned = fullPhone.replace(/\s+/g, "");
  const sorted = [...COUNTRY_CODES].sort((a, b) => b.dial.length - a.dial.length);
  for (const c of sorted) {
    if (cleaned.startsWith(c.dial)) {
      return { dialCode: c.dial, number: cleaned.slice(c.dial.length) };
    }
  }
  return { dialCode: "+90", number: cleaned.replace(/^\+/, "") };
}

interface PhoneInputProps {
  value: string;
  onChange: (fullPhone: string) => void;
  className?: string;
}

export function PhoneInput({ value, onChange, className }: PhoneInputProps) {
  const parsed = useMemo(() => parsePhone(value), [value]);
  const [dialCode, setDialCode] = useState(parsed.dialCode);
  const [number, setNumber] = useState(parsed.number);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = parsePhone(value);
    setDialCode(p.dialCode);
    setNumber(p.number);
  }, [value]);

  useEffect(() => {
    if (open && searchRef.current) {
      setTimeout(() => searchRef.current?.focus(), 0);
    }
    if (!open) setSearch("");
  }, [open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
    return undefined;
  }, [open]);

  // Base (unfiltered) catalog tells us whether the catalog is available and is
  // the source of truth for resolving the selected country (incl. admin-edited
  // dial codes). Falls back to the hardcoded ITU list when catalog is empty.
  const { data: baseCatalog = [] } = useDialCodeCountries("");
  const catalogAvailable = baseCatalog.length > 0;

  const selectedCountry = useMemo(() => {
    if (catalogAvailable) {
      const c = baseCatalog.find(c => c.dialCode === dialCode);
      if (c) return { code: c.code, dial: c.dialCode, name: c.name };
    }
    return COUNTRY_CODES.find(c => c.dial === dialCode) ?? COUNTRY_CODES[0];
  }, [dialCode, catalogAvailable, baseCatalog]);

  // Server-side (AJAX) debounced search. When the catalog is available we render
  // its (possibly empty) search results honestly; we only fall back to the
  // hardcoded list when the catalog itself is empty/unreachable.
  const { data: catalog = [] } = useDialCodeCountries(search);
  const filtered = useMemo(() => {
    if (catalogAvailable) {
      return catalog.map(c => ({ code: c.code, dial: c.dialCode, name: c.name }));
    }
    const q = search.trim().toLowerCase();
    if (!q) return COUNTRY_CODES;
    const cleanQ = q.replace(/^\+/, "");
    return COUNTRY_CODES.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.dial.replace("+", "").startsWith(cleanQ) ||
      c.code.toLowerCase().includes(q)
    );
  }, [catalogAvailable, catalog, search]);

  function handleDialChange(dial: string) {
    setDialCode(dial);
    setOpen(false);
    onChange(`${dial}${number}`);
  }

  function handleNumberChange(num: string) {
    const cleaned = num.replace(/[^\d]/g, "");
    setNumber(cleaned);
    onChange(`${dialCode}${cleaned}`);
  }

  return (
    <div ref={containerRef} className={cn("relative flex", className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 h-9 rounded-l-xl border border-r-0 border-input bg-secondary/40 hover:bg-secondary/60 transition-colors text-sm shrink-0"
      >
        <CountryFlag code={selectedCountry.code} size="sm" />
        <span className="text-muted-foreground font-mono text-xs">{dialCode}</span>
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>
      <input
        type="tel"
        value={number}
        onChange={e => handleNumberChange(e.target.value)}
        placeholder="555 123 4567"
        className="flex h-9 w-full rounded-r-xl border border-input bg-transparent px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 w-[240px] rounded-md border bg-popover text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95">
          <div className="flex items-center border-b px-2 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground mr-1.5 shrink-0" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search country or code…"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            {search && (
              <button type="button" onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="max-h-[260px] overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="py-4 text-center text-sm text-muted-foreground">No results</div>
            )}
            {filtered.map(c => (
              <button
                key={`${c.code}-${c.dial}`}
                type="button"
                onClick={() => handleDialChange(c.dial)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
                  dialCode === c.dial && c.code === selectedCountry.code && "bg-accent/50"
                )}
              >
                <CountryFlag code={c.code} size="sm" />
                <span className="flex-1 text-left truncate">{c.name}</span>
                <span className="text-muted-foreground font-mono text-xs">{c.dial}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
