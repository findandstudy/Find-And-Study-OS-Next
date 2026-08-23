import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Checkbox } from "@/components/ui/checkbox";
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
  Eye,
  EyeOff,
  Shield,
} from "lucide-react";
import { PhoneInput } from "@/components/ui/phone-input";
import { useI18n } from "@/hooks/use-i18n";

type StaffMember = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  agentStaffPermissions: string[] | null;
  createdAt: string;
};

type PermissionOption = {
  key: string;
  labelKey: string;
  descKey: string;
  children?: PermissionOption[];
};

const PERMISSION_OPTIONS: PermissionOption[] = [
  { key: "leads", labelKey: "teamPage.permLeads", descKey: "teamPage.permLeadsDesc" },
  { key: "students", labelKey: "teamPage.permStudents", descKey: "teamPage.permStudentsDesc" },
  { key: "applications", labelKey: "teamPage.permApplications", descKey: "teamPage.permApplicationsDesc" },
  { key: "documents", labelKey: "teamPage.permDocuments", descKey: "teamPage.permDocumentsDesc" },
  {
    key: "course_finder",
    labelKey: "teamPage.permCourseFinder",
    descKey: "teamPage.permCourseFinderDesc",
    children: [
      { key: "view_commission_amount", labelKey: "teamPage.permViewCommissionAmount", descKey: "teamPage.permViewCommissionAmountDesc" },
      { key: "view_service_fee", labelKey: "teamPage.permViewServiceFee", descKey: "teamPage.permViewServiceFeeDesc" },
    ],
  },
  { key: "messages", labelKey: "teamPage.permMessages", descKey: "teamPage.permMessagesDesc" },
  { key: "commissions", labelKey: "teamPage.permCommissions", descKey: "teamPage.permCommissionsDesc" },
  { key: "academy", labelKey: "teamPage.permAcademy", descKey: "teamPage.permAcademyDesc" },
];

function allPermissionKeys(options: PermissionOption[]): string[] {
  return options.flatMap(p => [p.key, ...(p.children ? allPermissionKeys(p.children) : [])]);
}

