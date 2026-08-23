import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSeason } from "@/contexts/SeasonContext";
import {
  useListCommissions, useListServiceFees, useGetFinanceSummary,
  customFetch,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ColumnHeader } from "@/components/ui/column-header";
import { Textarea } from "@/components/ui/textarea";
import {
  DollarSign, TrendingUp, Building2, Users, Plus, Trash2, Pencil,
  CheckCircle, Clock, AlertCircle, Loader2, RefreshCw, ArrowUpRight,
  Upload, FileText, Download, BarChart3, AlertTriangle, Calendar,
  Landmark, CreditCard, PiggyBank, Eye, ArrowUpDown, ArrowUp, ArrowDown,
  Filter as FilterIcon, X, Check, ChevronsUpDown,
} from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import { useI18n } from "@/hooks/use-i18n";
import { CurrencySelector } from "@/components/CurrencySelector";
import { useCurrencyPreference } from "@/hooks/use-currency-preference";
import { formatMoney, SUPPORTED_CURRENCIES, listNonZeroCurrencies, type CurrencyCode } from "@/lib/currency";
import { useCatalogCurrencies } from "@/hooks/use-catalog-currencies";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function downloadExcel(url: string, filename: string): Promise<void> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error("Export failed");
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

const toNum = (v: any) => parseFloat(String(v ?? 0)) || 0;
const fmt = (v: any, currency: string | null | undefined = "USD") =>
  formatMoney(v, currency);
const pct = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 100) : 0;

const currentYear = String(new Date().getFullYear());
const seasons = Array.from({ length: 5 }, (_, i) => String(new Date().getFullYear() - 2 + i));

