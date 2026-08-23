import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { useCountrySearch } from "@/hooks/use-countries";
import { PhoneInput } from "@/components/ui/phone-input";
import { CountryFlag } from "@/components/CountryFlag";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import StaffQualityTab from "@/components/quality/StaffQualityTab";
import {
  ArrowLeft, Trash2, Plus, Upload, Download, Loader2, FileText, BadgeCheck, AlertTriangle,
  Search, ArrowUpDown, ArrowUp, ArrowDown, Clock, Activity, Monitor, Pause, BarChart3, TrendingUp,
} from "lucide-react";
import { formatDuration } from "@/lib/formatDuration";

const WEEKDAYS_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type CardData = {
  user: any;
  schedules: Array<{ id: number; weekday: number; startMinutes: number; endMinutes: number }>;
  languages: Array<{ id: number; language: string; proficiency: string | null }>;
  countries: Array<{ id: number; country: string }>;
  documents: Array<{ id: number; docType: string; filename: string; sizeBytes: number; mimeType: string; uploadedAt: string }>;
  assignedAgents: Array<{ id: number; firstName: string | null; lastName: string | null; companyName: string | null; businessName: string | null; email: string | null; isPrimary: boolean }>;
  assignedStudents: Array<{ id: number; firstName: string | null; lastName: string | null; email: string | null; status: string | null; season: string | null }>;
  salaryPayments: Array<any>;
  commissions: Array<any>;
  salaryTotals: { paid: number; pending: number };
  commissionTotals: { paid: number; pending: number };
  presence: { status: string; lastActiveAt: string | null };
};

function minutesToHHMM(m: number): string {
  const h = Math.floor(m / 60).toString().padStart(2, "0");
  const mm = (m % 60).toString().padStart(2, "0");
  return `${h}:${mm}`;
}
function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

