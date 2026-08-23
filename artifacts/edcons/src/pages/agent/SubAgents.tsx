import { useState, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { TablePagination } from "@/components/TablePagination";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Users,
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  KeyRound,
  UserCheck,
  UserX,
  Loader2,
  Mail,
  Phone,
  TrendingUp,
  Calendar,
  Upload,
  X,
  Building2,
  ChevronDown,
  Eye,
  EyeOff,
  LogIn,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { CountryFlag } from "@/components/CountryFlag";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { useI18n } from "@/hooks/use-i18n";

type SubAgent = {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  commissionRate: number | null;
  companyName: string | null;
  logoUrl: string | null;
  hideServiceFees: boolean;
  canManageStaff: boolean;
  academyAccess: boolean | null;
  status: string;
  createdAt: string;
};

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const PHONE_CODES = [
  { code: "+90", country: "TR" },
  { code: "+1", country: "US" },
  { code: "+44", country: "GB" },
  { code: "+49", country: "DE" },
  { code: "+33", country: "FR" },
  { code: "+39", country: "IT" },
  { code: "+34", country: "ES" },
  { code: "+31", country: "NL" },
  { code: "+46", country: "SE" },
  { code: "+47", country: "NO" },
  { code: "+45", country: "DK" },
  { code: "+41", country: "CH" },
  { code: "+43", country: "AT" },
  { code: "+48", country: "PL" },
  { code: "+7", country: "RU" },
  { code: "+380", country: "UA" },
  { code: "+86", country: "CN" },
  { code: "+81", country: "JP" },
  { code: "+82", country: "KR" },
  { code: "+91", country: "IN" },
  { code: "+92", country: "PK" },
  { code: "+93", country: "AF" },
  { code: "+966", country: "SA" },
  { code: "+971", country: "AE" },
  { code: "+964", country: "IQ" },
  { code: "+98", country: "IR" },
  { code: "+962", country: "JO" },
  { code: "+961", country: "LB" },
  { code: "+20", country: "EG" },
  { code: "+212", country: "MA" },
  { code: "+234", country: "NG" },
  { code: "+254", country: "KE" },
  { code: "+55", country: "BR" },
  { code: "+52", country: "MX" },
  { code: "+61", country: "AU" },
  { code: "+64", country: "NZ" },
  { code: "+60", country: "MY" },
  { code: "+65", country: "SG" },
  { code: "+66", country: "TH" },
  { code: "+84", country: "VN" },
  { code: "+62", country: "ID" },
  { code: "+63", country: "PH" },
  { code: "+880", country: "BD" },
  { code: "+94", country: "LK" },
  { code: "+977", country: "NP" },
  { code: "+251", country: "ET" },
  { code: "+255", country: "TZ" },
  { code: "+233", country: "GH" },
];

function parsePhoneCode(fullPhone: string): { phoneCode: string; phone: string } {
  if (!fullPhone) return { phoneCode: "+90", phone: "" };
  const sorted = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
  const matched = sorted.find(pc => fullPhone.startsWith(pc.code));
  if (matched) return { phoneCode: matched.code, phone: fullPhone.slice(matched.code.length) };
  const intlMatch = fullPhone.match(/^(\+\d{1,4})(.*)/);
  if (intlMatch) return { phoneCode: intlMatch[1], phone: intlMatch[2] };
  return { phoneCode: "+90", phone: fullPhone };
}

export default function AgentSubAgents() {
  const { t } = useI18n();
  const { user } = useAuth(true);
  const { toast } = useToast();
  const qc = useQueryClient();

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const limit = 10;

  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [selected, setSelected] = useState<SubAgent | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phoneCode: "+90", phone: "", commissionRate: "", password: "", companyName: "", logoUrl: "", hideServiceFees: false, canManageStaff: false,
  });
  const [pwForm, setPwForm] = useState({ password: "" });

  const { data, isLoading } = useQuery({
    queryKey: ["my-sub-agents", page, limit, search],
    enabled: !!user,
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set("search", search);
      return customFetch<{ data: SubAgent[]; meta: { total: number; page: number; limit: number; totalPages: number } }>(`/api/agents/me/sub-agents?${params}`);
    },
  });

  const subAgents = data?.data || [];
  const meta = data?.meta;

  function openCreate() {
    setForm({ firstName: "", lastName: "", email: "", phoneCode: "+90", phone: "", commissionRate: "", password: "", companyName: "", logoUrl: "", hideServiceFees: false, canManageStaff: false });
    setShowCreate(true);
  }

  function openEdit(sa: SubAgent) {
    setSelected(sa);
    const parsed = parsePhoneCode(sa.phone || "");
    setForm({
      firstName: sa.firstName,
      lastName: sa.lastName,
      email: sa.email || "",
      phoneCode: parsed.phoneCode,
      phone: parsed.phone,
      commissionRate: sa.commissionRate?.toString() || "",
      password: "",
      companyName: sa.companyName || "",
      logoUrl: sa.logoUrl || "",
      hideServiceFees: sa.hideServiceFees || false,
      canManageStaff: sa.canManageStaff || false,
    });
    setShowEdit(true);
  }

  function openDelete(sa: SubAgent) {
    setSelected(sa);
    setShowDelete(true);
  }

  function openPassword(sa: SubAgent) {
    setSelected(sa);
    setPwForm({ password: "" });
    setShowPassword(true);
  }

  async function handleCreate() {
    if (!form.firstName || !form.lastName) {
      toast({ title: t("subAgentsPage.error"), description: t("subAgentsPage.nameRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch("/api/agents/me/sub-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email || undefined,
          phone: form.phone ? `${form.phoneCode}${form.phone}` : undefined,
          commissionRate: form.commissionRate || undefined,
          password: form.password || undefined,
          companyName: form.companyName || undefined,
          logoUrl: form.logoUrl || undefined,
          hideServiceFees: form.hideServiceFees,
          canManageStaff: form.canManageStaff,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["my-sub-agents"] });
      setShowCreate(false);
      toast({ title: t("subAgentsPage.toastCreated"), description: t("subAgentsPage.toastCreatedDesc", { name: `${form.firstName} ${form.lastName}` }) });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!selected) return;
    setSaving(true);
    try {
      await customFetch(`/api/agents/me/sub-agents/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email || null,
          phone: form.phone ? `${form.phoneCode}${form.phone}` : null,
          commissionRate: form.commissionRate || null,
          companyName: form.companyName || null,
          logoUrl: form.logoUrl || null,
          hideServiceFees: form.hideServiceFees,
          canManageStaff: form.canManageStaff,
        }),
      });
      await qc.invalidateQueries({ queryKey: ["my-sub-agents"] });
      setShowEdit(false);
      toast({ title: t("subAgentsPage.toastUpdated") });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!selected) return;
    setSaving(true);
    try {
      await customFetch(`/api/agents/me/sub-agents/${selected.id}`, { method: "DELETE" });
      await qc.invalidateQueries({ queryKey: ["my-sub-agents"] });
      setShowDelete(false);
      toast({ title: t("subAgentsPage.toastDeleted") });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleSetPassword() {
    if (!selected) return;
    if (!pwForm.password || pwForm.password.length < 6) {
      toast({ title: t("subAgentsPage.error"), description: t("subAgentsPage.passwordTooShort"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch(`/api/agents/me/sub-agents/${selected.id}/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwForm.password }),
      });
      setShowPassword(false);
      toast({ title: t("subAgentsPage.toastPasswordUpdated"), description: t("subAgentsPage.toastPasswordUpdatedDesc", { name: `${selected.firstName} ${selected.lastName}` }) });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function handleLoginAs(sa: SubAgent) {
    if (!sa.email) {
      toast({ title: t("subAgentsPage.error"), description: t("subAgentsPage.noLoginAccount"), variant: "destructive" });
      return;
    }
    try {
      await customFetch(`/api/agents/me/sub-agents/${sa.id}/impersonate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      window.location.href = `${BASE_URL}/agent`;
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    }
  }

  async function handleToggleAcademy(sa: SubAgent) {
    const newAccess = !(sa.academyAccess === true);
    try {
      await customFetch(`/api/agents/${sa.id}/academy-access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ academyAccess: newAccess }),
      });
      await qc.invalidateQueries({ queryKey: ["my-sub-agents"] });
      toast({ title: t("subAgentsPage.academyAccessSaved") });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.academyAccessFailed"), description: err.message, variant: "destructive" });
    }
  }

  async function handleToggleStatus(sa: SubAgent) {
    const newStatus = sa.status === "active" ? "inactive" : "active";
    try {
      await customFetch(`/api/agents/me/sub-agents/${sa.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      await qc.invalidateQueries({ queryKey: ["my-sub-agents"] });
      toast({ title: newStatus === "active" ? t("subAgentsPage.toastActivated") : t("subAgentsPage.toastDeactivated") });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.error"), description: err.message, variant: "destructive" });
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  }

  const [uploading, setUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  async function handleLogoUpload(file: File) {
    setUploading(true);
    try {
      const urlRes = await customFetch<{ uploadURL: string; objectPath: string }>(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!(urlRes as any).uploadURL || !(urlRes as any).objectPath) throw new Error("Failed to get upload URL");
      const putRes = await fetch((urlRes as any).uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = (urlRes as any).objectPath.replace(/^\/objects/, "");
      setForm(f => ({ ...f, logoUrl: `${BASE_URL}/api/storage/objects${strippedPath}` }));
      toast({ title: t("subAgentsPage.toastLogoUploaded") });
    } catch (err: any) {
      toast({ title: t("subAgentsPage.uploadFailed"), description: err.message, variant: "destructive" });
    } finally { setUploading(false); }
  }

  return (
    <>
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{t("agentSubAgents.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("agentSubAgents.subtitle")}</p>
          </div>
          <Button onClick={openCreate} className="gap-2">
            <Plus className="w-4 h-4" /> {t("subAgentsPage.addSubAgent")}
          </Button>
        </div>

        <Card className="border shadow-sm">
          <div className="p-4 border-b border-border/50">
            <form onSubmit={handleSearch} className="flex gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder={t("subAgentsPage.searchPlaceholder")}
                  className="pl-9 h-9"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" className="h-9">{t("common.search")}</Button>
              {search && (
                <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => { setSearch(""); setSearchInput(""); setPage(1); }}>
                  {t("subAgentsPage.clear")}
                </Button>
              )}
            </form>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : subAgents.length === 0 ? (
            <div className="text-center py-20">
              <Users className="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" />
              <p className="font-medium text-foreground">{t("subAgentsPage.emptyTitle")}</p>
              <p className="text-sm text-muted-foreground mt-1">{t("subAgentsPage.emptyDesc")}</p>
              <Button onClick={openCreate} variant="outline" className="mt-4 gap-2">
                <Plus className="w-4 h-4" /> {t("subAgentsPage.addSubAgent")}
              </Button>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50 bg-secondary/30">
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("common.name")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("common.email")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("common.phone")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("subAgentsPage.commission")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("common.status")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("subAgentsPage.academy")}</th>
                      <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t("subAgentsPage.createdCol")}</th>
                      <th className="text-right px-4 py-3 font-medium text-muted-foreground">{t("common.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subAgents.map(sa => (
                      <tr key={sa.id} className="border-b border-border/30 hover:bg-secondary/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center text-xs font-bold text-primary">
                              {sa.firstName?.[0]}{sa.lastName?.[0]}
                            </div>
                            <span className="font-medium text-foreground">{sa.firstName} {sa.lastName}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {sa.email ? (
                            <span className="flex items-center gap-1.5">
                              <Mail className="w-3.5 h-3.5" /> {sa.email}
                            </span>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          {sa.phone ? (
                            <span className="flex items-center gap-1.5">
                              <Phone className="w-3.5 h-3.5" /> {sa.phone}
                            </span>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          {sa.commissionRate != null ? (
                            <span className="flex items-center gap-1.5 text-foreground">
                              <TrendingUp className="w-3.5 h-3.5 text-green-500" /> {sa.commissionRate}%
                            </span>
                          ) : <span className="text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Badge className={sa.status === "active"
                            ? "bg-green-500/10 text-green-600 border-green-200 text-xs"
                            : "bg-red-500/10 text-red-500 border-red-200 text-xs"
                          }>
                            {sa.status === "active" ? t("common.active") : t("common.inactive")}
                          </Badge>
                        </td>
                        <td className="px-4 py-3">
                          <Switch
                            checked={sa.academyAccess === true}
                            onCheckedChange={() => handleToggleAcademy(sa)}
                          />
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          <span className="flex items-center gap-1.5">
                            <Calendar className="w-3 h-3" />
                            {new Date(sa.createdAt).toLocaleDateString()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              {sa.email && (
                                <DropdownMenuItem onClick={() => handleLoginAs(sa)}>
                                  <LogIn className="w-4 h-4 mr-2" /> {t("subAgentsPage.loginAs")}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => openEdit(sa)}>
                                <Edit className="w-4 h-4 mr-2" /> {t("subAgentsPage.editDetails")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => openPassword(sa)}>
                                <KeyRound className="w-4 h-4 mr-2" /> {t("subAgentsPage.setPassword")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleToggleStatus(sa)}>
                                {sa.status === "active" ? (
                                  <><UserX className="w-4 h-4 mr-2" /> {t("subAgentsPage.deactivate")}</>
                                ) : (
                                  <><UserCheck className="w-4 h-4 mr-2" /> {t("subAgentsPage.activate")}</>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => openDelete(sa)} className="text-destructive focus:text-destructive">
                                <Trash2 className="w-4 h-4 mr-2" /> {t("common.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {meta && meta.total > 0 && (
                <div className="p-4 border-t border-border/50">
                  <TablePagination
                    currentPage={meta.page}
                    totalItems={meta.total}
                    pageSize={meta.limit}
                    onPageChange={setPage}
                  />
                </div>
              )}
            </>
          )}
        </Card>

        {meta && (
          <p className="text-xs text-muted-foreground mt-3 text-center">
            {t("subAgentsPage.totalCount", { n: meta.total })}
          </p>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("subAgentsPage.addSubAgent")}</DialogTitle>
            <DialogDescription>{t("subAgentsPage.createDesc")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("subAgentsPage.firstNameRequired")}</Label>
                <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("subAgentsPage.lastNameRequired")}</Label>
                <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="h-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.companyName")}</Label>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder={t("subAgentsPage.companyNamePlaceholder")} className="h-9 pl-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("common.email")}</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder={t("subAgentsPage.emailPlaceholder")} className="h-9" />
              <p className="text-[11px] text-muted-foreground">{t("subAgentsPage.emailHelper")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.password")}</Label>
              <Input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder={t("subAgentsPage.passwordPlaceholder")} className="h-9" />
              <p className="text-[11px] text-muted-foreground">{t("subAgentsPage.passwordHelper")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("common.phone")}</Label>
              <div className="flex gap-2">
                <PhoneCodePicker value={form.phoneCode} onChange={v => setForm(f => ({ ...f, phoneCode: v }))} triggerClassName="min-w-[90px] w-auto h-9 shrink-0" />
                <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder={t("subAgentsPage.phonePlaceholder")} className="h-9 flex-1" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.commissionShare")}</Label>
              <Input type="number" step="0.1" min="0" max="100" value={form.commissionRate} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))} placeholder={t("subAgentsPage.commissionPlaceholder")} className="h-9" />
              <p className="text-[11px] text-muted-foreground">{t("subAgentsPage.commissionHelper")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.logo")}</Label>
              <div className="relative w-full h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                {form.logoUrl ? (
                  <>
                    <img src={form.logoUrl} alt="Sub Agent Logo" className="max-h-16 max-w-full object-contain" />
                    <button onClick={() => setForm(f => ({ ...f, logoUrl: "" }))} className="absolute top-2 right-2 w-6 h-6 rounded-full bg-destructive/90 text-white flex items-center justify-center hover:bg-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <button onClick={() => logoInputRef.current?.click()} disabled={uploading} className="flex flex-col items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors">
                    {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                    <span className="text-[10px] font-medium">{uploading ? t("subAgentsPage.uploading") : t("subAgentsPage.uploadLogo")}</span>
                  </button>
                )}
              </div>
              <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ""; }} />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-secondary/20">
              <div className="flex-1">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  {form.hideServiceFees ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                  {t("subAgentsPage.serviceFeeVisibility")}
                </Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {form.hideServiceFees ? t("subAgentsPage.feeHidden") : t("subAgentsPage.feeVisible")}
                </p>
              </div>
              <Switch checked={!form.hideServiceFees} onCheckedChange={(checked) => setForm(f => ({ ...f, hideServiceFees: !checked }))} />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t">
              <Button variant="outline" onClick={() => setShowCreate(false)} size="sm">{t("common.cancel")}</Button>
              <Button onClick={handleCreate} disabled={saving || !form.firstName || !form.lastName} size="sm" className="gap-2 px-5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                {t("common.create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("subAgentsPage.editSubAgent")}</DialogTitle>
            <DialogDescription>{t("subAgentsPage.editDesc", { name: `${selected?.firstName ?? ""} ${selected?.lastName ?? ""}` })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("subAgentsPage.firstNameRequired")}</Label>
                <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">{t("subAgentsPage.lastNameRequired")}</Label>
                <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="h-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.companyName")}</Label>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder={t("subAgentsPage.companyNamePlaceholder")} className="h-9 pl-9" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("common.email")}</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("common.phone")}</Label>
              <div className="flex gap-2">
                <PhoneCodePicker value={form.phoneCode} onChange={v => setForm(f => ({ ...f, phoneCode: v }))} triggerClassName="min-w-[90px] w-auto h-9 shrink-0" />
                <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder={t("subAgentsPage.phonePlaceholder")} className="h-9 flex-1" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.commissionShare")}</Label>
              <Input type="number" step="0.1" min="0" max="100" value={form.commissionRate} onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))} placeholder={t("subAgentsPage.commissionPlaceholder")} className="h-9" />
              <p className="text-[11px] text-muted-foreground">{t("subAgentsPage.commissionHelper")}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.logo")}</Label>
              <div className="relative w-full h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                {form.logoUrl ? (
                  <>
                    <img src={form.logoUrl} alt="Sub Agent Logo" className="max-h-16 max-w-full object-contain" />
                    <button onClick={() => setForm(f => ({ ...f, logoUrl: "" }))} className="absolute top-2 right-2 w-6 h-6 rounded-full bg-destructive/90 text-white flex items-center justify-center hover:bg-destructive">
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <button onClick={() => logoInputRef.current?.click()} disabled={uploading} className="flex flex-col items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors">
                    {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                    <span className="text-[10px] font-medium">{uploading ? t("subAgentsPage.uploading") : t("subAgentsPage.uploadLogo")}</span>
                  </button>
                )}
              </div>
              <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleLogoUpload(f); e.target.value = ""; }} />
            </div>
            <div className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-secondary/20">
              <div className="flex-1">
                <Label className="text-xs font-medium flex items-center gap-1.5">
                  {form.hideServiceFees ? <EyeOff className="w-3.5 h-3.5 text-muted-foreground" /> : <Eye className="w-3.5 h-3.5 text-green-500" />}
                  {t("subAgentsPage.serviceFeeVisibility")}
                </Label>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {form.hideServiceFees ? t("subAgentsPage.feeHidden") : t("subAgentsPage.feeVisible")}
                </p>
              </div>
              <Switch checked={!form.hideServiceFees} onCheckedChange={(checked) => setForm(f => ({ ...f, hideServiceFees: !checked }))} />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t">
              <Button variant="outline" onClick={() => setShowEdit(false)} size="sm">{t("common.cancel")}</Button>
              <Button onClick={handleEdit} disabled={saving || !form.firstName || !form.lastName} size="sm" className="gap-2 px-5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Edit className="w-3.5 h-3.5" />}
                {t("subAgentsPage.saveChanges")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Set Password Dialog */}
      <Dialog open={showPassword} onOpenChange={setShowPassword}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("subAgentsPage.setPassword")}</DialogTitle>
            <DialogDescription>{t("subAgentsPage.setPasswordDesc", { name: `${selected?.firstName ?? ""} ${selected?.lastName ?? ""}` })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t("subAgentsPage.newPassword")}</Label>
              <Input type="password" value={pwForm.password} onChange={e => setPwForm({ password: e.target.value })} placeholder={t("subAgentsPage.passwordPlaceholder")} className="h-9" />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t">
              <Button variant="outline" onClick={() => setShowPassword(false)} size="sm">{t("common.cancel")}</Button>
              <Button onClick={handleSetPassword} disabled={saving || pwForm.password.length < 6} size="sm" className="gap-2 px-5">
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                {t("subAgentsPage.setPassword")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("subAgentsPage.deleteSubAgent")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("subAgentsPage.deleteConfirm", { name: `${selected?.firstName ?? ""} ${selected?.lastName ?? ""}` })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={saving} className="bg-destructive hover:bg-destructive/90 gap-2">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
              {t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