const COMM_STATUS: Record<string, { label: string; color: string }> = {
  potential:       { label: "statusPotential", color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60" },
  confirmed:       { label: "statusConfirmed", color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60" },
  collected_partial: { label: "statusPartCollected", color: "bg-indigo-100 text-indigo-700 border-indigo-200 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700/60" },
  collected_full:  { label: "statusCollected", color: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60" },
  settled:         { label: "statusSettled", color: "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/60" },
  excluded:        { label: "statusExcluded", color: "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600/50" },
};

const FEE_STATUS: Record<string, { label: string; color: string }> = {
  pending: { label: "statusPending", color: "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60" },
  partial: { label: "statusPartCollected", color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60" },
  paid:    { label: "statusPaid", color: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60" },
};

const FEE_FINANCE_STATUS: Record<string, { label: string; color: string }> = {
  potential:  { label: "statusPotential", color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60" },
  confirmed:  { label: "statusConfirmed", color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60" },
  excluded:   { label: "statusExcluded", color: "bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-800/50 dark:text-slate-300 dark:border-slate-600/50" },
};

function StatCard({ icon: Icon, label, value, sub, color = "text-indigo-600" }: {
  icon: any; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <>
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className={`p-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <p className="text-xs text-slate-500 dark:text-slate-400 font-medium uppercase tracking-wide">{label}</p>
          <p className="text-lg font-bold text-slate-800 dark:text-slate-100">{value}</p>
          {sub && <p className="text-xs text-slate-400 dark:text-slate-500">{sub}</p>}
        </div>
      </CardContent>
    </Card>
    </>
  );
}

function FinanceStatCard({ icon: Icon, label, rows, color = "text-indigo-600", borderColor = "border-t-blue-500" }: {
  icon: any; label: string; rows: { label: string; value: string }[]; color?: string; borderColor?: string;
}) {
  return (
    <>
    <Card className={`border-t-2 ${borderColor}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <div className={`p-1.5 rounded-md bg-slate-50 dark:bg-slate-800/60 ${color}`}>
            <Icon className="w-4 h-4" />
          </div>
          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-semibold uppercase tracking-wider">{label}</p>
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="text-xs text-slate-500 dark:text-slate-400">{row.label}</span>
              <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{row.value}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
    </>
  );
}

function ProgressBar({ value, max, color = "bg-blue-500" }: { value: number; max: number; color?: string }) {
  const p = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <>
    <div className="w-full bg-slate-100 dark:bg-slate-700/50 rounded-full h-2 mt-1">
      <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${p}%` }} />
    </div>
    </>
  );
}

interface CommissionForm {
  studentName: string;
  universityName: string;
  programName: string;
  season: string;
  currency: string;
  isStateUniversity: boolean;
  programFee: string;
  universityCommissionRate: string;
  agentCommissionRate: string;
  agentId: string;
  subAgentCommissionRate: string;
  subAgentId: string;
  status: string;
  universityCollected: string;
  agentPaid: string;
  subAgentPaid: string;
  offsetAmount: string;
  notes: string;
  studentId: string;
  applicationId: string;
  staffUserId: string;
  staffCommissionAmount: string;
  staffCommissionCurrency: string;
}

const EMPTY_COMM: CommissionForm = {
  studentName: "", universityName: "", programName: "",
  season: currentYear, currency: "USD", isStateUniversity: false,
  programFee: "", universityCommissionRate: "20", agentCommissionRate: "70",
  agentId: "", subAgentCommissionRate: "", subAgentId: "",
  status: "potential",
  universityCollected: "0", agentPaid: "0", subAgentPaid: "0", offsetAmount: "0",
  notes: "",
  studentId: "", applicationId: "",
  staffUserId: "", staffCommissionAmount: "", staffCommissionCurrency: "USD",
};

function CommissionModal({
  open, onClose, initial, editId,
}: {
  open: boolean; onClose: () => void; initial?: CommissionForm; editId?: number;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<CommissionForm>(initial || EMPTY_COMM);
  const [saving, setSaving] = useState(false);
  const currencyOpts = useCatalogCurrencies();

  const [stuPickerOpen, setStuPickerOpen] = useState(false);
  const [stuQuery, setStuQuery] = useState("");
  const [stuResults, setStuResults] = useState<any[]>([]);
  const [stuSearching, setStuSearching] = useState(false);

  const { data: agentsResp } = useQuery({
    queryKey: ["agents-list"],
    queryFn: () => customFetch<any>(`${BASE}/api/agents?limit=500`),
    enabled: open,
  });
  const allAgents = Array.isArray(agentsResp) ? agentsResp : (agentsResp?.data || []);
  const parentAgents = allAgents.filter((a: any) => !a.parentAgentId);

  const agentIdNum = form.agentId ? parseInt(form.agentId, 10) : 0;
  const { data: subAgentsData } = useQuery({
    queryKey: ["agent-sub-agents", agentIdNum],
    queryFn: () => customFetch<any[]>(`${BASE}/api/agents/${agentIdNum}/sub-agents`),
    enabled: agentIdNum > 0,
  });
  const subAgents: any[] = subAgentsData || [];

  const { data: staffUsersResp } = useQuery({
    queryKey: ["staff-users-finance"],
    queryFn: () => customFetch<any>(`${BASE}/api/users?roles=staff%2Cconsultant%2Ceditor%2Caccountant%2Cmanager%2Cadmin&limit=200`),
    enabled: open,
  });
  const staffUsers: any[] = (staffUsersResp as any)?.data || (Array.isArray(staffUsersResp) ? staffUsersResp : []);

  const { data: stuAppsResp } = useQuery({
    queryKey: ["finance-student-apps", form.studentId],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/student-applications/${form.studentId}`),
    enabled: !!form.studentId,
  });
  const stuApps: any[] = (stuAppsResp as any)?.data || [];

  useEffect(() => {
    if (stuQuery.length < 2) { setStuResults([]); setStuSearching(false); return; }
    setStuSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await customFetch<any>(`${BASE}/api/finance/student-search?q=${encodeURIComponent(stuQuery)}&limit=10`);
        setStuResults((res as any)?.data || []);
      } catch { setStuResults([]); }
      finally { setStuSearching(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [stuQuery]);

  useEffect(() => {
    if (open) {
      setForm(initial || EMPTY_COMM);
      setStuQuery("");
      setStuResults([]);
      setStuPickerOpen(false);
    }
  }, [open]);

  const uRate = toNum(form.universityCommissionRate);
  const aRate = toNum(form.agentCommissionRate);
  const saRate = toNum(form.subAgentCommissionRate);
  const fee   = toNum(form.programFee);
  const uAmt  = fee > 0 && uRate > 0 ? (fee * uRate) / 100 : 0;
  const aAmt  = uAmt > 0 && aRate > 0 ? (uAmt * aRate) / 100 : 0;
  const saAmt = aAmt > 0 && saRate > 0 ? (aAmt * saRate) / 100 : 0;
  const stAmt = toNum(form.staffCommissionAmount);
  const netAgency = uAmt - aAmt - stAmt;
  const maxOffset = form.status !== "potential" && uAmt > 0 ? uAmt * 0.7 : 0;

  const set = (k: keyof CommissionForm) => (e: any) =>
    setForm(f => ({ ...f, [k]: e?.target ? e.target.value : e }));

  useEffect(() => {
    if (subAgents.length === 1 && !form.subAgentId) {
      const sa = subAgents[0];
      setForm(f => ({
        ...f,
        subAgentId: String(sa.id),
        subAgentCommissionRate: sa.commissionRate ? String(sa.commissionRate) : f.subAgentCommissionRate,
      }));
    }
  }, [subAgents]);

  function handleSubAgentChange(subAgentIdStr: string) {
    if (subAgentIdStr === "none" || !subAgentIdStr) {
      setForm(f => ({ ...f, subAgentId: "", subAgentCommissionRate: "" }));
      return;
    }
    const sa = subAgents.find((a: any) => String(a.id) === subAgentIdStr);
    setForm(f => ({
      ...f,
      subAgentId: subAgentIdStr,
      subAgentCommissionRate: sa?.commissionRate ? String(sa.commissionRate) : f.subAgentCommissionRate,
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const body = {
        ...form,
        programFee: toNum(form.programFee) || null,
        universityCommissionRate: uRate || null,
        universityCommissionAmount: uAmt || null,
        agentCommissionRate: aRate || null,
        agentCommissionAmount: aAmt || null,
        subAgentCommissionRate: saRate || null,
        subAgentCommissionAmount: saAmt || null,
        agentId: form.agentId ? parseInt(form.agentId, 10) : null,
        subAgentId: form.subAgentId ? parseInt(form.subAgentId, 10) : null,
        studentId: form.studentId ? parseInt(form.studentId, 10) : null,
        applicationId: form.applicationId ? parseInt(form.applicationId, 10) : null,
        staffUserId: form.staffUserId ? parseInt(form.staffUserId, 10) : null,
        staffCommissionAmount: stAmt || null,
        staffCommissionCurrency: form.staffCommissionCurrency || null,
        universityCollected: toNum(form.universityCollected),
        agentPaid: toNum(form.agentPaid),
        subAgentPaid: toNum(form.subAgentPaid),
        offsetAmount: toNum(form.offsetAmount),
        isStateUniversity: form.isStateUniversity,
      };
      if (editId) {
        await customFetch(`${BASE}/api/commissions/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await customFetch(`${BASE}/api/commissions`, { method: "POST", body: JSON.stringify(body) });
      }
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: editId ? "Commission updated" : "Commission created" });
      onClose();
    } catch { toast({ title: t("financePage.errorSavingCommission"), variant: "destructive" }); }
    finally { setSaving(false); }
  }

  const calcColsMap: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-4" };
  const calcCols = calcColsMap[[saAmt > 0, stAmt > 0].filter(Boolean).length + 2] ?? "grid-cols-4";

  return (
    <>
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editId ? t("financePage.editCommission") : t("financePage.newCommission")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">

          {/* Student combobox */}
          <div className="col-span-2">
            <Label>{t("financePage.studentName")}</Label>
            <Popover open={stuPickerOpen} onOpenChange={setStuPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  className="w-full justify-between font-normal h-9 text-left"
                >
                  <span className={form.studentId ? "text-slate-800 dark:text-slate-100" : "text-slate-400"}>
                    {form.studentId
                      ? (form.studentName || `#${form.studentId}`)
                      : (form.studentName || t("financePage.searchStudent"))}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[440px] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    placeholder={t("financePage.searchStudent")}
                    value={stuQuery}
                    onValueChange={setStuQuery}
                  />
                  <CommandList>
                    {stuSearching && (
                      <CommandEmpty>
                        <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                      </CommandEmpty>
                    )}
                    {!stuSearching && stuQuery.length < 2 && (
                      <CommandEmpty className="text-xs text-slate-400 py-3 text-center">
                        {t("financePage.typeToSearch")}
                      </CommandEmpty>
                    )}
                    {!stuSearching && stuQuery.length >= 2 && stuResults.length === 0 && (
                      <CommandEmpty>{t("financePage.noStudentFound")}</CommandEmpty>
                    )}
                    {stuResults.length > 0 && (
                      <CommandGroup>
                        {stuResults.map((s: any) => (
                          <CommandItem
                            key={s.id}
                            value={String(s.id)}
                            onSelect={() => {
                              setForm(f => ({
                                ...f,
                                studentId: String(s.id),
                                studentName: s.name,
                                applicationId: "",
                                universityName: "",
                                programName: "",
                              }));
                              setStuPickerOpen(false);
                              setStuQuery("");
                              setStuResults([]);
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${form.studentId === String(s.id) ? "opacity-100" : "opacity-0"}`} />
                            <span>{s.name}</span>
                            {s.email && <span className="ml-2 text-xs text-slate-400">{s.email}</span>}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                    {form.studentId && (
                      <CommandGroup>
                        <CommandItem
                          value="__clear__"
                          onSelect={() => {
                            setForm(f => ({ ...f, studentId: "", studentName: "", applicationId: "", universityName: "", programName: "" }));
                            setStuPickerOpen(false);
                          }}
                          className="text-rose-600"
                        >
                          <X className="mr-2 h-4 w-4" />
                          {t("financePage.clearStudent")}
                        </CommandItem>
                      </CommandGroup>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Application picker — shown once a student is selected */}
          {form.studentId && (
            <div className="col-span-2">
              <Label>{t("financePage.selectApplication")}</Label>
              <Select
                value={form.applicationId || "none"}
                onValueChange={(val) => {
                  if (val === "none") {
                    setForm(f => ({ ...f, applicationId: "", universityName: "", programName: "" }));
                  } else {
                    const app = stuApps.find((a: any) => String(a.id) === val);
                    setForm(f => ({
                      ...f,
                      applicationId: val,
                      universityName: app?.universityName || f.universityName,
                      programName: app?.programName || f.programName,
                    }));
                  }
                }}
              >
                <SelectTrigger><SelectValue placeholder={t("financePage.selectApplication")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("financePage.noApplication")}</SelectItem>
                  {stuApps.map((a: any) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {[a.universityName, a.programName].filter(Boolean).join(" / ") || `App #${a.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* University / Program (locked when linked to application) */}
          <div>
            <Label>{t("financePage.universityName")}</Label>
            <Input
              value={form.universityName}
              onChange={set("universityName")}
              placeholder="University"
              readOnly={!!form.applicationId}
              className={form.applicationId ? "bg-slate-50 dark:bg-slate-800/40" : ""}
            />
          </div>
          <div>
            <Label>{t("financePage.program")}</Label>
            <Input
              value={form.programName}
              onChange={set("programName")}
              placeholder="Program name"
              readOnly={!!form.applicationId}
              className={form.applicationId ? "bg-slate-50 dark:bg-slate-800/40" : ""}
            />
          </div>

          <div>
            <Label>{t("financePage.season")}</Label>
            <Select value={form.season} onValueChange={set("season")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{seasons.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("financePage.currency")}</Label>
            <Select value={form.currency} onValueChange={set("currency")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {currencyOpts.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("financePage.statusLabel")}</Label>
            <Select value={form.status} onValueChange={set("status")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(COMM_STATUS).map(([v, { label }]) =>
                  <SelectItem key={v} value={v}>{t(`financePage.${label}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div />

          <div className="col-span-2">
            <Label>{t("financePage.agent")}</Label>
            <Select value={form.agentId || "none"} onValueChange={(val) => {
              if (val === "none") {
                setForm(f => ({ ...f, agentId: "", subAgentId: "", subAgentCommissionRate: "" }));
              } else {
                setForm(f => ({ ...f, agentId: val, subAgentId: "", subAgentCommissionRate: "" }));
              }
            }}>
              <SelectTrigger><SelectValue placeholder={t("financePage.selectAgent")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("financePage.noAgent")}</SelectItem>
                {parentAgents.map((a: any) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.firstName} {a.lastName}{a.companyName ? ` (${a.companyName})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Commission calculation box */}
          <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3 grid grid-cols-4 gap-3 dark:border-slate-700/60 dark:bg-slate-800/50">
            <div>
              <Label>Program Fee ({form.currency})</Label>
              <Input type="number" value={form.programFee} onChange={set("programFee")} placeholder="0" />
            </div>
            <div>
              <Label>University Rate (%)</Label>
              <Input type="number" value={form.universityCommissionRate} onChange={set("universityCommissionRate")} placeholder="20" />
            </div>
            <div>
              <Label>Agent Rate (%)</Label>
              <Input type="number" value={form.agentCommissionRate} onChange={set("agentCommissionRate")} placeholder="70" />
            </div>
            <div />
            {subAgents.length > 0 && (
              <>
                <div className="col-span-2">
                  <Label>{t("financePage.subAgent")}</Label>
                  <Select value={form.subAgentId || "none"} onValueChange={handleSubAgentChange}>
                    <SelectTrigger><SelectValue placeholder={t("financePage.selectSubAgent")} /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">{t("financePage.noSubAgent")}</SelectItem>
                      {subAgents.map((sa: any) => (
                        <SelectItem key={sa.id} value={String(sa.id)}>
                          {sa.firstName} {sa.lastName}{sa.commissionRate ? ` (${sa.commissionRate}%)` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label>Sub Agent Rate (%)</Label>
                  <Input type="number" value={form.subAgentCommissionRate} onChange={set("subAgentCommissionRate")} placeholder="0" />
                </div>
              </>
            )}

            {/* Staff commission fields */}
            <div className="col-span-2">
              <Label>{t("financePage.assignedStaff")}</Label>
              <Select value={form.staffUserId || "none"} onValueChange={(val) => setForm(f => ({ ...f, staffUserId: val === "none" ? "" : val }))}>
                <SelectTrigger><SelectValue placeholder={t("financePage.noStaff")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("financePage.noStaff")}</SelectItem>
                  {staffUsers.map((u: any) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {[u.firstName, u.lastName].filter(Boolean).join(" ") || `User #${u.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{t("financePage.staffCommissionAmount")}</Label>
              <Input type="number" value={form.staffCommissionAmount} onChange={set("staffCommissionAmount")} placeholder="0" />
            </div>
            <div>
              <Label>{t("financePage.currency")}</Label>
              <Select value={form.staffCommissionCurrency || form.currency} onValueChange={set("staffCommissionCurrency")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {currencyOpts.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {uAmt > 0 && (
              <div className={`col-span-4 grid ${calcCols} gap-2 pt-1 text-sm`}>
                <div className="rounded bg-blue-50 border border-blue-200 p-2 text-center dark:bg-blue-900/20 dark:border-blue-700/40">
                  <div className="text-xs text-blue-600 font-medium dark:text-blue-400">{t("financePage.universityPaysAgency")}</div>
                  <div className="font-bold text-blue-700 dark:text-blue-300">{fmt(uAmt, form.currency)}</div>
                </div>
                <div className="rounded bg-amber-50 border border-amber-200 p-2 text-center dark:bg-amber-900/20 dark:border-amber-700/40">
                  <div className="text-xs text-amber-600 font-medium dark:text-amber-400">{t("financePage.agencyPaysAgent")}</div>
                  <div className="font-bold text-amber-700 dark:text-amber-300">{fmt(aAmt, form.currency)}</div>
                </div>
                {saAmt > 0 && (
                  <div className="rounded bg-purple-50 border border-purple-200 p-2 text-center dark:bg-purple-900/20 dark:border-purple-700/40">
                    <div className="text-xs text-purple-600 font-medium dark:text-purple-400">{t("financePage.agentPaysSubAgent")}</div>
                    <div className="font-bold text-purple-700 dark:text-purple-300">{fmt(saAmt, form.currency)}</div>
                  </div>
                )}
                {stAmt > 0 && (
                  <div className="rounded bg-rose-50 border border-rose-200 p-2 text-center dark:bg-rose-900/20 dark:border-rose-700/40">
                    <div className="text-xs text-rose-600 font-medium dark:text-rose-400">{t("financePage.staffCommission")}</div>
                    <div className="font-bold text-rose-700 dark:text-rose-300">{fmt(stAmt, form.staffCommissionCurrency || form.currency)}</div>
                  </div>
                )}
                <div className="rounded bg-emerald-50 border border-emerald-200 p-2 text-center dark:bg-emerald-900/20 dark:border-emerald-700/40">
                  <div className="text-xs text-emerald-600 font-medium dark:text-emerald-400">{t("financePage.netIncome")}</div>
                  <div className="font-bold text-emerald-700 dark:text-emerald-300">{fmt(netAgency, form.currency)}</div>
                </div>
              </div>
            )}
          </div>

          <div>
            <Label>{t("financePage.universityCollected")}</Label>
            <Input type="number" value={form.universityCollected} onChange={set("universityCollected")} placeholder="0" />
          </div>
          <div>
            <Label>{t("financePage.agentPaidOut")}</Label>
            <Input type="number" value={form.agentPaid} onChange={set("agentPaid")} placeholder="0" />
          </div>
          {saAmt > 0 && (
            <div>
              <Label>{t("financePage.subAgentPaidOut")}</Label>
              <Input type="number" value={form.subAgentPaid} onChange={set("subAgentPaid")} placeholder="0" />
            </div>
          )}

          <div>
            <Label>{t("financePage.stateUniversity")}</Label>
            <div className="flex items-center gap-2 mt-2">
              <Checkbox
                checked={form.isStateUniversity}
                onCheckedChange={(v) => setForm(f => ({ ...f, isStateUniversity: !!v }))}
              />
              <span className="text-sm text-slate-600">{t("financePage.isStateUniversity")}</span>
            </div>
          </div>
          {form.isStateUniversity && (
            <div>
              <Label>Offset Amount (Art. 6) — max {fmt(maxOffset, form.currency)}</Label>
              <Input
                type="number"
                value={form.offsetAmount}
                onChange={set("offsetAmount")}
                max={maxOffset}
                placeholder="0"
              />
            </div>
          )}

          <div className="col-span-2">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={form.notes} onChange={set("notes")} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("financePage.cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {editId ? t("financePage.update") : t("financePage.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

interface ServiceFeeForm {
  studentName: string;
  universityName: string;
  isStateUniversity: boolean;
  payerType: string;
  season: string;
  currency: string;
  totalAmount: string;
  firstInstallmentPaidAt: string;
  secondInstallmentPaidAt: string;
  notes: string;
}

const EMPTY_FEE: ServiceFeeForm = {
  studentName: "", universityName: "",
  isStateUniversity: false, payerType: "student",
  season: currentYear, currency: "USD", totalAmount: "",
  firstInstallmentPaidAt: "", secondInstallmentPaidAt: "",
  notes: "",
};

function ServiceFeeModal({
  open, onClose, initial, editId,
}: {
  open: boolean; onClose: () => void; initial?: ServiceFeeForm; editId?: number;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<ServiceFeeForm>(initial || EMPTY_FEE);
  const [saving, setSaving] = useState(false);
  const currencyOpts = useCatalogCurrencies();

  const set = (k: keyof ServiceFeeForm) => (e: any) =>
    setForm(f => ({ ...f, [k]: e?.target ? e.target.value : e }));

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, any> = {
        ...form,
        totalAmount: toNum(form.totalAmount),
        isStateUniversity: form.isStateUniversity,
        firstInstallmentPaidAt: form.firstInstallmentPaidAt || null,
        secondInstallmentPaidAt: form.secondInstallmentPaidAt || null,
      };
      if (editId) {
        await customFetch(`${BASE}/api/service-fees/${editId}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await customFetch(`${BASE}/api/service-fees`, { method: "POST", body: JSON.stringify(body) });
      }
      qc.invalidateQueries({ queryKey: ["service-fees"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      toast({ title: editId ? "Service fee updated" : "Service fee created" });
      onClose();
    } catch { toast({ title: t("financePage.errorSavingServiceFee"), variant: "destructive" }); }
    finally { setSaving(false); }
  }

  const total = toNum(form.totalAmount);
  const half = total / 2;

  return (
    <>
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editId ? t("financePage.editServiceFee") : t("financePage.newServiceFee")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <Label>{t("financePage.studentName")}</Label>
            <Input value={form.studentName} onChange={set("studentName")} />
          </div>
          <div>
            <Label>{t("financePage.universityName")}</Label>
            <Input value={form.universityName} onChange={set("universityName")} />
          </div>
          <div>
            <Label>{t("financePage.payer")}</Label>
            <Select value={form.payerType} onValueChange={set("payerType")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="student">{t("financePage.student")}</SelectItem>
                <SelectItem value="agent">{t("financePage.agent")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("financePage.season")}</Label>
            <Select value={form.season} onValueChange={set("season")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{seasons.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("financePage.currency")}</Label>
            <Select value={form.currency} onValueChange={set("currency")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {currencyOpts.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("financePage.totalAmount")}</Label>
            <Input type="number" value={form.totalAmount} onChange={set("totalAmount")} placeholder="0" />
          </div>

          {total > 0 && (
            <div className="col-span-2 rounded-lg border border-slate-200 bg-slate-50 p-3 grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">1st Installment ({fmt(half, form.currency)})</Label>
                <Input
                  type="date"
                  value={form.firstInstallmentPaidAt}
                  onChange={set("firstInstallmentPaidAt")}
                  placeholder={t("financePage.paidDate")}
                />
                <p className="text-xs text-slate-400 mt-1">{t("financePage.leaveBlankIfUnpaid")}</p>
              </div>
              <div>
                <Label className="text-xs">2nd Installment ({fmt(half, form.currency)})</Label>
                <Input
                  type="date"
                  value={form.secondInstallmentPaidAt}
                  onChange={set("secondInstallmentPaidAt")}
                  placeholder={t("financePage.paidDate")}
                />
                <p className="text-xs text-slate-400 mt-1">{t("financePage.leaveBlankIfUnpaid")}</p>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Checkbox
              checked={form.isStateUniversity}
              onCheckedChange={(v) => setForm(f => ({ ...f, isStateUniversity: !!v }))}
            />
            <Label>{t("financePage.stateUniversity")}</Label>
          </div>

          <div className="col-span-2">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={form.notes} onChange={set("notes")} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("financePage.cancel")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {editId ? t("financePage.update") : t("financePage.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function TransactionModal({
  open, onClose, type, commissionId, commissionLabel, universityName,
}: {
  open: boolean; onClose: () => void;
  type: "collection" | "agent_payment" | "sub_agent_payment";
  commissionId?: number;
  commissionLabel?: string;
  universityName?: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [reference, setReference] = useState("");
  const [agentName, setAgentName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function uploadFile(): Promise<{ url: string; name: string } | null> {
    if (!file) return null;
    setUploading(true);
    try {
      const data: any = await customFetch(`${BASE}/api/storage/uploads/request-url`, {
        method: "POST",
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      const putResp = await fetch(data.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!putResp.ok) {
        console.error("Upload PUT failed:", putResp.status);
        return null;
      }
      return { url: `${BASE}/api/storage/objects/${data.objectPath.replace(/^\/objects\//, "")}`, name: file.name };
    } catch (e) {
      console.error("Upload error:", e);
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    if (!amount || !date) {
      toast({ title: t("financePage.amountAndDateRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      let fileUrl = null;
      let fileName = null;
      if (file) {
        const uploaded = await uploadFile();
        if (uploaded) {
          fileUrl = uploaded.url;
          fileName = uploaded.name;
        }
      }
      await customFetch(`${BASE}/api/financial-transactions`, {
        method: "POST",
        body: JSON.stringify({
          commissionId: commissionId || null,
          type,
          amount: toNum(amount),
          transactionDate: date,
          reference: reference || null,
          universityName: universityName || null,
          agentName: (type === "agent_payment" || type === "sub_agent_payment") ? agentName || null : null,
          fileUrl, fileName,
          notes: notes || null,
        }),
      });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["financial-transactions"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: type === "collection" ? t("financePage.recordedCollection") : type === "agent_payment" ? t("financePage.recordedAgentPayment") : t("financePage.recordedSubAgentPayment") });
      onClose();
    } catch { toast({ title: t("financePage.errorSavingTransaction"), variant: "destructive" }); }
    finally { setSaving(false); }
  }

  const isCollection = type === "collection";
  const isSubAgentPayment = type === "sub_agent_payment";

  return (
    <>
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isCollection ? t("financePage.recordCollection") : isSubAgentPayment ? t("financePage.recordSubAgentPayment") : t("financePage.recordAgentPayment")}
          </DialogTitle>
        </DialogHeader>
        {commissionLabel && (
          <p className="text-sm text-slate-500 -mt-2">For: <span className="font-medium text-slate-700">{commissionLabel}</span></p>
        )}
        <div className="grid grid-cols-2 gap-3 py-2">
          <div>
            <Label>{t("financePage.amount")}</Label>
            <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
          </div>
          <div>
            <Label>{t("financePage.date")}</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div className="col-span-2">
            <Label>{t("financePage.referenceLabel")}</Label>
            <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="INV-2025-001" />
          </div>
          {!isCollection && (
            <div className="col-span-2">
              <Label>{isSubAgentPayment ? t("financePage.subAgentNameLabel") : t("financePage.agentNameLabel")}</Label>
              <Input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder={isSubAgentPayment ? "Sub agent name" : "Agent name"} />
            </div>
          )}
          <div className="col-span-2">
            <Label>{t("financePage.attachDocument")}</Label>
            <div
              className="mt-1 border-2 border-dashed border-slate-200 rounded-lg p-4 text-center cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
                onChange={e => setFile(e.target.files?.[0] || null)}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span className="font-medium text-slate-700">{file.name}</span>
                  <span className="text-slate-400">({(file.size / 1024).toFixed(0)} KB)</span>
                </div>
              ) : (
                <div className="text-slate-400 text-sm">
                  <Upload className="w-5 h-5 mx-auto mb-1" />
                  Click to upload PDF, image, or document
                </div>
              )}
            </div>
          </div>
          <div className="col-span-2">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("financePage.cancel")}</Button>
          <Button onClick={save} disabled={saving || uploading}>
            {(saving || uploading) ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {uploading ? "Uploading..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function TransactionHistory({ commissionId }: { commissionId: number }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["financial-transactions", commissionId],
    queryFn: () => customFetch<any>(`${BASE}/api/financial-transactions?commissionId=${commissionId}`),
    enabled: open,
  });
  const qc = useQueryClient();
  const { toast } = useToast();
  const transactions: any[] = data?.data || [];

  async function deleteTx(id: number) {
    try {
      await customFetch(`${BASE}/api/financial-transactions/${id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["financial-transactions", commissionId] });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: t("financePage.transactionDeleted") });
    } catch { toast({ title: t("financePage.errorGeneric"), variant: "destructive" }); }
  }

  return (
    <>
    <>
      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setOpen(true)} title="View transactions">
        <Eye className="w-3.5 h-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("financePage.transactionHistory")}</DialogTitle>
          </DialogHeader>
          {isLoading ? (
            <div className="text-center py-8"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
          ) : transactions.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">{t("financePage.noTransactionsYet")}</p>
          ) : (
            <div className="space-y-2">
              {transactions.map((tx: any) => (
                <div key={tx.id} className="flex items-start gap-3 p-3 rounded-lg border border-slate-100 bg-slate-50 dark:border-slate-700/50 dark:bg-slate-800/50">
                  <div className={`p-1.5 rounded ${tx.type === "collection" ? "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300" : tx.type === "sub_agent_payment" ? "bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300" : "bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300"}`}>
                    {tx.type === "collection" ? <Landmark className="w-3.5 h-3.5" /> : <CreditCard className="w-3.5 h-3.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm text-slate-800">{fmt(tx.amount, tx.currency)}</span>
                      <span className="text-xs text-slate-400">{tx.transactionDate}</span>
                    </div>
                    <p className="text-xs text-slate-500">
                      {tx.type === "collection" ? t("financePage.recordCollection") : tx.type === "sub_agent_payment" ? `${t("financePage.recordSubAgentPayment")}${tx.agentName ? ` — ${tx.agentName}` : ""}` : `${t("financePage.recordAgentPayment")}${tx.agentName ? ` — ${tx.agentName}` : ""}`}
                    </p>
                    {tx.reference && <p className="text-xs text-slate-400">Ref: {tx.reference}</p>}
                    {tx.fileName && (
                      <a
                        href={tx.fileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-0.5"
                      >
                        <FileText className="w-3 h-3" /> {tx.fileName}
                      </a>
                    )}
                  </div>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-rose-400 hover:text-rose-600" onClick={() => deleteTx(tx.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
    </>
  );
}

function StaffCommissionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { season } = useSeason();

  const [staffOpen, setStaffOpen] = useState(false);
  const [selStaffId, setSelStaffId] = useState<number | null>(null);
  const [selCurrency, setSelCurrency] = useState("");
  const [staffSearch, setStaffSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [reference, setReference] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSelStaffId(null); setSelCurrency(""); setStaffSearch("");
      setAmount(""); setDate(new Date().toISOString().split("T")[0]);
      setReference(""); setAttachmentUrl(""); setNotes("");
    }
  }, [open]);

  const { data: payablesData, isLoading: payablesLoading } = useQuery({
    queryKey: ["staff-payables", season],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/staff-payables?season=${encodeURIComponent(season)}`),
    enabled: open,
  });

  const payables: any[] = payablesData?.data || [];

  const staffList = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>();
    for (const p of payables) {
      if (!map.has(Number(p.staffUserId))) {
        map.set(Number(p.staffUserId), { id: Number(p.staffUserId), name: p.staffName });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [payables]);

  const filteredStaff = useMemo(() =>
    staffSearch ? staffList.filter(s => s.name.toLowerCase().includes(staffSearch.toLowerCase())) : staffList,
    [staffList, staffSearch]
  );

  const currencyOptions = useMemo(() =>
    payables
      .filter(p => Number(p.staffUserId) === selStaffId && toNum(p.remaining) > 0)
      .map(p => ({ currency: p.currency, remaining: toNum(p.remaining) })),
    [payables, selStaffId]
  );

  const remainingBalance = useMemo(() => {
    const r = payables.find(p => Number(p.staffUserId) === selStaffId && p.currency === selCurrency);
    return r ? toNum(r.remaining) : 0;
  }, [payables, selStaffId, selCurrency]);

  const selStaffName = staffList.find(s => s.id === selStaffId)?.name || "";

  useEffect(() => { setSelCurrency(""); setAmount(""); }, [selStaffId]);
  useEffect(() => { setAmount(""); }, [selCurrency]);

  const numAmount = toNum(amount);
  const exceedsBalance = numAmount > 0 && numAmount > remainingBalance + 0.001;

  async function save() {
    if (!selStaffId || !selCurrency || !amount || !date) {
      toast({ title: t("financePage.amountAndDateRequired"), variant: "destructive" });
      return;
    }
    if (exceedsBalance) return;
    setSaving(true);
    try {
      const result: any = await customFetch(`${BASE}/api/finance/staff-commission-payment`, {
        method: "POST",
        body: JSON.stringify({
          staffUserId: selStaffId,
          currency: selCurrency,
          amount: numAmount,
          transactionDate: date,
          reference: reference || null,
          attachmentUrl: attachmentUrl || null,
          notes: notes || null,
        }),
      });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["financial-transactions"] });
      qc.invalidateQueries({ queryKey: ["staff-payables"] });
      toast({
        title: t("financePage.recordedStaffPayment"),
        description: t("financePage.distributedAcross", { n: result.distributed?.length ?? 1 }),
      });
      onClose();
    } catch {
      toast({ title: t("financePage.errorSavingTransaction"), variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("financePage.recordStaffCommission")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label>{t("financePage.staffSelectStaff")}</Label>
            <Popover open={staffOpen} onOpenChange={setStaffOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={staffOpen}
                  className="w-full justify-between mt-1 font-normal">
                  {selStaffId ? selStaffName : t("financePage.staffSelectStaff")}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0" align="start">
                <Command>
                  <CommandInput placeholder={t("financePage.staffSearchStaff")} value={staffSearch} onValueChange={setStaffSearch} />
                  <CommandList>
                    {payablesLoading
                      ? <div className="flex items-center justify-center p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
                      : filteredStaff.length === 0
                        ? <CommandEmpty>{t("financePage.staffNoStaff")}</CommandEmpty>
                        : <CommandGroup>
                            {filteredStaff.map(s => (
                              <CommandItem key={s.id} value={String(s.id)} onSelect={() => {
                                setSelStaffId(s.id); setStaffOpen(false); setStaffSearch("");
                              }}>
                                <Check className={`mr-2 h-4 w-4 ${selStaffId === s.id ? "opacity-100" : "opacity-0"}`} />
                                {s.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                    }
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {selStaffId !== null && (
            <div className="col-span-2">
              <Label>{t("financePage.staffCurrencyLabel")}</Label>
              <Select value={selCurrency} onValueChange={setSelCurrency}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={t("financePage.staffCurrencyLabel")} />
                </SelectTrigger>
                <SelectContent>
                  {currencyOptions.map(o => (
                    <SelectItem key={o.currency} value={o.currency}>
                      {o.currency} — {t("financePage.staffRemainingBalance")}: {fmt(o.remaining, o.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {selStaffId !== null && selCurrency && remainingBalance > 0 && (
            <div className="col-span-2 flex items-center gap-2 bg-amber-50 rounded-lg p-3 dark:bg-amber-900/20">
              <span className="text-sm text-amber-600 dark:text-amber-300">{t("financePage.staffRemainingBalance")}:</span>
              <div className="text-lg font-bold text-amber-700 dark:text-amber-300">{fmt(remainingBalance, selCurrency)}</div>
            </div>
          )}

          <div>
            <Label>{t("financePage.collectionAmount")}</Label>
            <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0"
              className={exceedsBalance ? "border-rose-400" : ""} />
            {exceedsBalance && (
              <p className="text-xs text-rose-600 mt-0.5">{t("financePage.staffPaymentExceedsBalance")}</p>
            )}
          </div>
          <div>
            <Label>{t("financePage.date")}</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          <div className="col-span-2">
            <Label>{t("financePage.referenceLabel")}</Label>
            <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="PAY-2025-001" />
          </div>
          <div className="col-span-2">
            <Label>{t("financePage.attachDocumentUrl")}</Label>
            <Input value={attachmentUrl} onChange={e => setAttachmentUrl(e.target.value)} placeholder="https://..." />
          </div>
          <div className="col-span-2">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("financePage.cancel")}</Button>
          <Button onClick={save} disabled={saving || !selStaffId || !selCurrency || !amount || exceedsBalance}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {t("financePage.recordStaffCommission")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentPaymentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { season } = useSeason();

  const [agentOpen, setAgentOpen] = useState(false);
  const [selAgentId, setSelAgentId] = useState<number | null>(null);
  const [selCurrency, setSelCurrency] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setSelAgentId(null); setSelCurrency(""); setAgentSearch("");
      setAmount(""); setDate(new Date().toISOString().split("T")[0]);
      setReference(""); setNotes("");
    }
  }, [open]);

  const { data: payablesData, isLoading: payablesLoading } = useQuery({
    queryKey: ["agent-payables", season],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/agent-payables?season=${encodeURIComponent(season)}`),
    enabled: open,
  });

  const payables: any[] = payablesData?.data || [];

  const agentList = useMemo(() => {
    const map = new Map<number, { id: number; name: string }>();
    for (const p of payables) {
      if (!map.has(Number(p.agentId))) {
        map.set(Number(p.agentId), { id: Number(p.agentId), name: p.agentName });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [payables]);

  const filteredAgents = useMemo(() =>
    agentSearch ? agentList.filter(a => a.name.toLowerCase().includes(agentSearch.toLowerCase())) : agentList,
    [agentList, agentSearch]
  );

  const currencyOptions = useMemo(() =>
    payables
      .filter(p => Number(p.agentId) === selAgentId && toNum(p.remaining) > 0)
      .map(p => ({ currency: p.currency, remaining: toNum(p.remaining) })),
    [payables, selAgentId]
  );

  const remainingBalance = useMemo(() => {
    const r = payables.find(p => Number(p.agentId) === selAgentId && p.currency === selCurrency);
    return r ? toNum(r.remaining) : 0;
  }, [payables, selAgentId, selCurrency]);

  const selAgentName = agentList.find(a => a.id === selAgentId)?.name || "";

  useEffect(() => { setSelCurrency(""); setAmount(""); }, [selAgentId]);
  useEffect(() => { setAmount(""); }, [selCurrency]);

  const numAmount = toNum(amount);
  const exceedsBalance = numAmount > 0 && numAmount > remainingBalance + 0.001;

  async function save() {
    if (!selAgentId || !selCurrency || !amount || !date) {
      toast({ title: t("financePage.amountAndDateRequired"), variant: "destructive" });
      return;
    }
    if (exceedsBalance) return;
    setSaving(true);
    try {
      const result: any = await customFetch(`${BASE}/api/finance/agent-payment`, {
        method: "POST",
        body: JSON.stringify({
          agentId: selAgentId,
          currency: selCurrency,
          amount: numAmount,
          transactionDate: date,
          reference: reference || null,
          notes: notes || null,
        }),
      });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["financial-transactions"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      qc.invalidateQueries({ queryKey: ["agent-payables"] });
      toast({
        title: t("financePage.recordedAgentPayment"),
        description: t("financePage.distributedAcross", { n: result.distributed?.length ?? 1 }),
      });
      onClose();
    } catch {
      toast({ title: t("financePage.errorSavingTransaction"), variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("financePage.recordAgentPayment")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <Label>{t("financePage.agentSelectAgent")}</Label>
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={agentOpen}
                  className="w-full justify-between mt-1 font-normal">
                  {selAgentId ? selAgentName : t("financePage.agentSelectAgent")}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0" align="start">
                <Command>
                  <CommandInput placeholder={t("financePage.agentSearchAgent")} value={agentSearch} onValueChange={setAgentSearch} />
                  <CommandList>
                    {payablesLoading
                      ? <div className="flex items-center justify-center p-4"><Loader2 className="h-4 w-4 animate-spin" /></div>
                      : filteredAgents.length === 0
                        ? <CommandEmpty>{t("financePage.agentNoAgent")}</CommandEmpty>
                        : <CommandGroup>
                            {filteredAgents.map(a => (
                              <CommandItem key={a.id} value={String(a.id)} onSelect={() => {
                                setSelAgentId(a.id); setAgentOpen(false); setAgentSearch("");
                              }}>
                                <Check className={`mr-2 h-4 w-4 ${selAgentId === a.id ? "opacity-100" : "opacity-0"}`} />
                                {a.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                    }
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {selAgentId !== null && (
            <div className="col-span-2">
              <Label>{t("financePage.agentCurrencyLabel")}</Label>
              <Select value={selCurrency} onValueChange={setSelCurrency}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder={t("financePage.agentCurrencyLabel")} />
                </SelectTrigger>
                <SelectContent>
                  {currencyOptions.map(o => (
                    <SelectItem key={o.currency} value={o.currency}>
                      {o.currency} — {t("financePage.agentRemainingBalance")}: {fmt(o.remaining, o.currency)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {selAgentId !== null && selCurrency && remainingBalance > 0 && (
            <div className="col-span-2 flex items-center gap-2 bg-amber-50 rounded-lg p-3 dark:bg-amber-900/20">
              <span className="text-sm text-amber-600 dark:text-amber-300">{t("financePage.agentRemainingBalance")}:</span>
              <div className="text-lg font-bold text-amber-700 dark:text-amber-300">{fmt(remainingBalance, selCurrency)}</div>
            </div>
          )}

          <div>
            <Label>{t("financePage.collectionAmount")}</Label>
            <Input type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0"
              className={exceedsBalance ? "border-rose-400" : ""} />
            {exceedsBalance && (
              <p className="text-xs text-rose-600 mt-0.5">{t("financePage.agentPaymentExceedsBalance")}</p>
            )}
          </div>
          <div>
            <Label>{t("financePage.date")}</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          <div className="col-span-2">
            <Label>{t("financePage.referenceLabel")}</Label>
            <Input value={reference} onChange={e => setReference(e.target.value)} placeholder="PAY-2025-001" />
          </div>
          <div className="col-span-2">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("financePage.cancel")}</Button>
          <Button onClick={save} disabled={saving || !selAgentId || !selCurrency || !amount || exceedsBalance}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
            {t("financePage.recordAgentPayment")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UniversityCollectionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { season } = useSeason();

  const [uniOpen, setUniOpen] = useState(false);
  const [selectedUni, setSelectedUni] = useState("");
  const [selCurrency, setSelCurrency] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [uniSearch, setUniSearch] = useState("");

  const { data: recvData, isLoading: recvLoading } = useQuery<any>({
    queryKey: ["uni-receivables", season],
    queryFn: () => customFetch(`${BASE}/api/finance/university-receivables?season=${season}`),
    enabled: open,
  });

  const receivables: any[] = recvData?.data ?? [];

  const universities = useMemo(() =>
    [...new Set(receivables.map((r: any) => r.universityName as string))].sort()
  , [receivables]);

  const availableCurrencies = useMemo(() => {
    if (!selectedUni) return [] as string[];
    return receivables
      .filter((r: any) => r.universityName === selectedUni && toNum(r.remaining) > 0)
      .map((r: any) => r.currency as string);
  }, [receivables, selectedUni]);

  const remainingBalance = useMemo(() => {
    if (!selectedUni || !selCurrency) return 0;
    const r = receivables.find((r: any) => r.universityName === selectedUni && r.currency === selCurrency);
    return r ? toNum(r.remaining) : 0;
  }, [receivables, selectedUni, selCurrency]);

  useEffect(() => {
    if (availableCurrencies.length === 1) setSelCurrency(availableCurrencies[0]);
    else setSelCurrency("");
  }, [selectedUni]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredUnis = uniSearch
    ? universities.filter(u => u.toLowerCase().includes(uniSearch.toLowerCase()))
    : universities;

  function resetForm() {
    setSelectedUni(""); setSelCurrency(""); setAmount(""); setUniSearch("");
    setDate(new Date().toISOString().split("T")[0]);
    setReference(""); setNotes(""); setUniOpen(false);
  }

  async function save() {
    if (!selectedUni || !selCurrency || !amount || !date) {
      toast({ title: t("financePage.amountAndDateRequired"), variant: "destructive" }); return;
    }
    const num = toNum(amount);
    if (num <= 0) { toast({ title: t("financePage.amountAndDateRequired"), variant: "destructive" }); return; }
    if (num > remainingBalance + 0.001) {
      toast({ title: t("financePage.exceedsRemaining"), variant: "destructive" }); return;
    }
    setSaving(true);
    try {
      const result: any = await customFetch(`${BASE}/api/finance/university-collection`, {
        method: "POST",
        body: JSON.stringify({
          universityName: selectedUni,
          currency: selCurrency,
          amount: num,
          transactionDate: date,
          reference: reference || null,
          notes: notes || null,
        }),
      });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["uni-receivables"] });
      toast({
        title: t("financePage.recordedCollection"),
        description: t("financePage.distributedAcross", { n: result?.distributed?.length ?? 1 }),
      });
      resetForm();
      onClose();
    } catch {
      toast({ title: t("financePage.errorSavingTransaction"), variant: "destructive" });
    } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) { resetForm(); onClose(); } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("financePage.recordCollection")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("financePage.selectUniversity")}</Label>
            <Popover open={uniOpen} onOpenChange={setUniOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
                  <span className="truncate">{selectedUni || t("financePage.selectUniversity")}</span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-0" style={{ width: "var(--radix-popover-trigger-width)" }}>
                <Command>
                  <CommandInput
                    placeholder={t("financePage.searchUniversity")}
                    value={uniSearch}
                    onValueChange={setUniSearch}
                  />
                  <CommandList>
                    <CommandEmpty>
                      {recvLoading
                        ? <Loader2 className="w-4 h-4 animate-spin mx-auto my-2" />
                        : t("financePage.noUniversity")}
                    </CommandEmpty>
                    <CommandGroup>
                      {filteredUnis.map(u => (
                        <CommandItem key={u} value={u} onSelect={() => { setSelectedUni(u); setUniOpen(false); }}>
                          <Check className={`mr-2 h-4 w-4 ${selectedUni === u ? "opacity-100" : "opacity-0"}`} />
                          {u}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {selectedUni && (
            <div className="space-y-1.5">
              <Label>{t("financePage.currency")}</Label>
              <Select value={selCurrency} onValueChange={setSelCurrency}>
                <SelectTrigger><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  {availableCurrencies.map(c => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {selectedUni && selCurrency && remainingBalance > 0 && (
            <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 dark:bg-rose-900/20 dark:border-rose-700/40">
              <div className="text-xs font-medium text-rose-600 dark:text-rose-400">{t("financePage.receivableRemaining")}</div>
              <div className="text-lg font-bold text-rose-700 dark:text-rose-300">{fmt(remainingBalance, selCurrency)}</div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>{t("financePage.collectionAmount")}</Label>
            <Input
              type="number" min="0.01" step="0.01"
              value={amount} onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t("financePage.date")}</Label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("financePage.referenceLabel")}</Label>
            <Input value={reference} onChange={e => setReference(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>{t("financePage.notes")}</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => { resetForm(); onClose(); }}>{t("financePage.cancel")}</Button>
          <Button
            onClick={save}
            disabled={saving || !selectedUni || !selCurrency || !amount || toNum(amount) <= 0}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Landmark className="w-4 h-4 mr-1" />}
            {t("financePage.recordCollection")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FinancePage() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { season } = useSeason();
  const { currency, setCurrency } = useCurrencyPreference("finance-staff", "all");
  const [tab, setTab] = useState("commissions");
  const [commSearch, setCommSearch] = useState("");
  const [commStatus, setCommStatus] = useState("all");
  const [commAgentId, setCommAgentId] = useState("all");
  const [commStaffId, setCommStaffId] = useState("all");
  const [feeAgentId, setFeeAgentId] = useState("all");
  const [feeStaffId, setFeeStaffId] = useState("all");

  const [commModal, setCommModal] = useState<{ open: boolean; id?: number; initial?: CommissionForm }>({ open: false });
  const [feeModal, setFeeModal] = useState<{ open: boolean; id?: number; initial?: ServiceFeeForm }>({ open: false });
  const [txModal, setTxModal] = useState<{
    open: boolean; type: "collection" | "agent_payment" | "sub_agent_payment";
    commissionId?: number; commissionLabel?: string; universityName?: string;
  }>({ open: false, type: "collection" });
  const [uniCollModal, setUniCollModal] = useState(false);
  const [agentPayModal, setAgentPayModal] = useState(false);
  const [staffPayModal, setStaffPayModal] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [commSelected, setCommSelected] = useState<Set<number>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [feeSelected, setFeeSelected] = useState<Set<number>>(new Set());
  const [feeBulkDeleting, setFeeBulkDeleting] = useState(false);
  const [uniSelected, setUniSelected] = useState<Set<string>>(new Set());
  const [uniBulkDeleting, setUniBulkDeleting] = useState(false);
  const [commSort, setCommSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "", dir: "asc" });
  const [commExporting, setCommExporting] = useState(false);
  const [uniExporting, setUniExporting] = useState(false);
  const [feeExporting, setFeeExporting] = useState(false);
  const [uniSort, setUniSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "", dir: "asc" });
  const [uniFilter, setUniFilter] = useState("");
  const [feeSort, setFeeSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "", dir: "asc" });
  const [feeUniFilter, setFeeUniFilter] = useState("");
  const [feeStatusFilter, setFeeStatusFilter] = useState("all");
  const commPg = useTablePagination(25);
  const feePg = useTablePagination(25);

  const commParams = { season, ...(commSearch ? { search: commSearch } : {}), ...(commStatus !== "all" ? { status: commStatus } : {}), ...(commAgentId !== "all" ? { agentId: commAgentId } : {}), ...(commStaffId !== "all" ? { staffUserId: commStaffId } : {}), limit: 200 } as any;
  const feeParams  = { season, ...(feeAgentId !== "all" ? { agentId: feeAgentId } : {}), ...(feeStaffId !== "all" ? { staffUserId: feeStaffId } : {}), limit: 200 } as any;

  const { data: commResp, isLoading: commLoading, refetch: refetchComm } = useListCommissions(
    commParams,
    { query: { queryKey: ["commissions", season, commSearch, commStatus, commAgentId, commStaffId] } }
  );
  const { data: feeResp, isLoading: feeLoading, refetch: refetchFees } = useListServiceFees(
    feeParams,
    { query: { queryKey: ["service-fees", season, feeAgentId, feeStaffId] } }
  );

  const { data: filterAgentsResp } = useQuery({
    queryKey: ["agents-list-filter"],
    queryFn: () => customFetch<any>(`${BASE}/api/agents?limit=500`),
    staleTime: 5 * 60 * 1000,
  });
  const filterAgents: any[] = Array.isArray(filterAgentsResp) ? filterAgentsResp : ((filterAgentsResp as any)?.data || []);

  const { data: filterStaffResp } = useQuery({
    queryKey: ["staff-users-filter"],
    queryFn: () => customFetch<any>(`${BASE}/api/users?roles=staff%2Cconsultant%2Ceditor%2Caccountant%2Cmanager%2Cadmin&limit=200`),
    staleTime: 5 * 60 * 1000,
  });
  const filterStaff: any[] = (filterStaffResp as any)?.data || (Array.isArray(filterStaffResp) ? filterStaffResp : []);
  const { data: summaryData } = useGetFinanceSummary(
    { season } as any,
    { query: { queryKey: ["finance-summary", season] } }
  );

  const { data: uniBreakdownData } = useQuery({
    queryKey: ["university-breakdown", season],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/university-breakdown?season=${season}`),
  });

  const { data: staffBonusGlobal } = useQuery({
    queryKey: ["staff-bonus-global", season],
    queryFn: () => customFetch<any>(`${BASE}/api/finance/staff-bonuses?season=${encodeURIComponent(season)}`),
  });

  const allCommissions: any[] = (commResp as any)?.data || [];
  const commSummary: any = (commResp as any)?.summary || {};
  const allFees: any[] = (feeResp as any)?.data || [];
  const feeSummary: any = (feeResp as any)?.summary || {};
  const summary: any = summaryData || {};

  const commissions: any[] = currency === "all"
    ? allCommissions
    : allCommissions.filter((c: any) => (c.currency || "USD").toUpperCase() === currency);
  const fees: any[] = currency === "all"
    ? allFees
    : allFees.filter((f: any) => (f.currency || "USD").toUpperCase() === currency);

  const commByCur: Record<string, any> = commSummary?.byCurrency || {};
  const feeByCur: Record<string, any> = feeSummary?.byCurrency || {};
  const activeCurrencies: CurrencyCode[] = currency === "all"
    ? (() => {
        const set = new Set<string>();
        Object.keys(commByCur).forEach(c => set.add(c));
        Object.keys(feeByCur).forEach(c => set.add(c));
        const arr = [...set].filter(c => (SUPPORTED_CURRENCIES as readonly string[]).includes(c)) as CurrencyCode[];
        return arr.length > 0 ? arr : ["USD"];
      })()
    : [currency as CurrencyCode];

  function commRowsFor(field: string, computeFn?: (b: any) => number): { label: string; value: string }[] {
    return activeCurrencies.map(c => {
      const b = commByCur[c] || {};
      const v = computeFn ? computeFn(b) : toNum(b[field]);
      return { label: c, value: fmt(v, c) };
    });
  }
  function feeRowsFor(field: string): { label: string; value: string }[] {
    return activeCurrencies.map(c => {
      const b = feeByCur[c] || {};
      return { label: c, value: fmt(toNum(b[field]), c) };
    });
  }
  const uniBreakdown: any[] = uniBreakdownData?.breakdown || [];
  const uniTotals: any = uniBreakdownData?.totals || {};

  const sortedCommissions = useMemo(() => {
    let rows: any[] = commissions;
    if (!commSort.key) return rows;
    const dir = commSort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (commSort.key) {
        case "student": return dir * ((a.studentName || "").localeCompare(b.studentName || ""));
        case "agent": return dir * ((a.agentName || "").localeCompare(b.agentName || ""));
        case "staff": return dir * ((a.staffName || "").localeCompare(b.staffName || ""));
        case "progFee": return dir * (toNum(a.programFee) - toNum(b.programFee));
        case "univComm": return dir * (toNum(a.universityCommissionAmount) - toNum(b.universityCommissionAmount));
        case "agentComm": return dir * (toNum(a.agentCommissionAmount) - toNum(b.agentCommissionAmount));
        case "saComm": return dir * (toNum(a.subAgentCommissionAmount) - toNum(b.subAgentCommissionAmount));
        case "staffComm": return dir * (toNum(a.staffCommissionAmount) - toNum(b.staffCommissionAmount));
        case "netIncome": {
          const netA = toNum(a.universityCommissionAmount) - toNum(a.agentCommissionAmount) - toNum(a.subAgentCommissionAmount) - toNum(a.staffCommissionAmount);
          const netB = toNum(b.universityCommissionAmount) - toNum(b.agentCommissionAmount) - toNum(b.subAgentCommissionAmount) - toNum(b.staffCommissionAmount);
          return dir * (netA - netB);
        }
        case "collection": return dir * (toNum(a.universityCollected) - toNum(b.universityCollected));
        case "status": return dir * ((a.status || "").localeCompare(b.status || ""));
        default: return 0;
      }
    });
  }, [commissions, commSort]);
  const { paged: pagedCommissions, total: totalCommissions } = commPg.paginate(sortedCommissions);

  const sortedUniBreakdown = useMemo(() => {
    let rows = uniFilter
      ? uniBreakdown.filter((u: any) => (u.universityName || "").toLowerCase().includes(uniFilter.toLowerCase()))
      : uniBreakdown;
    if (!uniSort.key) return rows;
    const dir = uniSort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (uniSort.key) {
        case "universityName": return dir * ((a.universityName || "").localeCompare(b.universityName || ""));
        case "totalCommission": return dir * (toNum(a.totalCommission) - toNum(b.totalCommission));
        case "totalCollected": return dir * (toNum(a.totalCollected) - toNum(b.totalCollected));
        case "totalRemaining": return dir * (toNum(a.totalRemaining) - toNum(b.totalRemaining));
        case "totalAgentPaid": return dir * (toNum(a.totalAgentPaid) - toNum(b.totalAgentPaid));
        case "netIncome": return dir * (toNum(a.netIncome) - toNum(b.netIncome));
        case "studentCount": return dir * (toNum(a.studentCount) - toNum(b.studentCount));
        default: return 0;
      }
    });
  }, [uniBreakdown, uniSort, uniFilter]);

  const sortedFilteredFees = useMemo(() => {
    let rows = fees;
    if (feeUniFilter) rows = rows.filter((f: any) => (f.universityName || "").toLowerCase().includes(feeUniFilter.toLowerCase()));
    if (feeStatusFilter !== "all") rows = rows.filter((f: any) => f.status === feeStatusFilter);
    if (!feeSort.key) return rows;
    const dir = feeSort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (feeSort.key) {
        case "studentName": return dir * ((a.studentName || "").localeCompare(b.studentName || ""));
        case "universityName": return dir * ((a.universityName || "").localeCompare(b.universityName || ""));
        case "totalAmount": return dir * (toNum(a.totalAmount) - toNum(b.totalAmount));
        case "status": return dir * ((a.status || "").localeCompare(b.status || ""));
        default: return 0;
      }
    });
  }, [fees, feeSort, feeUniFilter, feeStatusFilter]);

  const { paged: pagedFees, total: totalFees } = feePg.paginate(sortedFilteredFees);

  async function deleteCommission(id: number) {
    setDeleting(id);
    try {
      await customFetch(`${BASE}/api/commissions/${id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: t("financePage.commissionDeleted") });
    } catch { toast({ title: t("financePage.errorDeleting"), variant: "destructive" }); }
    finally { setDeleting(null); }
  }

  async function deleteServiceFee(id: number) {
    setDeleting(id);
    try {
      await customFetch(`${BASE}/api/service-fees/${id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["service-fees"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      toast({ title: t("financePage.serviceFeeDeleted") });
    } catch { toast({ title: t("financePage.errorDeleting"), variant: "destructive" }); }
    finally { setDeleting(null); }
  }

  function toggleCommSelect(id: number) {
    setCommSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleCommSelectAll(ids: number[]) {
    const allIn = ids.length > 0 && ids.every(id => commSelected.has(id));
    setCommSelected(allIn ? new Set() : new Set(ids));
  }

  async function bulkDeleteCommissions() {
    const ids = Array.from(commSelected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected commission${ids.length > 1 ? "s" : ""}?`)) return;
    setBulkDeleting(true);
    try {
      await fetch(`${BASE}/api/commissions/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      setCommSelected(new Set());
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: `${ids.length} commission${ids.length > 1 ? "s" : ""} deleted` });
    } catch { toast({ title: t("financePage.errorDeletingCommissions"), variant: "destructive" }); }
    finally { setBulkDeleting(false); }
  }

  function toggleFeeSelect(id: number) {
    setFeeSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }
  function toggleFeeSelectAll(ids: number[]) {
    const allIn = ids.length > 0 && ids.every(id => feeSelected.has(id));
    setFeeSelected(allIn ? new Set() : new Set(ids));
  }
  async function bulkDeleteServiceFees() {
    const ids = Array.from(feeSelected);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected service fee${ids.length > 1 ? "s" : ""}?`)) return;
    setFeeBulkDeleting(true);
    try {
      await fetch(`${BASE}/api/service-fees/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ids }),
      });
      setFeeSelected(new Set());
      qc.invalidateQueries({ queryKey: ["service-fees"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      toast({ title: `${ids.length} service fee${ids.length > 1 ? "s" : ""} deleted` });
    } catch { toast({ title: t("financePage.errorDeleting"), variant: "destructive" }); }
    finally { setFeeBulkDeleting(false); }
  }

  function toggleUniSelect(name: string) {
    setUniSelected(prev => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  }
  function toggleUniSelectAll(names: string[]) {
    const allIn = names.length > 0 && names.every(n => uniSelected.has(n));
    setUniSelected(allIn ? new Set() : new Set(names));
  }
  async function bulkDeleteUniversities() {
    const names = Array.from(uniSelected);
    if (names.length === 0) return;
    if (!confirm(`Delete all commissions for ${names.length} selected universit${names.length > 1 ? "ies" : "y"}?`)) return;
    setUniBulkDeleting(true);
    try {
      await fetch(`${BASE}/api/commissions/bulk-delete-by-university`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ universityNames: names }),
      });
      setUniSelected(new Set());
      qc.invalidateQueries({ queryKey: ["commissions"] });
      qc.invalidateQueries({ queryKey: ["finance-summary"] });
      qc.invalidateQueries({ queryKey: ["university-breakdown"] });
      toast({ title: `${names.length} universit${names.length > 1 ? "ies" : "y"}'s commissions deleted` });
    } catch { toast({ title: t("financePage.errorDeleting"), variant: "destructive" }); }
    finally { setUniBulkDeleting(false); }
  }

  function handleCommSort(key: string) {
    setCommSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function handleUniSort(key: string) {
    setUniSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  function handleFeeSort(key: string) {
    setFeeSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  }

  async function markInstallment(fee: any, installment: 1 | 2) {
    const today = new Date().toISOString().split("T")[0];
    const body = installment === 1
      ? { firstInstallmentPaidAt: today }
      : { secondInstallmentPaidAt: today };
    try {
      await customFetch(`${BASE}/api/service-fees/${fee.id}`, { method: "PATCH", body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ["service-fees"] });
      toast({ title: `Installment ${installment} marked as paid` });
    } catch { toast({ title: t("financePage.errorGeneric"), variant: "destructive" }); }
  }

  const overdueCommissions = useMemo(() => {
    return commissions.filter(c => {
      if (c.status === "potential") return false;
      const uAmt = toNum(c.universityCommissionAmount);
      const uColl = toNum(c.universityCollected);
      if (uColl >= uAmt) return false;
      if (!c.confirmedAt) return false;
      const daysSince = (Date.now() - new Date(c.confirmedAt).getTime()) / (1000 * 60 * 60 * 24);
      return daysSince > 90;
    });
  }, [commissions]);

  const agingSummary = useMemo(() => {
    const bins = { current: 0, days30: 0, days60: 0, days90plus: 0 };
    commissions.forEach(c => {
      if (c.status === "potential") return;
      const remaining = toNum(c.universityCommissionAmount) - toNum(c.universityCollected);
      if (remaining <= 0) return;
      if (!c.confirmedAt) { bins.current += remaining; return; }
      const days = (Date.now() - new Date(c.confirmedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (days <= 30) bins.current += remaining;
      else if (days <= 60) bins.days30 += remaining;
      else if (days <= 90) bins.days60 += remaining;
      else bins.days90plus += remaining;
    });
    return bins;
  }, [commissions]);

  const cs = summary?.commissions || {};
  const collectionRate = pct(
    toNum(cs?.totalUniversityCollected || 0),
    toNum(cs?.totalUniversityCommission || 0)
  );

  const offSummary = summary?.offset || {};

  return (
    <>
      <div className="space-y-6 p-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{t("staffFinance.title")}</h1>
            <p className="text-slate-500 text-sm mt-0.5">{t("staffFinance.subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <CurrencySelector value={currency} onChange={setCurrency} />
            <div className="text-sm text-muted-foreground font-medium bg-primary/8 border border-primary/20 px-3 py-1.5 rounded-lg">
              Season: <span className="font-bold text-primary">{season}</span>
            </div>
            <Button variant="outline" size="icon" onClick={() => { refetchComm(); refetchFees(); }}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <FinanceStatCard
            icon={Clock}
            label={t("financePage.statusPotential") + " · " + t("financePage.univCommission")}
            borderColor="border-t-amber-400"
            color="text-amber-600"
            rows={commRowsFor("potentialUniversityCommission")}
          />
          <FinanceStatCard
            icon={CheckCircle}
            label={t("financePage.statusConfirmed") + " · " + t("financePage.univCommission")}
            borderColor="border-t-blue-500"
            color="text-blue-600"
            rows={commRowsFor("confirmedUniversityCommission")}
          />
          <FinanceStatCard
            icon={CreditCard}
            label={t("financePage.agentPayouts")}
            borderColor="border-t-emerald-500"
            color="text-emerald-600"
            rows={commRowsFor("paidToAgents")}
          />
          <FinanceStatCard
            icon={AlertCircle}
            label={t("financePage.remaining")}
            borderColor="border-t-rose-400"
            color="text-rose-600"
            rows={commRowsFor("pendingToCollect")}
          />
          <FinanceStatCard
            icon={DollarSign}
            label={t("financePage.totalAmount")}
            borderColor="border-t-indigo-500"
            color="text-indigo-600"
            rows={feeRowsFor("totalServiceFees")}
          />
          {(toNum(staffBonusGlobal?.totalPaid) > 0 || toNum(staffBonusGlobal?.totalPending) > 0) && (
            <FinanceStatCard
              icon={DollarSign}
              label={t("financePage.staff")}
              borderColor="border-t-violet-400"
              color="text-violet-600"
              rows={[
                { label: t("financePage.statusPaid"), value: fmt(toNum(staffBonusGlobal?.totalPaid)) },
                { label: t("financePage.statusPending"), value: fmt(toNum(staffBonusGlobal?.totalPending)) },
              ]}
            />
          )}
          {Object.values(commByCur).some(b => toNum((b as any).totalStaffCommission) > 0) && (
            <FinanceStatCard
              icon={Users}
              label={t("financePage.staffPayoutsCard")}
              borderColor="border-t-violet-500"
              color="text-violet-700"
              rows={[
                ...commRowsFor("totalStaffPayouts"),
                ...activeCurrencies
                  .filter(c => toNum((commByCur[c] || {}).staffPayable) > 0)
                  .map(c => ({
                    label: `${c} (${t("financePage.remaining")})`,
                    value: fmt(toNum((commByCur[c] || {}).staffPayable), c),
                  })),
              ]}
            />
          )}
        </div>

        {offSummary.availableForOffset > 0 && (
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-4 flex items-start gap-3 dark:bg-violet-900/20 dark:border-violet-700/40">
            <ArrowUpRight className="w-5 h-5 text-violet-600 mt-0.5 shrink-0 dark:text-violet-400" />
            <div>
              <p className="font-semibold text-violet-800 text-sm dark:text-violet-200">Article 6 Commission Offset Available</p>
              <p className="text-violet-600 text-sm mt-0.5 dark:text-violet-400">
                Up to <strong>{fmt(offSummary.availableForOffset)}</strong> of confirmed commissions can offset service fees
                for state universities ({offSummary.maxOffsetRate}% max).
                Already used: {fmt(offSummary.totalOffsetUsed)}.
              </p>
            </div>
          </div>
        )}

        {overdueCommissions.length > 0 && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 flex items-start gap-3 dark:bg-rose-900/20 dark:border-rose-700/40">
            <AlertTriangle className="w-5 h-5 text-rose-600 mt-0.5 shrink-0 dark:text-rose-400" />
            <div>
              <p className="font-semibold text-rose-800 text-sm dark:text-rose-200">
                {overdueCommissions.length} Overdue Collection{overdueCommissions.length > 1 ? "s" : ""} (90+ days)
              </p>
              <p className="text-rose-600 text-sm mt-0.5 dark:text-rose-400">
                Total overdue: <strong>{fmt(overdueCommissions.reduce((s, c) => s + toNum(c.universityCommissionAmount) - toNum(c.universityCollected), 0))}</strong>
                {" "} — {overdueCommissions.map(c => c.universityName).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ")}
              </p>
            </div>
          </div>
        )}

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="commissions">
              Commissions
              <Badge className="ml-2 bg-slate-200 text-slate-600 text-xs">{commissions.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="universities">
              University Breakdown
              <Badge className="ml-2 bg-slate-200 text-slate-600 text-xs">{uniBreakdown.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="fees">
              Service Fees
              <Badge className="ml-2 bg-slate-200 text-slate-600 text-xs">{fees.length}</Badge>
            </TabsTrigger>
            <TabsTrigger value="analytics">
              Analytics
            </TabsTrigger>
          </TabsList>

          {/* COMMISSIONS TAB */}
          <TabsContent value="commissions" className="mt-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder={t("financePage.searchStudentOrUniversity")}
                className="w-64"
                value={commSearch}
                onChange={e => setCommSearch(e.target.value)}
              />
              <Select value={commStatus} onValueChange={setCommStatus}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("financePage.allStatuses")}</SelectItem>
                  {Object.entries(COMM_STATUS).map(([v, { label }]) =>
                    <SelectItem key={v} value={v}>{t(`financePage.${label}`)}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={commAgentId} onValueChange={setCommAgentId}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t("financePage.agentFilter")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("financePage.agentFilter")}</SelectItem>
                  {filterAgents.map((a: any) => <SelectItem key={a.id} value={String(a.id)}>{a.name || `Agent #${a.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={commStaffId} onValueChange={setCommStaffId}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t("financePage.staffFilter")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("financePage.staffFilter")}</SelectItem>
                  {filterStaff.map((u: any) => <SelectItem key={u.id} value={String(u.id)}>{[u.firstName, u.lastName].filter(Boolean).join(" ") || `User #${u.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={commExporting}
                  onClick={async () => {
                    setCommExporting(true);
                    try {
                      const params = new URLSearchParams({ season });
                      if (commSearch) params.set("search", commSearch);
                      if (commStatus !== "all") params.set("status", commStatus);
                      if (currency && currency !== "all") params.set("currency", currency);
                      await downloadExcel(
                        `${BASE}/api/finance/export/commissions?${params}`,
                        `commissions_${season}_${new Date().toISOString().slice(0, 10)}.xlsx`
                      );
                    } catch { toast({ title: t("financePage.exportExcel"), description: "Export failed", variant: "destructive" }); }
                    finally { setCommExporting(false); }
                  }}
                >
                  {commExporting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Download className="w-4 h-4 mr-1" />}
                  {t("financePage.exportExcel")}
                </Button>
                <Button variant="outline" onClick={() => setUniCollModal(true)}>
                  <Landmark className="w-4 h-4 mr-1" /> {t("financePage.recordCollection")}
                </Button>
                <Button variant="outline" onClick={() => setAgentPayModal(true)}>
                  <CreditCard className="w-4 h-4 mr-1" /> {t("financePage.recordAgentPayment")}
                </Button>
                <Button variant="outline" onClick={() => setStaffPayModal(true)}>
                  <Users className="w-4 h-4 mr-1" /> {t("financePage.recordStaffCommission")}
                </Button>
                <Button onClick={() => setCommModal({ open: true })}>
                  <Plus className="w-4 h-4 mr-1" /> New Commission
                </Button>
              </div>
            </div>

            {commSelected.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-3 bg-destructive/5 border border-destructive/20 rounded-xl">
                <span className="text-sm font-medium text-foreground">
                  {commSelected.size} commission{commSelected.size > 1 ? "s" : ""} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={bulkDeleteCommissions}
                  disabled={bulkDeleting}
                  className="ml-auto"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  {bulkDeleting ? "Deleting..." : `Delete Selected (${commSelected.size})`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setCommSelected(new Set())}>
                  Clear Selection
                </Button>
              </div>
            )}

            {commLoading ? (
              <div className="text-center py-12 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading...
              </div>
            ) : commissions.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <DollarSign className="w-10 h-10 mx-auto mb-2 opacity-30" />
                No commission records for {season}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-3 w-[40px]">
                        <Checkbox
                          checked={pagedCommissions.length > 0 && pagedCommissions.every((c: any) => commSelected.has(c.id)) ? true : pagedCommissions.some((c: any) => commSelected.has(c.id)) ? ("indeterminate" as any) : false}
                          onCheckedChange={() => toggleCommSelectAll(pagedCommissions.map((c: any) => c.id))}
                          aria-label="Select all"
                        />
                      </th>
                      {([
                        { key: "student", label: t("financePage.studentUniversity"), align: "text-left" },
                        { key: "agent", label: t("financePage.agent"), align: "text-left" },
                        { key: "staff", label: t("financePage.staff"), align: "text-left" },
                        { key: "progFee", label: t("financePage.progFee"), align: "text-right" },
                        { key: "univComm", label: t("financePage.univCommission"), align: "text-right" },
                        { key: "agentComm", label: t("financePage.agentCommission"), align: "text-right" },
                        { key: "saComm", label: t("financePage.saCommission"), align: "text-right" },
                        { key: "staffComm", label: t("financePage.staffCommission"), align: "text-right" },
                        { key: "netIncome", label: t("financePage.netIncome"), align: "text-right" },
                        { key: "collection", label: t("financePage.collection"), align: "text-center" },
                        { key: "status", label: t("financePage.statusLabel"), align: "text-center" },
                      ] as const).map(col => {
                        const active = commSort.key === col.key;
                        const isStatus = col.key === "status";
                        const isAgent = col.key === "agent";
                        const isStaff = col.key === "staff";
                        const statusFilterActive = commStatus !== "all";
                        const agentFilterActive = commAgentId !== "all";
                        const staffFilterActive = commStaffId !== "all";
                        return (
                          <th
                            key={col.key}
                            className={`${col.align} px-4 py-3 font-semibold text-slate-600 select-none hover:bg-slate-100 transition-colors`}
                          >
                            <div className={`flex items-center gap-1 ${col.align === "text-right" ? "justify-end" : col.align === "text-center" ? "justify-center" : ""}`}>
                              <span className="cursor-pointer" onClick={() => handleCommSort(col.key)}>
                                {col.label}
                              </span>
                              <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => handleCommSort(col.key)}>
                                {active ? (commSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3" />}
                              </button>
                              {isAgent && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={agentFilterActive ? t("financePage.filterActive") : t("financePage.agentFilter")}
                                      className={`relative inline-flex items-center justify-center transition-colors ${agentFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${agentFilterActive ? "fill-primary/20" : ""}`} />
                                      {agentFilterActive && (
                                        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.agent")}</Label>
                                        {agentFilterActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setCommAgentId("all")}>
                                            <X className="w-3 h-3 mr-1" />{t("financePage.clear")}
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={commAgentId} onValueChange={setCommAgentId}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.agentFilter")}</SelectItem>
                                          {filterAgents.map((a: any) => (
                                            <SelectItem key={a.id} value={String(a.id)}>{a.name || `Agent #${a.id}`}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                              {isStaff && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={staffFilterActive ? t("financePage.filterActive") : t("financePage.staffFilter")}
                                      className={`relative inline-flex items-center justify-center transition-colors ${staffFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${staffFilterActive ? "fill-primary/20" : ""}`} />
                                      {staffFilterActive && (
                                        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.staff")}</Label>
                                        {staffFilterActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setCommStaffId("all")}>
                                            <X className="w-3 h-3 mr-1" />{t("financePage.clear")}
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={commStaffId} onValueChange={setCommStaffId}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.staffFilter")}</SelectItem>
                                          {filterStaff.map((u: any) => (
                                            <SelectItem key={u.id} value={String(u.id)}>
                                              {[u.firstName, u.lastName].filter(Boolean).join(" ") || `User #${u.id}`}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                              {isStatus && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={statusFilterActive ? t("financePage.filterActive") : t("financePage.statusLabel")}
                                      className={`relative inline-flex items-center justify-center transition-colors ${statusFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${statusFilterActive ? "fill-primary/20" : ""}`} />
                                      {statusFilterActive && (
                                        <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
                                      )}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="end" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.statusLabel")}</Label>
                                        {statusFilterActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setCommStatus("all")}>
                                            <X className="w-3 h-3 mr-1" />{t("financePage.clear")}
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={commStatus} onValueChange={setCommStatus}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.allStatuses")}</SelectItem>
                                          {Object.entries(COMM_STATUS).map(([v, m]) => (
                                            <SelectItem key={v} value={v}>{t(`financePage.${m.label}`)}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                            </div>
                          </th>
                        );
                      })}
                      <th className="text-right px-4 py-3 font-semibold text-slate-600">{t("financePage.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pagedCommissions.map((c: any) => {
                      const uAmt = toNum(c.universityCommissionAmount);
                      const aAmt = toNum(c.agentCommissionAmount);
                      const saAmt = toNum(c.subAgentCommissionAmount);
                      const stAmt = toNum(c.staffCommissionAmount);
                      const net  = uAmt - aAmt - saAmt - stAmt;
                      const uCollected = toNum(c.universityCollected);
                      const aPaid = toNum(c.agentPaid);
                      const uRemaining = uAmt - uCollected;
                      const status = COMM_STATUS[c.status] || COMM_STATUS.potential;
                      return (
                        <tr key={c.id} className={`hover:bg-slate-50 transition-colors ${commSelected.has(c.id) ? "bg-blue-50/50" : ""}`}>
                          <td className="px-3 py-3">
                            <Checkbox
                              checked={commSelected.has(c.id)}
                              onCheckedChange={() => toggleCommSelect(c.id)}
                              aria-label={`Select ${c.studentName}`}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">{c.studentName || "—"}</div>
                            <div className="text-xs text-slate-500">{c.universityName || "—"} · {c.programName || "—"}</div>
                            {c.isStateUniversity && (
                              <Badge className="text-xs mt-0.5 bg-violet-100 text-violet-700 border-violet-200">{t("financePage.state")}</Badge>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-sm text-slate-700">{c.agentName || "—"}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-sm text-slate-700">{c.staffName || "—"}</div>
                          </td>
                          <td className="px-4 py-3 text-right text-slate-700 tabular-nums">
                            {c.programFee ? fmt(c.programFee, c.currency) : "—"}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            <div className="font-medium text-blue-700">{fmt(uAmt, c.currency)}</div>
                            <div className="text-xs text-slate-400">{c.universityCommissionRate || "—"}%</div>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            <div className="font-medium text-amber-700">{fmt(aAmt, c.currency)}</div>
                            <div className="text-xs text-slate-400">{c.agentCommissionRate || "—"}% · {fmt(aPaid, c.currency)} paid</div>
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {toNum(c.subAgentCommissionAmount) > 0 ? (
                              <>
                                <div className="font-medium text-purple-700">{fmt(c.subAgentCommissionAmount, c.currency)}</div>
                                <div className="text-xs text-slate-400">{c.subAgentCommissionRate || "—"}% · {fmt(c.subAgentPaid, c.currency)} paid</div>
                              </>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            {stAmt > 0 ? (
                              <div className="font-medium text-rose-700">{fmt(stAmt, c.staffCommissionCurrency || c.currency)}</div>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right tabular-nums">
                            <div className="font-semibold text-emerald-700">{fmt(net, c.currency)}</div>
                            {c.offsetAmount && toNum(c.offsetAmount) > 0 && (
                              <div className="text-xs text-violet-600">Offset: {fmt(c.offsetAmount, c.currency)}</div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="w-24 mx-auto">
                              <div className="flex justify-between text-xs text-slate-500 mb-0.5">
                                <span>{fmt(uCollected, c.currency)}</span>
                                <span>{pct(uCollected, uAmt)}%</span>
                              </div>
                              <ProgressBar value={uCollected} max={uAmt} color={uCollected >= uAmt ? "bg-green-500" : "bg-blue-500"} />
                              {uRemaining > 0 && (
                                <div className="text-xs text-slate-400 mt-0.5 text-center">{fmt(uRemaining, c.currency)} left</div>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-center">
                            <Badge className={`text-xs border ${status.color}`}>{t(`financePage.${status.label}`)}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {c.status !== "potential" && uCollected < uAmt && (
                                <Button
                                  size="sm" variant="outline"
                                  className="text-xs h-7"
                                  onClick={() => setTxModal({
                                    open: true, type: "collection",
                                    commissionId: c.id,
                                    commissionLabel: `${c.studentName || "—"} — ${c.universityName || "—"}`,
                                    universityName: c.universityName,
                                  })}
                                >
                                  <Landmark className="w-3 h-3 mr-1" /> Collect
                                </Button>
                              )}
                              {c.status !== "potential" && aPaid < aAmt && (
                                <Button
                                  size="sm" variant="outline"
                                  className="text-xs h-7"
                                  onClick={() => setTxModal({
                                    open: true, type: "agent_payment",
                                    commissionId: c.id,
                                    commissionLabel: `${c.studentName || "—"} — ${c.universityName || "—"}`,
                                    universityName: c.universityName,
                                  })}
                                >
                                  <CreditCard className="w-3 h-3 mr-1" /> Pay Agent
                                </Button>
                              )}
                              {c.status !== "potential" && toNum(c.subAgentCommissionAmount) > 0 && toNum(c.subAgentPaid) < toNum(c.subAgentCommissionAmount) && (
                                <Button
                                  size="sm" variant="outline"
                                  className="text-xs h-7"
                                  onClick={() => setTxModal({
                                    open: true, type: "sub_agent_payment",
                                    commissionId: c.id,
                                    commissionLabel: `${c.studentName || "—"} — ${c.universityName || "—"}`,
                                    universityName: c.universityName,
                                  })}
                                >
                                  <CreditCard className="w-3 h-3 mr-1" /> Pay Sub Agent
                                </Button>
                              )}
                              <TransactionHistory commissionId={c.id} />
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setCommModal({
                                  open: true, id: c.id,
                                  initial: {
                                    studentName: c.studentName || "",
                                    universityName: c.universityName || "",
                                    programName: c.programName || "",
                                    season: c.season,
                                    currency: c.currency,
                                    isStateUniversity: !!c.isStateUniversity,
                                    programFee: c.programFee || "",
                                    universityCommissionRate: c.universityCommissionRate || "20",
                                    agentCommissionRate: c.agentCommissionRate || "70",
                                    agentId: c.agentId ? String(c.agentId) : "",
                                    subAgentCommissionRate: c.subAgentCommissionRate || "",
                                    subAgentId: c.subAgentId ? String(c.subAgentId) : "",
                                    status: c.status,
                                    universityCollected: c.universityCollected || "0",
                                    agentPaid: c.agentPaid || "0",
                                    subAgentPaid: c.subAgentPaid || "0",
                                    offsetAmount: c.offsetAmount || "0",
                                    notes: c.notes || "",
                                    studentId: c.studentId ? String(c.studentId) : "",
                                    applicationId: c.applicationId ? String(c.applicationId) : "",
                                    staffUserId: c.staffUserId ? String(c.staffUserId) : "",
                                    staffCommissionAmount: c.staffCommissionAmount || "",
                                    staffCommissionCurrency: c.staffCommissionCurrency || c.currency || "USD",
                                  },
                                })}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => deleteCommission(c.id)}
                                disabled={deleting === c.id}
                              >
                                {deleting === c.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                    <tr>
                      <td className="px-3 py-3" />
                      <td className="px-4 py-3 text-slate-600">Totals ({totalCommissions})</td>
                      <td className="px-4 py-3 text-right text-slate-600 tabular-nums">
                        {fmt(commissions.reduce((s: number, c: any) => s + toNum(c.programFee), 0))}
                      </td>
                      <td className="px-4 py-3 text-right text-blue-700 tabular-nums">
                        {fmt(commSummary.totalUniversityCommission || 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-amber-700 tabular-nums">
                        {fmt(commSummary.totalAgentCommission || 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-purple-700 tabular-nums">
                        {fmt(commSummary.totalSubAgentCommission || 0)}
                      </td>
                      <td className="px-4 py-3 text-right text-emerald-700 tabular-nums">
                        {fmt(commSummary.totalNetAgency || 0)}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
                <TablePagination
                  currentPage={commPg.page}
                  totalItems={totalCommissions}
                  pageSize={commPg.pageSize}
                  onPageChange={commPg.setPage}
                  onPageSizeChange={commPg.setPageSize}
                />
              </div>
            )}
          </TabsContent>

          {/* UNIVERSITY BREAKDOWN TAB */}
          <TabsContent value="universities" className="mt-4 space-y-4">
            <div className="flex items-center justify-end">
              <Button
                variant="outline"
                size="sm"
                disabled={uniExporting}
                onClick={async () => {
                  setUniExporting(true);
                  try {
                    const params = new URLSearchParams({ season });
                    if (currency && currency !== "all") params.set("currency", currency);
                    await downloadExcel(
                      `${BASE}/api/finance/export/university-breakdown?${params}`,
                      `university_breakdown_${season}_${new Date().toISOString().slice(0, 10)}.xlsx`
                    );
                  } catch { toast({ title: t("financePage.exportExcel"), description: "Export failed", variant: "destructive" }); }
                  finally { setUniExporting(false); }
                }}
              >
                {uniExporting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Download className="w-4 h-4 mr-1" />}
                {t("financePage.exportExcel")}
              </Button>
            </div>
            {uniSelected.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-3 bg-destructive/5 border border-destructive/20 rounded-xl">
                <span className="text-sm font-medium text-foreground">
                  {uniSelected.size} universit{uniSelected.size > 1 ? "ies" : "y"} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={bulkDeleteUniversities}
                  disabled={uniBulkDeleting}
                  className="ml-auto"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  {uniBulkDeleting ? "Deleting..." : `Delete All Commissions (${uniSelected.size})`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setUniSelected(new Set())}>
                  Clear Selection
                </Button>
              </div>
            )}
            {uniBreakdown.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <Building2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
                No university data for {season}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Card className="bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-700/40">
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-blue-600 font-medium uppercase dark:text-blue-400">{t("financePage.totalReceivable")}</p>
                      <p className="text-xl font-bold text-blue-700 dark:text-blue-300">{fmt(uniTotals.totalCommission)}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-700/40">
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-green-600 font-medium uppercase dark:text-green-400">{t("financePage.totalCollected")}</p>
                      <p className="text-xl font-bold text-green-700 dark:text-green-300">{fmt(uniTotals.totalCollected)}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-700/40">
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-amber-600 font-medium uppercase dark:text-amber-400">{t("financePage.agentPayouts")}</p>
                      <p className="text-xl font-bold text-amber-700 dark:text-amber-300">{fmt(uniTotals.totalAgentPaid)}</p>
                    </CardContent>
                  </Card>
                  <Card className="bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-700/40">
                    <CardContent className="p-4 text-center">
                      <p className="text-xs text-emerald-600 font-medium uppercase dark:text-emerald-400">{t("financePage.netIncome")}</p>
                      <p className="text-xl font-bold text-emerald-700 dark:text-emerald-300">{fmt(uniTotals.totalNetIncome)}</p>
                    </CardContent>
                  </Card>
                </div>
                <div className="rounded-xl border border-slate-200 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 border-b border-slate-200">
                      <tr>
                        <th className="px-3 py-3 w-[40px]">
                          <Checkbox
                            checked={sortedUniBreakdown.length > 0 && sortedUniBreakdown.every((u: any) => uniSelected.has(u.universityName)) ? true : sortedUniBreakdown.some((u: any) => uniSelected.has(u.universityName)) ? ("indeterminate" as any) : false}
                            onCheckedChange={() => toggleUniSelectAll(sortedUniBreakdown.map((u: any) => u.universityName))}
                            aria-label="Select all"
                          />
                        </th>
                        {([
                          { key: "universityName", label: t("financePage.university"), align: "text-left", hasFilter: true },
                          { key: "totalCommission", label: t("financePage.totalCommission"), align: "text-right" },
                          { key: "totalCollected", label: t("financePage.collected"), align: "text-right" },
                          { key: "totalRemaining", label: t("financePage.remaining"), align: "text-right" },
                          { key: "totalAgentPaid", label: t("financePage.agentPayout"), align: "text-right" },
                          { key: "totalStaffPaid", label: t("financePage.staff"), align: "text-right" },
                          { key: "netIncome", label: t("financePage.netIncome"), align: "text-right" },
                          { key: "", label: t("financePage.collectionPct"), align: "text-center", noSort: true },
                          { key: "studentCount", label: t("financePage.students"), align: "text-center" },
                        ] as const).map((col: any) => {
                          const active = uniSort.key === col.key && !col.noSort;
                          const isUni = col.hasFilter;
                          const uniFilterActive = uniFilter.trim().length > 0;
                          return (
                            <th
                              key={col.key || col.label}
                              className={`${col.align} px-4 py-3 font-semibold text-slate-600 select-none ${!col.noSort ? "hover:bg-slate-100" : ""} transition-colors`}
                            >
                              <div className={`flex items-center gap-1 ${col.align === "text-right" ? "justify-end" : col.align === "text-center" ? "justify-center" : ""}`}>
                                <span className={!col.noSort ? "cursor-pointer" : ""} onClick={() => !col.noSort && handleUniSort(col.key)}>
                                  {col.label}
                                </span>
                                {!col.noSort && (
                                  <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => handleUniSort(col.key)}>
                                    {active ? (uniSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3" />}
                                  </button>
                                )}
                                {isUni && (
                                  <Popover>
                                    <PopoverTrigger asChild>
                                      <button
                                        type="button"
                                        title={uniFilterActive ? "Filter active — click to edit" : "Filter by university"}
                                        className={`relative inline-flex items-center justify-center transition-colors ${uniFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                      >
                                        <FilterIcon className={`w-3 h-3 ${uniFilterActive ? "fill-primary/20" : ""}`} />
                                        {uniFilterActive && (
                                          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
                                        )}
                                      </button>
                                    </PopoverTrigger>
                                    <PopoverContent align="start" className="w-56 p-3">
                                      <div className="space-y-2">
                                        <div className="flex items-center justify-between">
                                          <Label className="text-xs font-semibold">{t("financePage.university")}</Label>
                                          {uniFilterActive && (
                                            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setUniFilter("")}>
                                              <X className="w-3 h-3 mr-1" /> Clear
                                            </Button>
                                          )}
                                        </div>
                                        <Input
                                          className="h-8 text-sm"
                                          placeholder="Search university..."
                                          value={uniFilter}
                                          onChange={e => setUniFilter(e.target.value)}
                                          autoFocus
                                        />
                                      </div>
                                    </PopoverContent>
                                  </Popover>
                                )}
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {sortedUniBreakdown.map((u: any) => {
                        const collPct = pct(u.totalCollected, u.totalCommission);
                        const isOverdue = u.oldestUnpaid && ((Date.now() - new Date(u.oldestUnpaid).getTime()) / (1000 * 60 * 60 * 24) > 90);
                        return (
                          <tr key={u.universityName} className={`hover:bg-slate-50 transition-colors ${uniSelected.has(u.universityName) ? "bg-blue-50/50" : ""}`}>
                            <td className="px-3 py-3">
                              <Checkbox
                                checked={uniSelected.has(u.universityName)}
                                onCheckedChange={() => toggleUniSelect(u.universityName)}
                                aria-label={`Select ${u.universityName}`}
                              />
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-800 flex items-center gap-2">
                                <Building2 className="w-4 h-4 text-slate-400" />
                                {u.universityName}
                                {isOverdue && (
                                  <Badge className="text-xs bg-rose-100 text-rose-700 border-rose-200">{t("financePage.overdue")}</Badge>
                                )}
                              </div>
                              <div className="text-xs text-slate-400 mt-0.5">{u.commissionCount} commission{u.commissionCount !== 1 ? "s" : ""}</div>
                            </td>
                            <td className="px-4 py-3 text-right font-medium text-blue-700 tabular-nums">
                              {fmt(u.totalCommission)}
                            </td>
                            <td className="px-4 py-3 text-right text-green-700 tabular-nums">
                              {fmt(u.totalCollected)}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              <span className={u.totalRemaining > 0 ? "text-rose-600 font-medium" : "text-slate-400"}>
                                {fmt(u.totalRemaining)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-right text-amber-700 tabular-nums">
                              <div>{fmt(u.totalAgentPaid)}</div>
                              {u.totalAgentRemaining > 0 && (
                                <div className="text-xs text-slate-400">{fmt(u.totalAgentRemaining)} unpaid</div>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right text-violet-700 tabular-nums">
                              {u.totalStaffPaid > 0 ? fmt(u.totalStaffPaid) : <span className="text-slate-300">—</span>}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-emerald-700 tabular-nums">
                              {fmt(u.netIncome)}
                            </td>
                            <td className="px-4 py-3">
                              <div className="w-20 mx-auto">
                                <div className="text-xs text-center text-slate-500 mb-0.5">{collPct}%</div>
                                <ProgressBar
                                  value={u.totalCollected}
                                  max={u.totalCommission}
                                  color={collPct >= 100 ? "bg-green-500" : collPct >= 50 ? "bg-blue-500" : "bg-amber-500"}
                                />
                              </div>
                            </td>
                            <td className="px-4 py-3 text-center text-slate-600">{u.studentCount}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                      <tr>
                        <td className="px-3 py-3" />
                        <td className="px-4 py-3 text-slate-600">{sortedUniBreakdown.length} Universities{uniFilter ? ` (filtered from ${uniBreakdown.length})` : ""}</td>
                        <td className="px-4 py-3 text-right text-blue-700 tabular-nums">{fmt(uniTotals.totalCommission)}</td>
                        <td className="px-4 py-3 text-right text-green-700 tabular-nums">{fmt(uniTotals.totalCollected)}</td>
                        <td className="px-4 py-3 text-right text-rose-600 tabular-nums">{fmt(uniTotals.totalRemaining)}</td>
                        <td className="px-4 py-3 text-right text-amber-700 tabular-nums">{fmt(uniTotals.totalAgentPaid)}</td>
                        <td className="px-4 py-3 text-right text-violet-700 tabular-nums">{fmt(uniTotals.totalStaffPaid || 0)}</td>
                        <td className="px-4 py-3 text-right text-emerald-700 tabular-nums">{fmt(uniTotals.totalNetIncome)}</td>
                        <td className="px-4 py-3 text-center text-slate-600">
                          {pct(uniTotals.totalCollected, uniTotals.totalCommission)}%
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </>
            )}
          </TabsContent>

          {/* SERVICE FEES TAB */}
          <TabsContent value="fees" className="mt-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="text-sm text-slate-500">
                {feeSummary.potentialCount ?? 0} potential · {feeSummary.confirmedCount ?? 0} confirmed · {feeSummary.pendingCount ?? 0} pending · {feeSummary.partialCount ?? 0} partial · {feeSummary.paidCount ?? 0} paid
              </div>
              {(feeSummary.potentialTotal > 0 || feeSummary.confirmedTotal > 0) && (
                <div className="text-sm text-slate-500">
                  | Potential: {fmt(feeSummary.potentialTotal)} · Confirmed: {fmt(feeSummary.confirmedTotal)}
                </div>
              )}
              <Select value={feeAgentId} onValueChange={setFeeAgentId}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t("financePage.agentFilter")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("financePage.agentFilter")}</SelectItem>
                  {filterAgents.map((a: any) => <SelectItem key={a.id} value={String(a.id)}>{a.name || `Agent #${a.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={feeStaffId} onValueChange={setFeeStaffId}>
                <SelectTrigger className="w-44"><SelectValue placeholder={t("financePage.staffFilter")} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("financePage.staffFilter")}</SelectItem>
                  {filterStaff.map((u: any) => <SelectItem key={u.id} value={String(u.id)}>{[u.firstName, u.lastName].filter(Boolean).join(" ") || `User #${u.id}`}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={feeExporting}
                  onClick={async () => {
                    setFeeExporting(true);
                    try {
                      const params = new URLSearchParams({ season });
                      if (currency && currency !== "all") params.set("currency", currency);
                      await downloadExcel(
                        `${BASE}/api/finance/export/service-fees?${params}`,
                        `service_fees_${season}_${new Date().toISOString().slice(0, 10)}.xlsx`
                      );
                    } catch { toast({ title: t("financePage.exportExcel"), description: "Export failed", variant: "destructive" }); }
                    finally { setFeeExporting(false); }
                  }}
                >
                  {feeExporting ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Download className="w-4 h-4 mr-1" />}
                  {t("financePage.exportExcel")}
                </Button>
                <Button onClick={() => setFeeModal({ open: true })}>
                  <Plus className="w-4 h-4 mr-1" /> New Service Fee
                </Button>
              </div>
            </div>

            {feeSelected.size > 0 && (
              <div className="flex items-center gap-3 px-4 py-3 bg-destructive/5 border border-destructive/20 rounded-xl">
                <span className="text-sm font-medium text-foreground">
                  {feeSelected.size} service fee{feeSelected.size > 1 ? "s" : ""} selected
                </span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={bulkDeleteServiceFees}
                  disabled={feeBulkDeleting}
                  className="ml-auto"
                >
                  <Trash2 className="w-4 h-4 mr-1.5" />
                  {feeBulkDeleting ? "Deleting..." : `Delete Selected (${feeSelected.size})`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setFeeSelected(new Set())}>
                  Clear Selection
                </Button>
              </div>
            )}

            {feeLoading ? (
              <div className="text-center py-12 text-slate-400">
                <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" />Loading...
              </div>
            ) : fees.length === 0 ? (
              <div className="text-center py-12 text-slate-400">
                <DollarSign className="w-10 h-10 mx-auto mb-2 opacity-30" />
                No service fees for {season}
              </div>
            ) : (
              <div className="rounded-xl border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-3 w-[40px]">
                        <Checkbox
                          checked={pagedFees.length > 0 && pagedFees.every((f: any) => feeSelected.has(f.id)) ? true : pagedFees.some((f: any) => feeSelected.has(f.id)) ? ("indeterminate" as any) : false}
                          onCheckedChange={() => toggleFeeSelectAll(pagedFees.map((f: any) => f.id))}
                          aria-label="Select all"
                        />
                      </th>
                      {([
                        { key: "studentName", label: t("financePage.student"), align: "text-left" },
                        { key: "universityName", label: t("financePage.university"), align: "text-left", hasUniFilter: true },
                        { key: "agentName", label: t("financePage.agentFilter"), align: "text-left", noSort: true, hasAgentFilter: true },
                        { key: "staffName", label: t("financePage.staffFilter"), align: "text-left", noSort: true, hasStaffFilter: true },
                        { key: "", label: t("financePage.payer"), align: "text-left", noSort: true },
                        { key: "totalAmount", label: t("financePage.total"), align: "text-right" },
                        { key: "", label: "1st Installment (50%)", align: "text-center", noSort: true },
                        { key: "", label: "2nd Installment (50%)", align: "text-center", noSort: true },
                        { key: "status", label: t("financePage.statusLabel"), align: "text-center", hasStatusFilter: true },
                      ] as const).map((col: any) => {
                        const active = feeSort.key === col.key && !col.noSort && col.key !== "";
                        const feeUniActive = feeUniFilter.trim().length > 0;
                        const feeStatusActive = feeStatusFilter !== "all";
                        const feeAgentFilterActive = feeAgentId !== "all";
                        const feeStaffFilterActive = feeStaffId !== "all";
                        return (
                          <th
                            key={col.key || col.label}
                            className={`${col.align} px-4 py-3 font-semibold text-slate-600 select-none ${!col.noSort && col.key ? "hover:bg-slate-100" : ""} transition-colors`}
                          >
                            <div className={`flex items-center gap-1 ${col.align === "text-right" ? "justify-end" : col.align === "text-center" ? "justify-center" : ""}`}>
                              <span className={!col.noSort && col.key ? "cursor-pointer" : ""} onClick={() => !col.noSort && col.key && handleFeeSort(col.key)}>
                                {col.label}
                              </span>
                              {!col.noSort && col.key && (
                                <button type="button" className="text-slate-400 hover:text-slate-700" onClick={() => handleFeeSort(col.key)}>
                                  {active ? (feeSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3" />}
                                </button>
                              )}
                              {col.hasUniFilter && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={feeUniActive ? "Filter active — click to edit" : "Filter by university"}
                                      className={`relative inline-flex items-center justify-center transition-colors ${feeUniActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${feeUniActive ? "fill-primary/20" : ""}`} />
                                      {feeUniActive && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.university")}</Label>
                                        {feeUniActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFeeUniFilter("")}>
                                            <X className="w-3 h-3 mr-1" /> Clear
                                          </Button>
                                        )}
                                      </div>
                                      <Input
                                        className="h-8 text-sm"
                                        placeholder="Search university..."
                                        value={feeUniFilter}
                                        onChange={e => setFeeUniFilter(e.target.value)}
                                        autoFocus
                                      />
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                              {col.hasStatusFilter && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={feeStatusActive ? "Filter active — click to edit" : "Filter by status"}
                                      className={`relative inline-flex items-center justify-center transition-colors ${feeStatusActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${feeStatusActive ? "fill-primary/20" : ""}`} />
                                      {feeStatusActive && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="end" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.statusLabel")}</Label>
                                        {feeStatusActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFeeStatusFilter("all")}>
                                            <X className="w-3 h-3 mr-1" /> Clear
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={feeStatusFilter} onValueChange={setFeeStatusFilter}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.allStatuses")}</SelectItem>
                                          {Object.entries(FEE_STATUS).map(([v, m]) => (
                                            <SelectItem key={v} value={v}>{t(`financePage.${m.label}`)}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                              {col.hasAgentFilter && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={feeAgentFilterActive ? t("financePage.filterActive") : t("financePage.agentFilter")}
                                      className={`relative inline-flex items-center justify-center transition-colors ${feeAgentFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${feeAgentFilterActive ? "fill-primary/20" : ""}`} />
                                      {feeAgentFilterActive && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.agent")}</Label>
                                        {feeAgentFilterActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFeeAgentId("all")}>
                                            <X className="w-3 h-3 mr-1" />{t("financePage.clear")}
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={feeAgentId} onValueChange={setFeeAgentId}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.agentFilter")}</SelectItem>
                                          {filterAgents.map((a: any) => (
                                            <SelectItem key={a.id} value={String(a.id)}>{a.name || `Agent #${a.id}`}</SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                              {col.hasStaffFilter && (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      title={feeStaffFilterActive ? t("financePage.filterActive") : t("financePage.staffFilter")}
                                      className={`relative inline-flex items-center justify-center transition-colors ${feeStaffFilterActive ? "text-primary" : "text-slate-400 hover:text-slate-700"}`}
                                    >
                                      <FilterIcon className={`w-3 h-3 ${feeStaffFilterActive ? "fill-primary/20" : ""}`} />
                                      {feeStaffFilterActive && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />}
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-56 p-3">
                                    <div className="space-y-2">
                                      <div className="flex items-center justify-between">
                                        <Label className="text-xs font-semibold">{t("financePage.staffFilter")}</Label>
                                        {feeStaffFilterActive && (
                                          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => setFeeStaffId("all")}>
                                            <X className="w-3 h-3 mr-1" />{t("financePage.clear")}
                                          </Button>
                                        )}
                                      </div>
                                      <Select value={feeStaffId} onValueChange={setFeeStaffId}>
                                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                                        <SelectContent>
                                          <SelectItem value="all">{t("financePage.staffFilter")}</SelectItem>
                                          {filterStaff.map((u: any) => (
                                            <SelectItem key={u.id} value={String(u.id)}>
                                              {[u.firstName, u.lastName].filter(Boolean).join(" ") || `User #${u.id}`}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              )}
                            </div>
                          </th>
                        );
                      })}
                      <th className="text-right px-4 py-3 font-semibold text-slate-600">{t("financePage.actions")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pagedFees.map((f: any) => {
                      const status = FEE_STATUS[f.status] || FEE_STATUS.pending;
                      const half = toNum(f.totalAmount) / 2;
                      return (
                        <tr key={f.id} className={`hover:bg-slate-50 transition-colors ${feeSelected.has(f.id) ? "bg-blue-50/50" : ""}`}>
                          <td className="px-3 py-3">
                            <Checkbox
                              checked={feeSelected.has(f.id)}
                              onCheckedChange={() => toggleFeeSelect(f.id)}
                              aria-label={`Select ${f.studentName}`}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-800">{f.studentName || "—"}</div>
                            {f.isStateUniversity && (
                              <Badge className="text-xs mt-0.5 bg-violet-100 text-violet-700 border-violet-200">{t("financePage.state")}</Badge>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-600 text-sm">{f.universityName || "—"}</td>
                          <td className="px-4 py-3 text-slate-600 text-sm">{f.agentName || "—"}</td>
                          <td className="px-4 py-3 text-slate-600 text-sm">{f.staffName || "—"}</td>
                          <td className="px-4 py-3 text-slate-600 capitalize">{f.payerType}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-800">
                            {fmt(f.totalAmount, f.currency)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {f.firstInstallmentPaidAt ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <CheckCircle className="w-4 h-4 text-green-600" />
                                <span className="text-xs text-slate-400">{f.firstInstallmentPaidAt}</span>
                              </div>
                            ) : (
                              <Button
                                size="sm" variant="outline"
                                className="text-xs h-7 text-amber-700 border-amber-300 hover:bg-amber-50"
                                onClick={() => markInstallment(f, 1)}
                              >
                                {fmt(half, f.currency)} — {t("financePage.markPaid")}
                              </Button>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            {f.secondInstallmentPaidAt ? (
                              <div className="flex flex-col items-center gap-0.5">
                                <CheckCircle className="w-4 h-4 text-green-600" />
                                <span className="text-xs text-slate-400">{f.secondInstallmentPaidAt}</span>
                              </div>
                            ) : (
                              <Button
                                size="sm" variant="outline"
                                className="text-xs h-7 text-amber-700 border-amber-300 hover:bg-amber-50"
                                onClick={() => markInstallment(f, 2)}
                                disabled={!f.firstInstallmentPaidAt}
                              >
                                {fmt(half, f.currency)} — {t("financePage.markPaid")}
                              </Button>
                            )}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex flex-col items-center gap-1">
                              {(() => {
                                const fs = FEE_FINANCE_STATUS[f.financeStatus] || FEE_FINANCE_STATUS.potential;
                                return <Badge className={`text-xs border ${fs.color}`}>{t(`financePage.${fs.label}`)}</Badge>;
                              })()}
                              <Badge className={`text-xs border ${status.color}`}>{t(`financePage.${status.label}`)}</Badge>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7"
                                onClick={() => setFeeModal({
                                  open: true, id: f.id,
                                  initial: {
                                    studentName: f.studentName || "",
                                    universityName: f.universityName || "",
                                    isStateUniversity: !!f.isStateUniversity,
                                    payerType: f.payerType,
                                    season: f.season,
                                    currency: f.currency,
                                    totalAmount: f.totalAmount || "",
                                    firstInstallmentPaidAt: f.firstInstallmentPaidAt || "",
                                    secondInstallmentPaidAt: f.secondInstallmentPaidAt || "",
                                    notes: f.notes || "",
                                  },
                                })}
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="icon" variant="ghost"
                                className="h-7 w-7 text-rose-500 hover:text-rose-700 hover:bg-rose-50"
                                onClick={() => deleteServiceFee(f.id)}
                                disabled={deleting === f.id}
                              >
                                {deleting === f.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-slate-50 border-t-2 border-slate-200 font-semibold">
                    <tr>
                      <td className="px-3 py-3" />
                      <td colSpan={3} className="px-4 py-3 text-slate-600">Totals ({sortedFilteredFees.length}{sortedFilteredFees.length !== fees.length ? ` of ${fees.length}` : ""})</td>
                      <td className="px-4 py-3 text-right text-slate-800 tabular-nums">
                        {fmt(feeSummary.totalServiceFees || 0)}
                      </td>
                      <td colSpan={4} className="px-4 py-3 text-right text-emerald-700 tabular-nums">
                        Collected: {fmt(feeSummary.totalCollected || 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <TablePagination
                  currentPage={feePg.page}
                  totalItems={totalFees}
                  pageSize={feePg.pageSize}
                  onPageChange={feePg.setPage}
                  onPageSizeChange={feePg.setPageSize}
                />
              </div>
            )}
          </TabsContent>

          {/* ANALYTICS TAB */}
          <TabsContent value="analytics" className="mt-4 space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-blue-600" /> Receivables Aging
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {[
                      { label: t("financePage.currentDays"), value: agingSummary.current, color: "bg-green-500" },
                      { label: "31-60 days", value: agingSummary.days30, color: "bg-amber-500" },
                      { label: "61-90 days", value: agingSummary.days60, color: "bg-orange-500" },
                      { label: "90+ days (Overdue)", value: agingSummary.days90plus, color: "bg-rose-500" },
                    ].map(bin => {
                      const total = agingSummary.current + agingSummary.days30 + agingSummary.days60 + agingSummary.days90plus;
                      return (
                        <div key={bin.label}>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-slate-600">{bin.label}</span>
                            <span className="font-semibold text-slate-800">{fmt(bin.value)}</span>
                          </div>
                          <ProgressBar value={bin.value} max={total || 1} color={bin.color} />
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t border-slate-100 flex justify-between text-sm font-semibold">
                      <span className="text-slate-600">{t("financePage.totalReceivable")}</span>
                      <span className="text-slate-800">
                        {fmt(agingSummary.current + agingSummary.days30 + agingSummary.days60 + agingSummary.days90plus)}
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <PiggyBank className="w-4 h-4 text-emerald-600" /> {t("financePage.cashFlowSummary")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-center">
                        <p className="text-xs text-blue-600 font-medium uppercase">{t("financePage.inflowCollected")}</p>
                        <p className="text-lg font-bold text-blue-700">
                          {fmt(summary?.commissions?.totalUniversityCollected || 0)}
                        </p>
                      </div>
                      <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-center">
                        <p className="text-xs text-amber-600 font-medium uppercase">{t("financePage.outflowAgentPaid")}</p>
                        <p className="text-lg font-bold text-amber-700">
                          {fmt(summary?.commissions?.totalAgentPaid || 0)}
                        </p>
                      </div>
                      {toNum(summary?.commissions?.totalSubAgentCommission) > 0 && (
                        <div className="rounded-lg bg-purple-50 border border-purple-200 p-3 text-center">
                          <p className="text-xs text-purple-600 font-medium uppercase">{t("financePage.subAgentPaid")}</p>
                          <p className="text-lg font-bold text-purple-700">
                            {fmt(summary?.commissions?.totalSubAgentPaid || 0)}
                          </p>
                        </div>
                      )}
                      {toNum(summary?.commissions?.totalStaffPayouts) > 0 && (
                        <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-center">
                          <p className="text-xs text-rose-600 font-medium uppercase">{t("financePage.staffCommPaid")}</p>
                          <p className="text-lg font-bold text-rose-700">
                            {fmt(summary?.commissions?.totalStaffPayouts || 0)}
                          </p>
                        </div>
                      )}
                      {toNum(staffBonusGlobal?.totalPaid) > 0 && (
                        <div className="rounded-lg bg-violet-50 border border-violet-200 p-3 text-center">
                          <p className="text-xs text-violet-600 font-medium uppercase">{t("financePage.staffBonusPaid")}</p>
                          <p className="text-lg font-bold text-violet-700">
                            {fmt(staffBonusGlobal.totalPaid)}
                          </p>
                        </div>
                      )}
                    </div>
                    <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-center">
                      <p className="text-xs text-emerald-600 font-medium uppercase">{t("financePage.netCashPosition")}</p>
                      <p className="text-2xl font-bold text-emerald-700">
                        {fmt(
                          (toNum(summary?.commissions?.totalUniversityCollected) + toNum(summary?.serviceFees?.collected))
                          - toNum(summary?.commissions?.totalAgentPaid)
                          - toNum(summary?.commissions?.totalSubAgentPaid)
                          - toNum(summary?.commissions?.totalStaffPayouts)
                          - toNum(staffBonusGlobal?.totalPaid)
                        )}
                      </p>
                      <p className="text-xs text-emerald-500 mt-1">{t("financePage.includesServiceFee")}</p>
                    </div>

                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">{t("financePage.expectedUnconfirmed")}</span>
                        <span className="text-slate-700">{fmt(summary?.commissions?.totalUniversityCommission ? (toNum(summary.commissions.totalUniversityCommission) - toNum(summary.commissions.totalUniversityCollected)) : 0)}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">{t("financePage.agentPayable")}</span>
                        <span className="text-slate-700">{fmt(summary?.commissions?.totalAgentPending || 0)}</span>
                      </div>
                      {toNum(summary?.commissions?.totalSubAgentCommission) > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">{t("financePage.subAgentPayable")}</span>
                          <span className="text-purple-700">{fmt(toNum(summary?.commissions?.totalSubAgentCommission) - toNum(summary?.commissions?.totalSubAgentPaid))}</span>
                        </div>
                      )}
                      {toNum(summary?.commissions?.staffPayable) > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">{t("financePage.staffPayoutsCard")}</span>
                          <span className="text-rose-700">{fmt(summary?.commissions?.staffPayable)}</span>
                        </div>
                      )}
                      {toNum(staffBonusGlobal?.totalPending) > 0 && (
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">{t("financePage.staffBonusPayable")}</span>
                          <span className="text-violet-700">{fmt(staffBonusGlobal.totalPending)}</span>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">{t("financePage.serviceFeePending")}</span>
                        <span className="text-slate-700">{fmt(toNum(summary?.serviceFees?.total) - toNum(summary?.serviceFees?.collected))}</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="w-4 h-4 text-indigo-600" /> {t("financePage.topUniversitiesByCommission")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {uniBreakdown.length === 0 ? (
                    <p className="text-sm text-slate-400 text-center py-4">{t("financePage.noDataShort")}</p>
                  ) : (
                    <div className="space-y-3">
                      {uniBreakdown.slice(0, 5).map((u: any, i: number) => (
                        <div key={u.universityName}>
                          <div className="flex justify-between text-sm mb-1">
                            <span className="text-slate-600 truncate mr-2">{i + 1}. {u.universityName}</span>
                            <span className="font-semibold text-slate-800 shrink-0">{fmt(u.totalCommission)}</span>
                          </div>
                          <ProgressBar value={u.totalCommission} max={uniBreakdown[0]?.totalCommission || 1} color="bg-indigo-500" />
                          <div className="flex justify-between text-xs text-slate-400 mt-0.5">
                            <span>{t("financePage.studentsCount", { count: u.commissionCount })}</span>
                            <span>{t("financePage.netLabel", { value: fmt(u.netIncome) })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-violet-600" /> Commission Status Breakdown
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {Object.entries(COMM_STATUS).map(([key, { label, color }]) => {
                      const count = commissions.filter(c => c.status === key).length;
                      const amount = commissions.filter(c => c.status === key).reduce((s, c) => s + toNum(c.universityCommissionAmount), 0);
                      return (
                        <div key={key} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Badge className={`text-xs border ${color}`}>{t(`financePage.${label}`)}</Badge>
                            <span className="text-sm text-slate-500">{count}</span>
                          </div>
                          <span className="font-semibold text-sm text-slate-800 tabular-nums">{fmt(amount)}</span>
                        </div>
                      );
                    })}
                    <div className="pt-2 border-t border-slate-100 flex justify-between text-sm font-semibold">
                      <span className="text-slate-600">{t("financePage.total")}</span>
                      <span className="text-slate-800">{fmt(commissions.reduce((s: number, c: any) => s + toNum(c.universityCommissionAmount), 0))}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {commModal.open && (
        <CommissionModal
          open={commModal.open}
          onClose={() => setCommModal({ open: false })}
          initial={commModal.initial}
          editId={commModal.id}
        />
      )}
      {feeModal.open && (
        <ServiceFeeModal
          open={feeModal.open}
          onClose={() => setFeeModal({ open: false })}
          initial={feeModal.initial}
          editId={feeModal.id}
        />
      )}
      {txModal.open && (
        <TransactionModal
          open={txModal.open}
          onClose={() => setTxModal({ open: false, type: "collection" })}
          type={txModal.type}
          commissionId={txModal.commissionId}
          commissionLabel={txModal.commissionLabel}
          universityName={txModal.universityName}
        />
      )}
      <UniversityCollectionModal open={uniCollModal} onClose={() => setUniCollModal(false)} />
      <AgentPaymentModal open={agentPayModal} onClose={() => setAgentPayModal(false)} />
      <StaffCommissionModal open={staffPayModal} onClose={() => setStaffPayModal(false)} />
    </>
  );
}