export default function StaffCardDetailPage({ userId }: { userId: number }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [data, setData] = useState<CardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("general");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await customFetch<CardData>(`/api/staff-cards/${userId}`);
      setData(fetched);
    } catch (err: any) {
      const msg = String(err?.message || err);
      setError(msg);
      toast({ title: t("staffCards.loadFailed"), description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [userId, toast, t]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) {
    return <div className="p-12 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  }
  if (error || !data) {
    return (
      <div className="p-12 max-w-md mx-auto text-center space-y-3">
        <p className="text-sm text-destructive">{error || t("staffCards.loadFailed")}</p>
        <Button size="sm" variant="outline" onClick={refresh}>{t("common.retry") || "Retry"}</Button>
      </div>
    );
  }

  const fullName = [data.user.firstName, data.user.lastName].filter(Boolean).join(" ") || data.user.email || `#${data.user.id}`;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/admin/staff-cards"><Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />{t("common.back")}</Button></Link>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">{fullName} <Badge variant="secondary">{data.user.role}</Badge></h1>
            <p className="text-sm text-muted-foreground">{data.user.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant={data.presence.status === "online" ? "default" : "outline"}>{data.presence.status}</Badge>
          {data.presence.lastActiveAt && <span>{t("staffCards.lastActive")}: {new Date(data.presence.lastActiveAt).toLocaleString()}</span>}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto">
          <TabsTrigger value="general">{t("staffCards.tab.general")}</TabsTrigger>
          <TabsTrigger value="agents">{t("staffCards.tab.agents")}</TabsTrigger>
          <TabsTrigger value="students">{t("staffCards.tab.students")}</TabsTrigger>
          <TabsTrigger value="activity">{t("staffCards.tab.activity")}</TabsTrigger>
          <TabsTrigger value="salary">{t("staffCards.tab.salary")}</TabsTrigger>
          <TabsTrigger value="commissions">{t("staffCards.tab.commissions")}</TabsTrigger>
          <TabsTrigger value="quality">{t("staffCards.tab.quality")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4">
          <Accordion type="multiple" defaultValue={["profile"]} className="space-y-3">
            <AccordionItem value="profile" className="border rounded-md bg-card">
              <AccordionTrigger className="px-4 py-3 hover:no-underline">{t("staffCards.section.profile")}</AccordionTrigger>
              <AccordionContent className="px-1 pb-1">
                <ProfileSection user={data.user} userId={userId} onSaved={refresh} />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="schedule" className="border rounded-md bg-card">
              <AccordionTrigger className="px-4 py-3 hover:no-underline">{t("staffCards.section.schedule")} <span className="ml-2 text-xs text-muted-foreground">({data.schedules.length})</span></AccordionTrigger>
              <AccordionContent className="px-1 pb-1">
                <ScheduleSection schedules={data.schedules} userId={userId} onSaved={refresh} />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="languages" className="border rounded-md bg-card">
              <AccordionTrigger className="px-4 py-3 hover:no-underline">{t("staffCards.section.languages")} <span className="ml-2 text-xs text-muted-foreground">({data.languages.length})</span></AccordionTrigger>
              <AccordionContent className="px-1 pb-1">
                <LanguagesSection languages={data.languages} userId={userId} onSaved={refresh} />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="countries" className="border rounded-md bg-card">
              <AccordionTrigger className="px-4 py-3 hover:no-underline">{t("staffCards.section.countries")} <span className="ml-2 text-xs text-muted-foreground">({data.countries.length})</span></AccordionTrigger>
              <AccordionContent className="px-1 pb-1">
                <CountriesSection countries={data.countries} userId={userId} onSaved={refresh} />
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="documents" className="border rounded-md bg-card">
              <AccordionTrigger className="px-4 py-3 hover:no-underline">{t("staffCards.section.documents")} <span className="ml-2 text-xs text-muted-foreground">({data.documents.length})</span></AccordionTrigger>
              <AccordionContent className="px-1 pb-1">
                <DocumentsSection documents={data.documents} userId={userId} onSaved={refresh} />
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </TabsContent>
        <TabsContent value="agents" className="mt-4"><AgentsTab assignedAgents={data.assignedAgents} userId={userId} onSaved={refresh} /></TabsContent>
        <TabsContent value="students" className="mt-4"><StudentsTab assignedStudents={data.assignedStudents} userId={userId} onSaved={refresh} /></TabsContent>
        <TabsContent value="activity" className="mt-4"><ActivityTab userId={userId} /></TabsContent>
        <TabsContent value="salary" className="mt-4"><SalaryTab payments={data.salaryPayments} totals={data.salaryTotals} userId={userId} onSaved={refresh} /></TabsContent>
        <TabsContent value="commissions" className="mt-4"><CommissionsTab commissions={data.commissions} totals={data.commissionTotals} userId={userId} onSaved={refresh} /></TabsContent>
        <TabsContent value="quality" className="mt-4"><StaffQualityTab userId={userId} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Section: Profile (Country/City catalog + PhoneInput, no timezone) ──────
function ProfileSection({ user, userId, onSaved }: { user: any; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [form, setForm] = useState({
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    phone: user.phone || "",
    homeAddress: user.homeAddress || "",
    locationCountry: user.locationCountry || "",
    locationCity: user.locationCity || "",
    emergencyContactName: user.emergencyContactName || "",
    emergencyContactPhone: user.emergencyContactPhone || "",
  });
  const [saving, setSaving] = useState(false);
  const [countries, setCountries] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [cities, setCities] = useState<Array<{ id: number; name: string }>>([]);
  const [citiesLoading, setCitiesLoading] = useState(false);

  // Lazy load all countries (active only)
  useEffect(() => {
    customFetch<{ data: any[] }>(`/api/countries?status=active&limit=500`)
      .then(r => setCountries(r.data || []))
      .catch(() => setCountries([]));
  }, []);

  // Reload cities when country changes
  useEffect(() => {
    const c = countries.find(x => x.name === form.locationCountry || x.code === form.locationCountry);
    if (!c) { setCities([]); return; }
    setCitiesLoading(true);
    customFetch<{ data: any[] }>(`/api/cities?countryId=${c.id}&status=active&limit=1000`)
      .then(r => setCities(r.data || []))
      .catch(() => setCities([]))
      .finally(() => setCitiesLoading(false));
  }, [form.locationCountry, countries]);

  const countryOptions = useMemo(() => countries.map(c => ({
    value: c.name,
    label: c.name,
    node: <span className="flex items-center gap-2"><CountryFlag code={c.code} size="sm" />{c.name}</span>,
  })), [countries]);
  const cityOptions = useMemo(() => cities.map(c => ({ value: c.name, label: c.name })), [cities]);

  const save = async () => {
    setSaving(true);
    try {
      await customFetch(`/api/staff-cards/${userId}/profile`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form),
      });
      toast({ title: t("staffCards.saved") });
      onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div><Label>{t("staffCards.field.firstName")}</Label><Input value={form.firstName} onChange={(e) => setForm(f => ({ ...f, firstName: e.target.value }))} /></div>
        <div><Label>{t("staffCards.field.lastName")}</Label><Input value={form.lastName} onChange={(e) => setForm(f => ({ ...f, lastName: e.target.value }))} /></div>
        <div><Label>{t("staffCards.field.phone")}</Label><PhoneInput value={form.phone} onChange={(v) => setForm(f => ({ ...f, phone: v }))} /></div>
        <div>
          <Label>{t("staffCards.field.locationCountry")}</Label>
          <SearchableSelect
            value={form.locationCountry}
            onChange={(v) => setForm(f => ({ ...f, locationCountry: v, locationCity: "" }))}
            options={countryOptions}
            placeholder={t("staffCards.field.locationCountry")}
            clearable
          />
        </div>
        <div>
          <Label>{t("staffCards.field.locationCity")}</Label>
          <SearchableSelect
            value={form.locationCity}
            onChange={(v) => setForm(f => ({ ...f, locationCity: v }))}
            options={cityOptions}
            placeholder={citiesLoading ? "..." : t("staffCards.field.locationCity")}
            clearable
            disabled={!form.locationCountry || citiesLoading}
          />
        </div>
        <div className="md:col-span-2"><Label>{t("staffCards.field.homeAddress")}</Label><Textarea rows={2} value={form.homeAddress} onChange={(e) => setForm(f => ({ ...f, homeAddress: e.target.value }))} /></div>
        <div><Label>{t("staffCards.field.emergencyName")}</Label><Input value={form.emergencyContactName} onChange={(e) => setForm(f => ({ ...f, emergencyContactName: e.target.value }))} /></div>
        <div><Label>{t("staffCards.field.emergencyPhone")}</Label><PhoneInput value={form.emergencyContactPhone} onChange={(v) => setForm(f => ({ ...f, emergencyContactPhone: v }))} /></div>
      </div>
      <div className="flex justify-end"><Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{t("common.save")}</Button></div>
    </div>
  );
}

// ─── Section: Schedule ──────────────────────────────────────────────────────
function ScheduleSection({ schedules, userId, onSaved }: { schedules: any[]; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [entries, setEntries] = useState(schedules.map(s => ({ ...s })));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setEntries(schedules.map(s => ({ ...s }))); }, [schedules]);

  const addRow = () => setEntries(e => [...e, { weekday: 1, startMinutes: 9 * 60, endMinutes: 17 * 60 }]);
  const removeRow = (i: number) => setEntries(e => e.filter((_, idx) => idx !== i));
  const update = (i: number, key: string, val: any) => setEntries(e => e.map((row, idx) => idx === i ? { ...row, [key]: val } : row));

  const save = async () => {
    setSaving(true);
    try {
      const payload = { entries: entries.map(e => ({ weekday: Number(e.weekday), startMinutes: Number(e.startMinutes), endMinutes: Number(e.endMinutes) })) };
      await customFetch(`/api/staff-cards/${userId}/schedule`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast({ title: t("staffCards.saved") }); onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const totalMinutes = entries.reduce((s, e) => s + Math.max(0, Number(e.endMinutes) - Number(e.startMinutes)), 0);

  return (
    <div className="p-4 space-y-4">
      <div className="flex justify-end">
        <span className="text-xs text-muted-foreground">{t("staffCards.kpi.planned")}: {formatDuration(totalMinutes * 60)} / {t("staffCards.preset.7days")}</span>
      </div>
      <div className="space-y-2">
        {entries.length === 0 && <p className="text-sm text-muted-foreground">{t("staffCards.schedule.empty")}</p>}
        {entries.map((row, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              <Label>{t("staffCards.schedule.weekday")}</Label>
              <Select value={String(row.weekday)} onValueChange={(v) => update(i, "weekday", Number(v))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{WEEKDAYS_KEYS.map((k, idx) => <SelectItem key={idx} value={String(idx)}>{t(`staffCards.weekday.${k}`)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="col-span-3"><Label>{t("staffCards.schedule.start")}</Label><Input type="time" value={minutesToHHMM(row.startMinutes)} onChange={(e) => update(i, "startMinutes", hhmmToMinutes(e.target.value))} /></div>
            <div className="col-span-3"><Label>{t("staffCards.schedule.end")}</Label><Input type="time" value={minutesToHHMM(row.endMinutes)} onChange={(e) => update(i, "endMinutes", hhmmToMinutes(e.target.value))} /></div>
            <div className="col-span-2"><Button variant="ghost" size="icon" onClick={() => removeRow(i)}><Trash2 className="h-4 w-4" /></Button></div>
          </div>
        ))}
      </div>
      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={addRow}><Plus className="h-4 w-4 mr-1" />{t("staffCards.schedule.add")}</Button>
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{t("common.save")}</Button>
      </div>
    </div>
  );
}

// ─── Section: Languages ─────────────────────────────────────────────────────
function LanguagesSection({ languages, userId, onSaved }: { languages: any[]; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [items, setItems] = useState(languages.map(l => ({ ...l })));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setItems(languages.map(l => ({ ...l }))); }, [languages]);

  const addRow = () => setItems(e => [...e, { language: "", proficiency: "" }]);
  const removeRow = (i: number) => setItems(e => e.filter((_, idx) => idx !== i));
  const update = (i: number, key: string, val: any) => setItems(e => e.map((row, idx) => idx === i ? { ...row, [key]: val } : row));

  const save = async () => {
    setSaving(true);
    try {
      const payload = { languages: items.filter(i => (i.language || "").trim()).map(i => ({ language: i.language.trim(), proficiency: (i.proficiency || "").trim() || null })) };
      await customFetch(`/api/staff-cards/${userId}/languages`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      toast({ title: t("staffCards.saved") }); onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 space-y-4">
      {items.length === 0 && <p className="text-sm text-muted-foreground">{t("staffCards.languages.empty")}</p>}
      {items.map((row, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-5"><Label>{t("staffCards.languages.language")}</Label><Input placeholder="Türkçe" value={row.language} onChange={(e) => update(i, "language", e.target.value)} /></div>
          <div className="col-span-5"><Label>{t("staffCards.languages.proficiency")}</Label>
            <Select value={row.proficiency || ""} onValueChange={(v) => update(i, "proficiency", v)}>
              <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="A1">A1</SelectItem><SelectItem value="A2">A2</SelectItem>
                <SelectItem value="B1">B1</SelectItem><SelectItem value="B2">B2</SelectItem>
                <SelectItem value="C1">C1</SelectItem><SelectItem value="C2">C2</SelectItem>
                <SelectItem value="native">{t("staffCards.languages.native")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2"><Button variant="ghost" size="icon" onClick={() => removeRow(i)}><Trash2 className="h-4 w-4" /></Button></div>
        </div>
      ))}
      <div className="flex justify-between">
        <Button variant="outline" size="sm" onClick={addRow}><Plus className="h-4 w-4 mr-1" />{t("staffCards.languages.add")}</Button>
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{t("common.save")}</Button>
      </div>
    </div>
  );
}

// ─── Section: Countries ─────────────────────────────────────────────────────
function CountriesSection({ countries, userId, onSaved }: { countries: Array<{ id: number; country: string }>; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { data: catalog } = useCountrySearch("");
  const [selected, setSelected] = useState<string[]>(countries.map(c => c.country));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setSelected(countries.map(c => c.country)); }, [countries]);

  const options = useMemo(() => (catalog || []).map(c => ({ value: c.name, label: c.name })), [catalog]);

  const save = async () => {
    setSaving(true);
    try {
      await customFetch(`/api/staff-cards/${userId}/countries`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ countries: selected }) });
      toast({ title: t("staffCards.saved") }); onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  return (
    <div className="p-4 space-y-4">
      <p className="text-xs text-muted-foreground">{t("staffCards.countries.hint")}</p>
      <MultiSelectFilter
        values={selected}
        onChange={setSelected}
        options={options}
        placeholder={t("staffCards.countries.placeholder")}
        className="max-w-md"
      />
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}{t("common.save")}</Button>
      </div>
    </div>
  );
}

// ─── Section: Documents ─────────────────────────────────────────────────────
function DocumentsSection({ documents, userId, onSaved }: { documents: any[]; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [docType, setDocType] = useState<"contract" | "diploma" | "passport">("contract");
  const [uploading, setUploading] = useState(false);

  const accepts: Record<string, string> = {
    contract: ".pdf,.doc,.docx",
    diploma: ".pdf,.jpg,.jpeg,.png,.doc,.docx",
    passport: ".pdf,.jpg,.jpeg,.png",
  };

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const { uploadURL, objectPath } = await customFetch<{ uploadURL: string; objectPath: string }>(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream", prefix: `staff-documents/${userId}` }),
      });
      const putRes = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
      await customFetch(`/api/staff-cards/${userId}/documents`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ docType, filename: file.name, objectPath, sizeBytes: file.size, mimeType: file.type || "application/octet-stream" }),
      });
      toast({ title: t("staffCards.documents.uploaded") });
      onSaved();
    } catch (err: any) {
      toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" });
    } finally { setUploading(false); }
  };

  const download = async (docId: number, filename: string) => {
    try {
      const blob = await customFetch<Blob>(`/api/staff-cards/${userId}/documents/${docId}/download`, { responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const remove = async (docId: number) => {
    if (!confirm(t("staffCards.documents.confirmDelete"))) return;
    try {
      await customFetch(`/api/staff-cards/${userId}/documents/${docId}`, { method: "DELETE" });
      onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-end gap-3">
        <div className="flex-1 max-w-xs">
          <Label>{t("staffCards.documents.type")}</Label>
          <Select value={docType} onValueChange={(v) => setDocType(v as any)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="contract">{t("staffCards.documents.contract")}</SelectItem>
              <SelectItem value="diploma">{t("staffCards.documents.diploma")}</SelectItem>
              <SelectItem value="passport">{t("staffCards.documents.passport")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <label className="cursor-pointer">
          <input type="file" className="hidden" accept={accepts[docType]} disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
          <span className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-4 text-sm font-medium">
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}{t("staffCards.documents.upload")}
          </span>
        </label>
      </div>
      <div className="text-xs text-muted-foreground">{t("staffCards.documents.privacyNote")}</div>

      <div className="space-y-2">
        {documents.length === 0 && <p className="text-sm text-muted-foreground">{t("staffCards.documents.empty")}</p>}
        {documents.map((d) => (
          <div key={d.id} className="flex items-center justify-between border rounded-md p-3">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="font-medium">{d.filename}</div>
                <div className="text-xs text-muted-foreground">{t(`staffCards.documents.${d.docType}`)} · {(d.sizeBytes / 1024).toFixed(1)} KB · {new Date(d.uploadedAt).toLocaleString()}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => download(d.id, d.filename)}><Download className="h-4 w-4 mr-1" />{t("staffCards.documents.download")}</Button>
              <Button variant="ghost" size="icon" onClick={() => remove(d.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sortable header helper ─────────────────────────────────────────────────
function SortHeader({ label, active, dir, onClick, className }: { label: string; active: boolean; dir: "asc" | "desc"; onClick: () => void; className?: string }) {
  return (
    <th className={`p-3 cursor-pointer select-none hover:bg-muted/60 ${className || ""}`} onClick={onClick}>
      <div className="flex items-center gap-1">
        {label}
        {active ? (dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 text-muted-foreground/50" />}
      </div>
    </th>
  );
}

// ─── Agents (with filter / sort) ────────────────────────────────────────────
function AgentsTab({ assignedAgents, userId, onSaved }: { assignedAgents: any[]; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [allAgents, setAllAgents] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [search, setSearch] = useState("");
  const [primaryOnly, setPrimaryOnly] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });

  useEffect(() => { customFetch<any>("/api/agents?limit=500").then((d) => setAllAgents(Array.isArray(d) ? d : (d?.data || d?.agents || []))); }, []);

  const add = async () => {
    const id = Number(selected); if (!id) return;
    try {
      await customFetch(`/api/staff-cards/${userId}/assigned-agents`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: id }) });
      setSelected(""); onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };
  const remove = async (agentId: number) => {
    try { await customFetch(`/api/staff-cards/${userId}/assigned-agents/${agentId}`, { method: "DELETE" }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const assignedIds = new Set(assignedAgents.map(a => a.id));
  const available = allAgents.filter(a => !assignedIds.has(a.id));

  const displayName = (a: any) => a.companyName || a.businessName || `${a.firstName || ""} ${a.lastName || ""}`.trim() || a.email || `#${a.id}`;

  const filtered = useMemo(() => {
    let list = assignedAgents.filter(a => {
      if (primaryOnly && !a.isPrimary) return false;
      if (search.trim()) {
        const s = search.toLowerCase();
        return [displayName(a), a.email].some(v => (v || "").toLowerCase().includes(s));
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      switch (sort.key) {
        case "email": return dir * (a.email || "").localeCompare(b.email || "");
        case "primary": return dir * (Number(b.isPrimary) - Number(a.isPrimary));
        default: return dir * displayName(a).localeCompare(displayName(b));
      }
    });
    return list;
  }, [assignedAgents, search, primaryOnly, sort]);

  function sortBy(key: string) { setSort(p => p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }); }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px] max-w-md">
          <Label>{t("staffCards.agents.add")}</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              {available.map(a => <SelectItem key={a.id} value={String(a.id)}>{displayName(a)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={add} disabled={!selected}><Plus className="h-4 w-4 mr-1" />{t("staffCards.agents.assign")}</Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-2 border-t">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("staffCards.filters.search")} className="pl-9 h-9" />
        </div>
        <Button size="sm" variant={primaryOnly ? "default" : "outline"} onClick={() => setPrimaryOnly(p => !p)}>{t("staffCards.filters.primaryOnly")}</Button>
        {(search || primaryOnly) && <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setPrimaryOnly(false); }}>{t("staffCards.filters.reset")}</Button>}
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} / {assignedAgents.length}</span>
      </div>

      <div className="overflow-hidden border rounded-md">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase">
            <tr>
              <SortHeader label={t("staffCards.col.name")} active={sort.key === "name"} dir={sort.dir} onClick={() => sortBy("name")} />
              <SortHeader label={t("staffCards.col.email")} active={sort.key === "email"} dir={sort.dir} onClick={() => sortBy("email")} />
              <SortHeader label={t("staffCards.agents.primary")} active={sort.key === "primary"} dir={sort.dir} onClick={() => sortBy("primary")} />
              <th className="p-3 text-right">{t("staffCards.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">{assignedAgents.length === 0 ? t("staffCards.agents.empty") : t("staffCards.filters.noMatch")}</td></tr>
            ) : filtered.map(a => (
              <tr key={a.id} className="border-t hover:bg-muted/30">
                <td className="p-3 font-medium">{displayName(a)}</td>
                <td className="p-3 text-muted-foreground">{a.email || "—"}</td>
                <td className="p-3">{a.isPrimary && <Badge>{t("staffCards.agents.primary")}</Badge>}</td>
                <td className="p-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <Link href={`/admin/agents/${a.id}`}><Button size="sm" variant="outline">{t("common.open")}</Button></Link>
                    <Button variant="ghost" size="icon" onClick={() => remove(a.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Students (with filter / sort) ──────────────────────────────────────────
function StudentsTab({ assignedStudents, userId, onSaved }: { assignedStudents: any[]; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [studentId, setStudentId] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [seasonFilter, setSeasonFilter] = useState<string>("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });

  const add = async () => {
    const id = Number(studentId); if (!id) return;
    try {
      await customFetch(`/api/staff-cards/${userId}/assigned-students`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studentId: id }) });
      setStudentId(""); onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };
  const remove = async (sid: number) => {
    try { await customFetch(`/api/staff-cards/${userId}/assigned-students/${sid}`, { method: "DELETE" }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const displayName = (s: any) => [s.firstName, s.lastName].filter(Boolean).join(" ") || s.email || `#${s.id}`;

  const statuses = useMemo(() => Array.from(new Set(assignedStudents.map(s => s.status).filter(Boolean))) as string[], [assignedStudents]);
  const seasons = useMemo(() => Array.from(new Set(assignedStudents.map(s => s.season).filter(Boolean))) as string[], [assignedStudents]);

  const filtered = useMemo(() => {
    let list = assignedStudents.filter(s => {
      if (statusFilter && s.status !== statusFilter) return false;
      if (seasonFilter && s.season !== seasonFilter) return false;
      if (search.trim()) {
        const q = search.toLowerCase();
        return [displayName(s), s.email].some(v => (v || "").toLowerCase().includes(q));
      }
      return true;
    });
    list = [...list].sort((a, b) => {
      const dir = sort.dir === "asc" ? 1 : -1;
      switch (sort.key) {
        case "email": return dir * (a.email || "").localeCompare(b.email || "");
        case "status": return dir * (a.status || "").localeCompare(b.status || "");
        case "season": return dir * (a.season || "").localeCompare(b.season || "");
        default: return dir * displayName(a).localeCompare(displayName(b));
      }
    });
    return list;
  }, [assignedStudents, search, statusFilter, seasonFilter, sort]);

  function sortBy(key: string) { setSort(p => p.key === key ? { key, dir: p.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }); }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-end gap-2 max-w-md">
        <div className="flex-1"><Label>{t("staffCards.students.studentId")}</Label><Input type="number" value={studentId} onChange={(e) => setStudentId(e.target.value)} placeholder="123" /></div>
        <Button onClick={add} disabled={!studentId}><Plus className="h-4 w-4 mr-1" />{t("staffCards.students.assign")}</Button>
      </div>

      <div className="flex items-center gap-2 flex-wrap pt-2 border-t">
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("staffCards.filters.search")} className="pl-9 h-9" />
        </div>
        <Select value={statusFilter || "__all"} onValueChange={(v) => setStatusFilter(v === "__all" ? "" : v)}>
          <SelectTrigger className="w-40 h-9"><SelectValue placeholder={t("staffCards.filters.status")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">{t("staffCards.filters.all")}</SelectItem>
            {statuses.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={seasonFilter || "__all"} onValueChange={(v) => setSeasonFilter(v === "__all" ? "" : v)}>
          <SelectTrigger className="w-40 h-9"><SelectValue placeholder={t("staffCards.filters.season")} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">{t("staffCards.filters.all")}</SelectItem>
            {seasons.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        {(search || statusFilter || seasonFilter) && <Button size="sm" variant="ghost" onClick={() => { setSearch(""); setStatusFilter(""); setSeasonFilter(""); }}>{t("staffCards.filters.reset")}</Button>}
        <span className="ml-auto text-xs text-muted-foreground">{filtered.length} / {assignedStudents.length}</span>
      </div>

      <div className="overflow-hidden border rounded-md">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase">
            <tr>
              <SortHeader label={t("staffCards.col.name")} active={sort.key === "name"} dir={sort.dir} onClick={() => sortBy("name")} />
              <SortHeader label={t("staffCards.col.email")} active={sort.key === "email"} dir={sort.dir} onClick={() => sortBy("email")} />
              <SortHeader label={t("staffCards.filters.status")} active={sort.key === "status"} dir={sort.dir} onClick={() => sortBy("status")} />
              <SortHeader label={t("staffCards.filters.season")} active={sort.key === "season"} dir={sort.dir} onClick={() => sortBy("season")} />
              <th className="p-3 text-right">{t("staffCards.col.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">{assignedStudents.length === 0 ? t("staffCards.students.empty") : t("staffCards.filters.noMatch")}</td></tr>
            ) : filtered.map(s => (
              <tr key={s.id} className="border-t hover:bg-muted/30">
                <td className="p-3 font-medium">{displayName(s)}</td>
                <td className="p-3 text-muted-foreground">{s.email || "—"}</td>
                <td className="p-3">{s.status ? <Badge variant="outline" className="capitalize">{s.status}</Badge> : "—"}</td>
                <td className="p-3 text-muted-foreground">{s.season || "—"}</td>
                <td className="p-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <Link href={`/staff/students/${s.id}`}><Button size="sm" variant="outline">{t("common.open")}</Button></Link>
                    <Button variant="ghost" size="icon" onClick={() => remove(s.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ─── Activity (matches User Activity look + planned vs actual) ──────────────
type ActPreset = "today" | "yesterday" | "7days" | "30days";
function getRange(p: ActPreset): { from: string; to: string } {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (p) {
    case "today": return { from: todayStart.toISOString(), to: now.toISOString() };
    case "yesterday": { const ys = new Date(todayStart); ys.setDate(ys.getDate() - 1); return { from: ys.toISOString(), to: todayStart.toISOString() }; }
    case "7days": { const d = new Date(todayStart); d.setDate(d.getDate() - 7); return { from: d.toISOString(), to: now.toISOString() }; }
    case "30days": { const d = new Date(todayStart); d.setDate(d.getDate() - 30); return { from: d.toISOString(), to: now.toISOString() }; }
  }
}

function ActivityTab({ userId }: { userId: number }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [preset, setPreset] = useState<ActPreset>("7days");
  const [detail, setDetail] = useState<any>(null);
  const [planned, setPlanned] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pdfLoading, setPdfLoading] = useState(false);

  async function handleDownloadPdf() {
    if (pdfLoading) return;
    setPdfLoading(true);
    try {
      const range = getRange(preset);
      const url = `/api/activity/report/pdf?userId=${userId}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("PDF generation failed");
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `activity-${userId}.pdf`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      toast({ title: t("common.error"), description: t("staffCards.kpi.downloadingPdf"), variant: "destructive" });
    } finally {
      setPdfLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const range = getRange(preset);
    const plannedRange = preset === "today" || preset === "yesterday" ? "daily" : preset === "7days" ? "weekly" : "monthly";
    setLoading(true);
    Promise.all([
      customFetch<any>(`/api/activity/user/${userId}?from=${range.from}&to=${range.to}`),
      customFetch<any>(`/api/staff-cards/${userId}/activity?range=${plannedRange}`).catch(() => null),
    ]).then(([d, p]) => { if (!cancelled) { setDetail(d); setPlanned(p); } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, preset]);

  const sessions = detail?.sessions || [];
  const moduleBreakdown = detail?.moduleBreakdown || [];
  const dailyBreakdown = detail?.dailyBreakdown || [];
  const totalActive = sessions.reduce((s: number, x: any) => s + (x.activeDurationSeconds || 0), 0);
  const totalIdle = sessions.reduce((s: number, x: any) => s + (x.idleDurationSeconds || 0), 0);
  const totalDuration = sessions.reduce((s: number, x: any) => s + (x.totalDurationSeconds || 0), 0);

  const cards = [
    { label: t("staffCards.kpi.totalSessions"), value: sessions.length, icon: Monitor, color: "text-blue-500 bg-blue-50 dark:bg-blue-500/10" },
    { label: t("staffCards.kpi.totalTime"), value: formatDuration(totalDuration), icon: Clock, color: "text-purple-500 bg-purple-50 dark:bg-purple-500/10" },
    { label: t("staffCards.kpi.activeTime"), value: formatDuration(totalActive), icon: Activity, color: "text-green-500 bg-green-50 dark:bg-green-500/10" },
    { label: t("staffCards.kpi.idleTime"), value: formatDuration(totalIdle), icon: Pause, color: "text-amber-500 bg-amber-50 dark:bg-amber-500/10" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 flex-wrap">
        {(["today", "yesterday", "7days", "30days"] as ActPreset[]).map(p => (
          <Button key={p} size="sm" variant={preset === p ? "default" : "outline"} className="rounded-xl text-xs"
            onClick={() => setPreset(p)}>
            {t(`staffCards.preset.${p}`)}
          </Button>
        ))}
        <Button size="sm" variant="outline" className="rounded-xl text-xs gap-1.5 ml-auto"
          onClick={handleDownloadPdf} disabled={pdfLoading || loading}>
          {pdfLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {pdfLoading ? t("staffCards.kpi.downloadingPdf") : t("staffCards.kpi.downloadPdf")}
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map((s, i) => (
          <Card key={i} className="p-4 border-none shadow-md shadow-black/5">
            <div className="flex items-center gap-3">
              <div className={`w-10 h-10 rounded-xl ${s.color} flex items-center justify-center shrink-0`}>
                <s.icon className="w-5 h-5" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-xl font-display font-bold">{loading ? "..." : s.value}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Planned vs Actual (from work schedule) */}
      {planned?.totals && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label={t("staffCards.kpi.planned")} value={formatDuration((planned.totals.plannedMinutes || 0) * 60)} />
          <StatCard label={t("staffCards.kpi.actual")} value={formatDuration((planned.totals.actualMinutes || 0) * 60)} />
          <StatCard label={t("staffCards.kpi.outside")} value={formatDuration((planned.totals.outsideMinutes || 0) * 60)} icon={<AlertTriangle className="h-4 w-4" />} />
          <StatCard label={t("staffCards.kpi.missing")} value={formatDuration((planned.totals.missingMinutes || 0) * 60)} />
          <StatCard label={t("staffCards.kpi.overtime")} value={formatDuration((planned.totals.overtimeMinutes || 0) * 60)} icon={<BadgeCheck className="h-4 w-4" />} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-5 border-none shadow-md shadow-black/5">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-purple-500" /> {t("staffCards.view.modules")}
          </h3>
          {moduleBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">—</p>
          ) : (
            <div className="space-y-3">
              {moduleBreakdown.map((m: any) => {
                const maxVisits = Math.max(...moduleBreakdown.map((x: any) => x.visitCount || 1));
                const pct = Math.round(((m.visitCount || 0) / maxVisits) * 100);
                return (
                  <div key={m.moduleName}>
                    <div className="flex justify-between items-center text-xs mb-1">
                      <span className="font-medium text-foreground">{m.moduleName}</span>
                      <span className="text-muted-foreground">{m.visitCount} · {formatDuration(m.totalDuration || m.activeDuration || 0)}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-green-500/80 to-green-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-5 border-none shadow-md shadow-black/5">
          <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-blue-500" /> {t("staffCards.view.daily")}
          </h3>
          {dailyBreakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">—</p>
          ) : (
            <div className="space-y-2">
              {dailyBreakdown.map((d: any) => {
                const maxDur = Math.max(...dailyBreakdown.map((x: any) => x.activeDuration || 1));
                const pct = Math.round(((d.activeDuration || 0) / maxDur) * 100);
                return (
                  <div key={d.day} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-24 shrink-0">{new Date(d.day).toLocaleDateString([], { month: "short", day: "numeric" })}</span>
                    <div className="flex-1 h-5 bg-secondary rounded-full overflow-hidden relative">
                      <div className="h-full bg-gradient-to-r from-blue-500/80 to-blue-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs font-mono text-foreground w-16 text-right">{formatDuration(d.activeDuration || 0)}</span>
                    <span className="text-[10px] text-muted-foreground w-14 text-right">{d.sessionCount}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className="text-xl font-semibold mt-1">{value}</div>
    </Card>
  );
}

// ─── Salary ─────────────────────────────────────────────────────────────────
function SalaryTab({ payments, totals, userId, onSaved }: { payments: any[]; totals: any; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [form, setForm] = useState({ amount: "", currency: "USD", period: "monthly", payDate: "", status: "pending", notes: "" });
  const [bulkForm, setBulkForm] = useState({ count: "3", startDate: "", amount: "", currency: "USD", period: "monthly", notes: "" });
  const [bulkLoading, setBulkLoading] = useState(false);

  const bulkGenerate = async () => {
    if (!bulkForm.amount || !bulkForm.count) return;
    setBulkLoading(true);
    try {
      const r = await customFetch(`/api/staff-cards/${userId}/salary-payments/bulk`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count: Number(bulkForm.count),
          amount: Number(bulkForm.amount),
          currency: bulkForm.currency,
          period: bulkForm.period,
          startDate: bulkForm.startDate || undefined,
          notes: bulkForm.notes || null,
        }),
      });
      const data: any = r;
      toast({ title: t("staffCards.salary.bulkSuccess", { count: String(data.created) }) });
      setBulkForm({ count: "3", startDate: "", amount: "", currency: "USD", period: "monthly", notes: "" });
      onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
    finally { setBulkLoading(false); }
  };

  const add = async () => {
    if (!form.amount) return;
    try {
      await customFetch(`/api/staff-cards/${userId}/salary-payments`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, amount: Number(form.amount), payDate: form.payDate || null, notes: form.notes || null }),
      });
      setForm({ amount: "", currency: "USD", period: "monthly", payDate: "", status: "pending", notes: "" });
      onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const updateStatus = async (id: number, status: string) => {
    try { await customFetch(`/api/staff-cards/${userId}/salary-payments/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const remove = async (id: number) => {
    try { await customFetch(`/api/staff-cards/${userId}/salary-payments/${id}`, { method: "DELETE" }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label={t("staffCards.salary.totalPaid")} value={`${totals.paid.toFixed(2)}`} />
        <StatCard label={t("staffCards.salary.totalPending")} value={`${totals.pending.toFixed(2)}`} />
      </div>
      {/* Bulk generate section */}
      <Card className="p-4 border-dashed border-2 border-primary/30 bg-primary/5">
        <p className="text-xs font-semibold text-primary uppercase tracking-wide mb-3">{t("staffCards.salary.bulkGenerate")}</p>
        <div className="grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
          <div>
            <Label className="text-xs">{t("staffCards.salary.bulkCount")}</Label>
            <Input type="number" min="1" max="36" value={bulkForm.count} onChange={e => setBulkForm(f => ({ ...f, count: e.target.value }))} />
          </div>
          <div>
            <Label className="text-xs">{t("staffCards.salary.bulkStartDate")}</Label>
            <Input type="date" value={bulkForm.startDate} onChange={e => setBulkForm(f => ({ ...f, startDate: e.target.value }))} />
          </div>
          <div>
            <Label className="text-xs">{t("staffCards.salary.amount")}</Label>
            <Input type="number" value={bulkForm.amount} onChange={e => setBulkForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <div>
            <Label className="text-xs">{t("staffCards.salary.currency")}</Label>
            <Input value={bulkForm.currency} onChange={e => setBulkForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </div>
          <div>
            <Label className="text-xs">{t("staffCards.salary.period")}</Label>
            <Select value={bulkForm.period} onValueChange={v => setBulkForm(f => ({ ...f, period: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">{t("staffCards.salary.monthly")}</SelectItem>
                <SelectItem value="weekly">{t("staffCards.salary.weekly")}</SelectItem>
                <SelectItem value="biweekly">{t("staffCards.salary.biweekly")}</SelectItem>
                <SelectItem value="hourly">{t("staffCards.salary.hourly")}</SelectItem>
                <SelectItem value="project">{t("staffCards.salary.project")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("staffCards.salary.notes")}</Label>
            <Input value={bulkForm.notes} onChange={e => setBulkForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <Button onClick={bulkGenerate} disabled={bulkLoading || !bulkForm.amount} className="w-full">
            {bulkLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            {t("staffCards.salary.bulkGenerate")}
          </Button>
        </div>
      </Card>
      <Card className="p-4 grid grid-cols-1 md:grid-cols-7 gap-2 items-end">
        <div><Label>{t("staffCards.salary.amount")}</Label><Input type="number" value={form.amount} onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))} /></div>
        <div><Label>{t("staffCards.salary.currency")}</Label><Input value={form.currency} onChange={(e) => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></div>
        <div>
          <Label>{t("staffCards.salary.period")}</Label>
          <Select value={form.period} onValueChange={(v) => setForm(f => ({ ...f, period: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">{t("staffCards.salary.monthly")}</SelectItem>
              <SelectItem value="weekly">{t("staffCards.salary.weekly")}</SelectItem>
              <SelectItem value="biweekly">{t("staffCards.salary.biweekly")}</SelectItem>
              <SelectItem value="hourly">{t("staffCards.salary.hourly")}</SelectItem>
              <SelectItem value="project">{t("staffCards.salary.project")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div><Label>{t("staffCards.salary.payDate")}</Label><Input type="date" value={form.payDate} onChange={(e) => setForm(f => ({ ...f, payDate: e.target.value }))} /></div>
        <div>
          <Label>{t("staffCards.salary.status")}</Label>
          <Select value={form.status} onValueChange={(v) => setForm(f => ({ ...f, status: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">{t("staffCards.salary.pending")}</SelectItem>
              <SelectItem value="paid">{t("staffCards.salary.paid")}</SelectItem>
              <SelectItem value="cancelled">{t("staffCards.salary.cancelled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2 flex gap-2">
          <Input className="flex-1" placeholder={t("staffCards.salary.notes")} value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} />
          <Button onClick={add}><Plus className="h-4 w-4" /></Button>
        </div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase">
            <tr><th className="p-3">{t("staffCards.salary.payDate")}</th><th className="p-3">{t("staffCards.salary.amount")}</th><th className="p-3">{t("staffCards.salary.period")}</th><th className="p-3">{t("staffCards.salary.status")}</th><th className="p-3">{t("staffCards.salary.notes")}</th><th className="p-3 text-right">{t("staffCards.col.actions")}</th></tr>
          </thead>
          <tbody>
            {payments.length === 0 && <tr><td className="p-4 text-muted-foreground" colSpan={6}>{t("staffCards.salary.empty")}</td></tr>}
            {payments.map(p => (
              <tr key={p.id} className="border-t">
                <td className="p-3">{p.payDate ? new Date(p.payDate).toLocaleDateString() : "—"}</td>
                <td className="p-3 font-medium">{Number(p.amount).toFixed(2)} {p.currency}</td>
                <td className="p-3">{t(`staffCards.salary.${p.period}`)}</td>
                <td className="p-3">
                  <Select value={p.status} onValueChange={(v) => updateStatus(p.id, v)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">{t("staffCards.salary.pending")}</SelectItem>
                      <SelectItem value="paid">{t("staffCards.salary.paid")}</SelectItem>
                      <SelectItem value="cancelled">{t("staffCards.salary.cancelled")}</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td className="p-3 text-muted-foreground">{p.notes || "—"}</td>
                <td className="p-3 text-right"><Button variant="ghost" size="icon" onClick={() => remove(p.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── Commissions ────────────────────────────────────────────────────────────
function CommissionsTab({ commissions, totals, userId, onSaved }: { commissions: any[]; totals: any; userId: number; onSaved: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();

  // Fetch direct-student enrollment bonus buckets for this staff member
  const { data: bonusData } = useQuery({
    queryKey: ["staff-bonus-per", userId],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/staff-bonuses?staffUserId=${userId}`),
    staleTime: 30_000,
  });

  // 4 buckets from direct-bonus endpoint (mutually exclusive, correct derivation)
  const potentialAmt = bonusData?.potential?.amount ?? commissions.filter(c => c.status === "potential").reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
  const confirmedAmt = bonusData?.confirmed?.amount ?? commissions.filter(c => c.status === "approved").reduce((s: number, c: any) => s + Number(c.amount || 0), 0);
  const paidAmt = bonusData?.paid?.amount ?? totals.paid;
  const pendingAmt = bonusData?.pending?.amount ?? totals.pending;

  const [form, setForm] = useState({ amount: "", currency: "USD", studentId: "", applicationId: "", payDate: "", status: "pending", notes: "" });

  const add = async () => {
    if (!form.amount) return;
    try {
      const body: any = {
        amount: Number(form.amount), currency: form.currency,
        studentId: form.studentId ? Number(form.studentId) : null,
        applicationId: form.applicationId ? Number(form.applicationId) : null,
        status: form.status, payDate: form.payDate || null, notes: form.notes || null,
      };
      await customFetch(`/api/staff-cards/${userId}/commissions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setForm({ amount: "", currency: "USD", studentId: "", applicationId: "", payDate: "", status: "pending", notes: "" });
      onSaved();
    } catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const updateStatus = async (id: number, status: string) => {
    try { await customFetch(`/api/staff-cards/${userId}/commissions/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  const remove = async (id: number) => {
    try { await customFetch(`/api/staff-cards/${userId}/commissions/${id}`, { method: "DELETE" }); onSaved(); }
    catch (err: any) { toast({ title: t("common.error"), description: String(err.message || err), variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label={t("staffCards.commissions.potential")} value={potentialAmt.toFixed(2)} />
        <StatCard label={t("staffCards.commissions.confirmed")} value={confirmedAmt.toFixed(2)} />
        <StatCard label={t("staffCards.commissions.totalPaid")} value={paidAmt.toFixed(2)} />
        <StatCard label={t("staffCards.commissions.pending")} value={pendingAmt.toFixed(2)} />
      </div>
      <Card className="p-4 grid grid-cols-2 md:grid-cols-7 gap-2 items-end">
        <div><Label>{t("staffCards.salary.amount")}</Label><Input type="number" value={form.amount} onChange={(e) => setForm(f => ({ ...f, amount: e.target.value }))} /></div>
        <div><Label>{t("staffCards.salary.currency")}</Label><Input value={form.currency} onChange={(e) => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></div>
        <div><Label>{t("staffCards.commissions.studentId")}</Label><Input type="number" value={form.studentId} onChange={(e) => setForm(f => ({ ...f, studentId: e.target.value }))} /></div>
        <div><Label>{t("staffCards.commissions.applicationId")}</Label><Input type="number" value={form.applicationId} onChange={(e) => setForm(f => ({ ...f, applicationId: e.target.value }))} /></div>
        <div><Label>{t("staffCards.salary.payDate")}</Label><Input type="date" value={form.payDate} onChange={(e) => setForm(f => ({ ...f, payDate: e.target.value }))} /></div>
        <div>
          <Label>{t("staffCards.salary.status")}</Label>
          <Select value={form.status} onValueChange={(v) => setForm(f => ({ ...f, status: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="potential">{t("staffCards.commissions.potential")}</SelectItem>
              <SelectItem value="pending">{t("staffCards.salary.pending")}</SelectItem>
              <SelectItem value="approved">{t("staffCards.commissions.approved")}</SelectItem>
              <SelectItem value="paid">{t("staffCards.salary.paid")}</SelectItem>
              <SelectItem value="cancelled">{t("staffCards.salary.cancelled")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2"><Input className="flex-1" placeholder={t("staffCards.salary.notes")} value={form.notes} onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))} /><Button onClick={add}><Plus className="h-4 w-4" /></Button></div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase">
            <tr><th className="p-3">{t("staffCards.salary.payDate")}</th><th className="p-3">{t("staffCards.salary.amount")}</th><th className="p-3">{t("staffCards.commissions.refs")}</th><th className="p-3">{t("staffCards.salary.status")}</th><th className="p-3">{t("staffCards.salary.notes")}</th><th className="p-3 text-right">{t("staffCards.col.actions")}</th></tr>
          </thead>
          <tbody>
            {commissions.length === 0 && <tr><td className="p-4 text-muted-foreground" colSpan={6}>{t("staffCards.commissions.empty")}</td></tr>}
            {commissions.map(c => (
              <tr key={c.id} className="border-t">
                <td className="p-3">{c.payDate ? new Date(c.payDate).toLocaleDateString() : "—"}</td>
                <td className="p-3 font-medium">{Number(c.amount).toFixed(2)} {c.currency}</td>
                <td className="p-3 text-xs text-muted-foreground">
                  {c.studentId ? `S#${c.studentId}` : ""} {c.agentId ? `· A#${c.agentId}` : ""} {c.applicationId ? `· App#${c.applicationId}` : ""}
                </td>
                <td className="p-3">
                  <Select value={c.status} onValueChange={(v) => updateStatus(c.id, v)}>
                    <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="potential">{t("staffCards.commissions.potential")}</SelectItem>
                      <SelectItem value="pending">{t("staffCards.salary.pending")}</SelectItem>
                      <SelectItem value="approved">{t("staffCards.commissions.approved")}</SelectItem>
                      <SelectItem value="paid">{t("staffCards.salary.paid")}</SelectItem>
                      <SelectItem value="cancelled">{t("staffCards.salary.cancelled")}</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td className="p-3 text-muted-foreground">{c.notes || "—"}</td>
                <td className="p-3 text-right"><Button variant="ghost" size="icon" onClick={() => remove(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

