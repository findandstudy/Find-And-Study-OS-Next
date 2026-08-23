import { useState, useEffect, useRef, useMemo } from "react";
import { toLatinUpper } from "@/lib/textTransform";
import { useCreateLead } from "@workspace/api-client-react";
import { useSeason } from "@/contexts/SeasonContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { CountryFlag } from "@/components/CountryFlag";
import { PhoneField, isPhoneFieldValid } from "@/components/ui/phone-field";
import { useCountrySearch } from "@/hooks/use-countries";
import { ChevronDown, TrendingUp, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function apiFetch(url: string) {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

type CountryRecord = { id: number; name: string; code: string; flagEmoji?: string; isActive: boolean };

function useCountries() {
  return useQuery<CountryRecord[]>({
    queryKey: ["countries-all"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/countries?limit=500`);
      return res.data ?? res;
    },
    staleTime: 5 * 60_000,
  });
}

const SOURCES = ["website", "referral", "social_media", "walk_in", "partner", "other"];



const EMPTY_FORM = {
  firstName: "", lastName: "", email: "",
  phone: "",
  source: "website", interestedProgram: "", interestedCountry: "",
  nationality: "", estimatedValue: "",
};

function NationalityCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [searchVal, setSearchVal] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Server-side (AJAX) debounced search over the country catalog.
  const { data: filtered = [] } = useCountrySearch(searchVal);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchVal("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <Input
        value={open ? searchVal : value}
        onChange={e => { setSearchVal(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setSearchVal(""); setOpen(true); }}
        placeholder={value || "Select or type..."}
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? "No match — custom value OK" : "No countries loaded"}</div>}
          {filtered.map(c => (
            <button key={c.id} type="button"
              className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MultiCountrySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: cfFilters } = useQuery<{ countries: string[] }>({
    queryKey: ["course-finder-filters"],
    queryFn: async () => apiFetch(`${BASE_URL}/api/course-finder/filters`),
    staleTime: 5 * 60_000,
  });
  const cfCountryNames = cfFilters?.countries ?? [];
  const { data: allCountries = [] } = useCountries();
  const activeDestinations = useMemo(() => {
    const nameSet = new Set(cfCountryNames);
    return allCountries.filter(c => nameSet.has(c.name));
  }, [allCountries, cfCountryNames]);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [localSelected, setLocalSelected] = useState<string[]>(() =>
    value ? value.split(",").map(s => s.trim()).filter(Boolean) : []
  );

  useEffect(() => {
    const parsed = value ? value.split(",").map(s => s.trim()).filter(Boolean) : [];
    setLocalSelected(prev => {
      if (prev.join(",") === parsed.join(",")) return prev;
      return parsed;
    });
  }, [value]);

  function toggle(name: string) {
    setLocalSelected(prev => {
      const next = prev.includes(name) ? prev.filter(s => s !== name) : [...prev, name];
      onChange(next.join(", "));
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    const timer = setTimeout(() => document.addEventListener("click", handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener("click", handleClick); };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background hover:bg-accent/50 transition-colors"
      >
        <span className={`truncate ${localSelected.length === 0 ? "text-muted-foreground" : ""}`}>
          {localSelected.length === 0 ? "Select countries..." : localSelected.length === 1 ? localSelected[0] : `${localSelected.length} countries selected`}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </button>
      {localSelected.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {localSelected.map(name => {
            const c = activeDestinations.find(d => d.name === name);
            return (
              <span key={name} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
                {c && <CountryFlag code={c.code} size="sm" />}
                {name}
                <button type="button" className="ml-0.5 hover:text-destructive" onClick={(e) => { e.stopPropagation(); toggle(name); }}><X className="w-3 h-3" /></button>
              </span>
            );
          })}
        </div>
      )}
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {activeDestinations.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">No active destinations</div>}
          {activeDestinations.map(c => (
            <button key={c.id} type="button"
              className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${localSelected.includes(c.name) ? "bg-primary/10 font-medium" : ""}`}
              onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(c.name); }}>
              <Checkbox checked={localSelected.includes(c.name)} className="pointer-events-none" />
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CreateLeadDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const { stages: pipelineStages } = usePipelineStages("lead");
  const { season } = useSeason();
  const createLead = useCreateLead();
  const queryClient = useQueryClient();

  function handleClose() {
    onOpenChange(false);
    setForm(EMPTY_FORM);
  }

  function handleCreate() {
    if (!form.firstName || !form.lastName || !form.email || !isPhoneFieldValid(form.phone, true)) return;
    const defaultStatus = pipelineStages.length > 0 ? pipelineStages[0].key : "new";
    const payload: any = { ...form, status: defaultStatus, season };
    const parsedCreate = parseFloat(form.estimatedValue);
    if (form.estimatedValue && !isNaN(parsedCreate)) payload.estimatedValue = parsedCreate;
    else delete payload.estimatedValue;

    createLead.mutate(
      { data: payload },
      {
        onSuccess: () => {
          toast({ title: "Lead created" });
          handleClose();
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
        },
      }
    );
  }

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) handleClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Add New Lead</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>First Name *</Label>
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: toLatinUpper(e.target.value) })} placeholder="First name" className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>Last Name *</Label>
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: toLatinUpper(e.target.value) })} placeholder="Last name" className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>Email *</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label>Phone *</Label>
            <PhoneField value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Nationality</Label>
            <NationalityCombobox value={form.nationality} onChange={v => setForm({ ...form, nationality: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Interested Program</Label>
            <Input value={form.interestedProgram} onChange={(e) => setForm({ ...form, interestedProgram: e.target.value })} placeholder="e.g. Computer Science" />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>Interested Country</Label>
            <MultiCountrySelect value={form.interestedCountry} onChange={v => setForm({ ...form, interestedCountry: v })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label className="flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
              Estimated Value (USD)
            </Label>
            <Input type="number" min="0" step="100" value={form.estimatedValue} onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })} placeholder="e.g. 5000" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={createLead.isPending || !form.firstName || !form.lastName || !form.email || !isPhoneFieldValid(form.phone, true)}>
            {createLead.isPending ? "Creating…" : "Create Lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
