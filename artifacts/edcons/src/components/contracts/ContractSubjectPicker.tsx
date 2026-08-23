import { useEffect, useMemo, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Search, X } from "lucide-react";

export type ContractSubjectSearchResult = { id: number; label: string; description?: string; email?: string };

type Props = {
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  onChange: (subjectId: string, subjectLabel: string, result?: ContractSubjectSearchResult) => void;
};

const TYPE_LABELS: Record<string, string> = {
  agent: "agent",
  student: "student",
  lead: "lead",
  application: "application",
  university: "university",
  company: "company",
};

function resultLabel(type: string, row: Record<string, any>): ContractSubjectSearchResult | null {
  const id = Number(row.id);
  if (!Number.isInteger(id) || id < 1) return null;

  const fullName = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  const studentName = [row.studentFirstName, row.studentLastName].filter(Boolean).join(" ").trim();
  let label = "";
  let description = "";

  if (type === "agent") {
    label = row.businessName || row.companyName || fullName || row.email || `Agent #${id}`;
    description = row.email || row.phone || "";
  } else if (type === "application") {
    label = studentName || row.studentName || row.name || `Application #${id}`;
    description = [row.universityName, row.programName].filter(Boolean).join(" · ");
  } else if (type === "university") {
    label = row.name || `University #${id}`;
    description = [row.city, row.country].filter(Boolean).join(", ");
  } else if (type === "company") {
    label = row.companyName || row.name || `Company #${id}`;
    description = row.country || row.fileName || "";
  } else {
    label = fullName || row.fullName || row.name || row.email || row.phone || `${TYPE_LABELS[type] || "Record"} #${id}`;
    description = row.email || row.phone || row.status || "";
  }

  return {
    id,
    label: String(label),
    description: description ? String(description) : undefined,
    email: typeof row.email === "string" && row.email.trim() ? row.email.trim() : undefined,
  };
}

function searchPath(type: string, query: string): string {
  const q = encodeURIComponent(query);
  switch (type) {
    case "agent": return `/api/agents?search=${q}&page=1&limit=20&type=agent`;
    case "student": return `/api/students?search=${q}&page=1&limit=20&includeFacets=0`;
    case "lead": return `/api/leads?search=${q}&page=1&limit=20&includeFacets=0`;
    case "application": return `/api/applications?search=${q}&page=1&limit=20&includeFacets=0&includeTotals=0`;
    case "university": return `/api/universities?search=${q}&page=1&limit=20&summary=1`;
    case "company": return `/api/company-contracts?search=${q}&page=1&pageSize=20`;
    default: return "";
  }
}

export function ContractSubjectPicker({ subjectType, subjectId, subjectLabel, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ContractSubjectSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const typeLabel = TYPE_LABELS[subjectType] || "record";
  const selected = useMemo(() => subjectId ? { id: subjectId, label: subjectLabel || `${typeLabel} #${subjectId}` } : null, [subjectId, subjectLabel, typeLabel]);

  useEffect(() => {
    setQuery("");
    setResults([]);
    setError("");
    setOpen(false);
  }, [subjectType]);

  useEffect(() => {
    const trimmed = query.trim();
    if (selected || trimmed.length < 2 || !searchPath(subjectType, trimmed)) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const response: any = await customFetch(searchPath(subjectType, trimmed));
        if (cancelled) return;
        const rows = Array.isArray(response?.data) ? response.data : [];
        setResults(rows.map((row: Record<string, any>) => resultLabel(subjectType, row)).filter(Boolean) as ContractSubjectSearchResult[]);
        setOpen(true);
      } catch (err: any) {
        if (!cancelled) {
          setResults([]);
          setError(err?.message || "Search failed");
          setOpen(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, selected, subjectType]);

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{selected.label}</div>
          <div className="text-xs capitalize text-muted-foreground">{typeLabel} #{selected.id}</div>
        </div>
        <Button type="button" size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => onChange("", "")} title="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => { if (query.trim().length >= 2) setOpen(true); }}
        placeholder={`Search ${typeLabel} by name, email or reference`}
        className="pl-9 pr-9"
        autoComplete="off"
      />
      {loading && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
      {open && query.trim().length >= 2 && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-lg">
          {error ? (
            <div className="px-3 py-2 text-sm text-destructive">{error}</div>
          ) : !loading && results.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">No matching {typeLabel} found.</div>
          ) : (
            results.map((result) => (
              <button
                key={result.id}
                type="button"
                className="block w-full rounded-sm px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange(String(result.id), result.label, result);
                  setQuery("");
                  setOpen(false);
                }}
              >
                <div className="truncate text-sm font-medium">{result.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {typeLabel} #{result.id}{result.description ? ` · ${result.description}` : ""}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