export default function AgentTeam() {
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
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/agents/me/staff", page, search],
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (search) params.set("search", search);
      return customFetch<{ data: StaffMember[]; meta: any }>(`/api/agents/me/staff?${params}`);
    },
  });

  const staff = data?.data || [];
  const meta = data?.meta;

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{t("agentTeam.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("agentTeam.subtitle")}</p>
          </div>
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            {t("teamPage.addStaff")}
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
                  placeholder={t("teamPage.searchPlaceholder")}
                  className="pl-9 h-9"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" className="h-9">{t("common.search")}</Button>
            </form>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : staff.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Users className="w-12 h-12 text-muted-foreground/40 mb-4" />
              <h3 className="font-semibold text-foreground mb-1">{t("teamPage.noStaffYet")}</h3>
              <p className="text-muted-foreground text-sm mb-4">{t("teamPage.noStaffDesc")}</p>
              <Button onClick={() => setShowCreate(true)} size="sm" className="gap-2">
                <Plus className="w-4 h-4" /> {t("teamPage.addStaff")}
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50 bg-muted/30">
                    <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">{t("common.name")}</th>
                    <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">{t("teamPage.contact")}</th>
                    <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">{t("teamPage.permissions")}</th>
                    <th className="text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">{t("common.status")}</th>
                    <th className="text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider px-4 py-3">{t("common.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {staff.map(s => {
                    const perms = Array.isArray(s.agentStaffPermissions) ? s.agentStaffPermissions : [];
                    return (
                      <tr key={s.id} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-teal-500/10 flex items-center justify-center text-teal-600 font-semibold text-xs">
                              {(s.firstName?.[0] || "")}{(s.lastName?.[0] || "")}
                            </div>
                            <div>
                              <p className="font-medium text-foreground text-sm">{s.firstName} {s.lastName}</p>
                              <p className="text-xs text-muted-foreground">ID #{s.id}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="space-y-0.5">
                            {s.email && (
                              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <Mail className="w-3 h-3" /> {s.email}
                              </p>
                            )}
                            {s.phone && (
                              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                                <Phone className="w-3 h-3" /> {s.phone}
                              </p>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {perms.length === 0 ? (
                              <Badge variant="outline" className="text-[10px]">{t("teamPage.none")}</Badge>
                            ) : perms.slice(0, 4).map(p => (
                              <Badge key={p} variant="outline" className="text-[10px] capitalize">
                                {p.replace("_", " ")}
                              </Badge>
                            ))}
                            {perms.length > 4 && (
                              <Badge variant="outline" className="text-[10px]">+{perms.length - 4}</Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          {s.isActive ? (
                            <Badge className="bg-green-500/10 text-green-600 border-green-200 text-[10px]">{t("common.active")}</Badge>
                          ) : (
                            <Badge className="bg-red-500/10 text-red-600 border-red-200 text-[10px]">{t("common.inactive")}</Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => { setSelectedStaff(s); setShowEdit(true); }}>
                                <Edit className="w-4 h-4 mr-2" /> {t("common.edit")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => { setSelectedStaff(s); setShowPassword(true); }}>
                                <KeyRound className="w-4 h-4 mr-2" /> {t("teamPage.setPassword")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleToggleStatus(s)}>
                                {s.isActive ? <UserX className="w-4 h-4 mr-2" /> : <UserCheck className="w-4 h-4 mr-2" />}
                                {s.isActive ? t("teamPage.deactivate") : t("teamPage.activate")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => { setSelectedStaff(s); setShowDelete(true); }} className="text-destructive">
                                <Trash2 className="w-4 h-4 mr-2" /> {t("common.delete")}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {meta && meta.totalPages > 1 && (
            <div className="p-4 border-t border-border/50">
              <TablePagination
                currentPage={page}
                totalItems={meta.total}
                pageSize={limit}
                onPageChange={setPage}
              />
            </div>
          )}
        </Card>
      </div>

      <CreateStaffDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onSuccess={() => { qc.invalidateQueries({ queryKey: ["/api/agents/me/staff"] }); setShowCreate(false); }}
      />

      {selectedStaff && (
        <>
          <EditStaffDialog
            open={showEdit}
            onOpenChange={setShowEdit}
            staff={selectedStaff}
            onSuccess={() => { qc.invalidateQueries({ queryKey: ["/api/agents/me/staff"] }); setShowEdit(false); setSelectedStaff(null); }}
          />
          <SetPasswordDialog
            open={showPassword}
            onOpenChange={setShowPassword}
            staff={selectedStaff}
            onSuccess={() => { setShowPassword(false); setSelectedStaff(null); }}
          />
          <AlertDialog open={showDelete} onOpenChange={setShowDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("teamPage.deleteTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("teamPage.deleteDescription", { name: `${selectedStaff.firstName ?? ""} ${selectedStaff.lastName ?? ""}`.trim() })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => handleDelete(selectedStaff)} className="bg-destructive text-white hover:bg-destructive/90">
                  {t("common.delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </>
  );

  async function handleToggleStatus(s: StaffMember) {
    try {
      await customFetch(`/api/agents/me/staff/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !s.isActive }),
      });
      qc.invalidateQueries({ queryKey: ["/api/agents/me/staff"] });
      toast({ title: s.isActive ? t("teamPage.staffDeactivated") : t("teamPage.staffActivated") });
    } catch (err: any) {
      toast({ title: t("teamPage.errorTitle"), description: err.message, variant: "destructive" });
    }
  }

  async function handleDelete(s: StaffMember) {
    try {
      await customFetch(`/api/agents/me/staff/${s.id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["/api/agents/me/staff"] });
      setShowDelete(false);
      setSelectedStaff(null);
      toast({ title: t("teamPage.staffDeleted") });
    } catch (err: any) {
      toast({ title: t("teamPage.errorTitle"), description: err.message, variant: "destructive" });
    }
  }
}

function PermissionsChecklist({ value, onChange }: { value: string[]; onChange: (perms: string[]) => void }) {
  const { t } = useI18n();

  function toggle(key: string, children?: PermissionOption[]) {
    if (value.includes(key)) {
      const childKeys = children ? allPermissionKeys(children) : [];
      onChange(value.filter(p => p !== key && !childKeys.includes(p)));
    } else {
      onChange([...value, key]);
    }
  }

  const ALL_KEYS = allPermissionKeys(PERMISSION_OPTIONS);
  const allSelected = ALL_KEYS.every(k => value.includes(k));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium flex items-center gap-2">
          <Shield className="w-4 h-4 text-muted-foreground" />
          {t("teamPage.permissions")}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            if (allSelected) {
              onChange([]);
            } else {
              onChange(ALL_KEYS);
            }
          }}
        >
          {allSelected ? t("teamPage.deselectAll") : t("teamPage.selectAll")}
        </Button>
      </div>
      <div className="grid sm:grid-cols-2 gap-2">
        {PERMISSION_OPTIONS.map(p => {
          const hasChildren = p.children && p.children.length > 0;
          const isParentChecked = value.includes(p.key);
          return (
            <div key={p.key} className={hasChildren ? "sm:col-span-2" : ""}>
              <label
                className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                  isParentChecked ? "border-primary bg-primary/5" : "border-border/60 hover:border-border"
                }`}
              >
                <Checkbox
                  checked={isParentChecked}
                  onCheckedChange={() => toggle(p.key, p.children)}
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">{t(p.labelKey)}</p>
                  <p className="text-xs text-muted-foreground">{t(p.descKey)}</p>
                </div>
              </label>
              {hasChildren && (
                <div className="ml-6 mt-1.5 grid sm:grid-cols-2 gap-2 pl-3 border-l-2 border-border/40">
                  {p.children!.map(child => {
                    const isChildChecked = value.includes(child.key) && isParentChecked;
                    const isDisabled = !isParentChecked;
                    return (
                      <label
                        key={child.key}
                        className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                          isDisabled
                            ? "border-border/30 bg-muted/30 opacity-50 cursor-not-allowed"
                            : isChildChecked
                            ? "border-primary bg-primary/5 cursor-pointer"
                            : "border-border/60 hover:border-border cursor-pointer"
                        }`}
                      >
                        <Checkbox
                          checked={isChildChecked}
                          onCheckedChange={() => { if (!isDisabled) toggle(child.key); }}
                          disabled={isDisabled}
                          className="mt-0.5"
                        />
                        <div>
                          <p className="text-sm font-medium text-foreground">{t(child.labelKey)}</p>
                          <p className="text-xs text-muted-foreground">{t(child.descKey)}</p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CreateStaffDialog({ open, onOpenChange, onSuccess }: { open: boolean; onOpenChange: (v: boolean) => void; onSuccess: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "", password: "" });
  const [permissions, setPermissions] = useState<string[]>(["leads", "students", "applications", "documents", "course_finder"]);
  const [saving, setSaving] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.firstName || !form.lastName || !form.email || !form.password) {
      toast({ title: t("teamPage.errorTitle"), description: t("teamPage.fillRequired"), variant: "destructive" });
      return;
    }
    if (form.password.length < 6) {
      toast({ title: t("teamPage.errorTitle"), description: t("teamPage.passwordMinLength"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch("/api/agents/me/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, permissions }),
      });
      toast({ title: t("teamPage.staffCreated"), description: t("teamPage.staffCreatedDesc", { name: `${form.firstName} ${form.lastName}` }) });
      setForm({ firstName: "", lastName: "", email: "", phone: "", password: "" });
      setPermissions(["leads", "students", "applications", "documents", "course_finder"]);
      onSuccess();
    } catch (err: any) {
      toast({ title: t("teamPage.errorTitle"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("teamPage.addStaffTitle")}</DialogTitle>
          <DialogDescription>{t("teamPage.addStaffDescription")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} autoComplete="off" className="space-y-4 pt-2">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">{t("teamPage.firstNameRequired")}</Label>
              <Input autoComplete="off" value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">{t("teamPage.lastNameRequired")}</Label>
              <Input autoComplete="off" value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Mail className="w-3 h-3" /> {t("teamPage.emailRequired")}
            </Label>
            <Input type="email" autoComplete="off" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="h-9" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Phone className="w-3 h-3" /> {t("common.phone")}
            </Label>
            <PhoneInput value={form.phone} onChange={phone => setForm(f => ({ ...f, phone }))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <KeyRound className="w-3 h-3" /> {t("teamPage.passwordRequired")}
            </Label>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                autoComplete="new-password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                placeholder={t("teamPage.passwordPlaceholder")}
                className="h-9 pr-10"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="border-t border-border/50 pt-4">
            <PermissionsChecklist value={permissions} onChange={setPermissions} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("teamPage.createStaff")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}

function EditStaffDialog({ open, onOpenChange, staff, onSuccess }: { open: boolean; onOpenChange: (v: boolean) => void; staff: StaffMember; onSuccess: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [form, setForm] = useState({ firstName: staff.firstName || "", lastName: staff.lastName || "", phone: staff.phone || "" });
  const [permissions, setPermissions] = useState<string[]>(Array.isArray(staff.agentStaffPermissions) ? staff.agentStaffPermissions : []);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await customFetch(`/api/agents/me/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, permissions }),
      });
      toast({ title: t("teamPage.staffUpdated") });
      onSuccess();
    } catch (err: any) {
      toast({ title: t("teamPage.errorTitle"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("teamPage.editStaffTitle")}</DialogTitle>
          <DialogDescription>{t("teamPage.editStaffDescription", { name: `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">{t("teamPage.firstName")}</Label>
              <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">{t("teamPage.lastName")}</Label>
              <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="h-9" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">{t("common.email")}</Label>
            <Input value={staff.email || ""} disabled className="h-9 bg-muted/50" />
            <p className="text-[11px] text-muted-foreground">{t("teamPage.emailCannotChange")}</p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              <Phone className="w-3 h-3" /> {t("common.phone")}
            </Label>
            <PhoneInput value={form.phone} onChange={phone => setForm(f => ({ ...f, phone }))} />
          </div>

          <div className="border-t border-border/50 pt-4">
            <PermissionsChecklist value={permissions} onChange={setPermissions} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving} className="gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("teamPage.saveChanges")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}

function SetPasswordDialog({ open, onOpenChange, staff, onSuccess }: { open: boolean; onOpenChange: (v: boolean) => void; staff: StaffMember; onSuccess: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [showPw, setShowPw] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) {
      toast({ title: t("teamPage.errorTitle"), description: t("teamPage.passwordMinLength"), variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await customFetch(`/api/agents/me/staff/${staff.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      toast({ title: t("teamPage.passwordUpdated"), description: t("teamPage.passwordUpdatedDesc", { name: `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() }) });
      setPassword("");
      onSuccess();
    } catch (err: any) {
      toast({ title: t("teamPage.errorTitle"), description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("teamPage.setPassword")}</DialogTitle>
          <DialogDescription>{t("teamPage.setPasswordDescription", { name: `${staff.firstName ?? ""} ${staff.lastName ?? ""}`.trim() })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">{t("teamPage.newPassword")}</Label>
            <div className="relative">
              <Input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t("teamPage.passwordPlaceholder")}
                className="h-9 pr-10"
              />
              <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
            <Button type="submit" disabled={saving || password.length < 6} className="gap-2">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {t("teamPage.updatePassword")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    </>
  );
}
