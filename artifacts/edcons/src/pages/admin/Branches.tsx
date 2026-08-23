import { useEffect, useState, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from "@/components/ui/command";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { PhoneInput } from "@/components/ui/phone-input";
import {
  Building2, Plus, Edit, Archive, ArchiveRestore, Loader2, Save,
  Mail, Phone, MapPin, Upload, X, Image as ImageIcon, Search,
  ChevronsUpDown, Check, User,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

type Branch = {
  id: number;
  name: string;
  country: string | null;
  city: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactUserId: number | null;
  contactUserFirstName: string | null;
  contactUserLastName: string | null;
  contactUserEmail: string | null;
  logoUrl: string | null;
  notes: string | null;
  archivedAt: string | null;
  createdAt: string;
};

type CountryRow = {
  id: number;
  name: string;
  code: string;
  flagEmoji: string | null;
};

type CityRow = {
  id: number;
  name: string;
  countryId: number;
};

type StaffUser = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
};

type FormState = {
  name: string;
  country: string;
  countryId: number | null;
  city: string;
  contactUserId: number | null;
  contactEmail: string;
  contactPhone: string;
  logoUrl: string;
  notes: string;
};

const emptyForm: FormState = {
  name: "", country: "", countryId: null, city: "",
  contactUserId: null, contactEmail: "", contactPhone: "",
  logoUrl: "", notes: "",
};

export default function BranchesPage() {
  const { user } = useAuth(true);
  const { toast } = useToast();
  const { t } = useI18n();
  const isSuperAdmin = user?.role === "super_admin";

  const [branches, setBranches] = useState<Branch[]>([]);
  const [stats, setStats] = useState<Record<number, { agents: number }>>({});
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");

  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [cities, setCities] = useState<CityRow[]>([]);
  const [staffUsers, setStaffUsers] = useState<StaffUser[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(false);

  const [countryOpen, setCountryOpen] = useState(false);
  const [cityOpen, setCityOpen] = useState(false);
  const [staffOpen, setStaffOpen] = useState(false);

  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  async function fetchBranches() {
    setLoading(true);
    try {
      const res: any = await customFetch(`/api/branches?archived=${showArchived ? "1" : "0"}`);
      setBranches(res.data || []);
    } catch (err: any) {
      toast({ title: t("branches.errorTitle"), description: err.message, variant: "destructive" });
    }
    setLoading(false);
  }

  async function fetchStats() {
    if (!isSuperAdmin) return;
    try {
      const res: any = await customFetch(`/api/branches/stats`);
      setStats(res || {});
    } catch {}
  }

  async function fetchCountries() {
    try {
      const res: any = await customFetch(`/api/countries?limit=500&status=active`);
      setCountries(res.data || []);
    } catch {}
  }

  async function fetchStaffUsers() {
    try {
      const staffRoles = "super_admin,admin,manager,staff,consultant,editor,accountant";
      const res: any = await customFetch(`/api/users?roles=${staffRoles}&limit=200`);
      setStaffUsers(res.data || res.users || []);
    } catch {}
  }

  async function fetchCities(countryId: number) {
    setCitiesLoading(true);
    try {
      const res: any = await customFetch(`/api/cities?countryId=${countryId}&limit=500`);
      setCities(res.data || []);
    } catch {}
    setCitiesLoading(false);
  }

  useEffect(() => { fetchBranches(); }, [showArchived]);
  useEffect(() => { fetchStats(); }, [isSuperAdmin]);
  useEffect(() => { fetchCountries(); fetchStaffUsers(); }, []);

  useEffect(() => {
    if (form.countryId) {
      fetchCities(form.countryId);
    } else {
      setCities([]);
    }
  }, [form.countryId]);

  function openCreate() {
    setEditing(null);
    setForm({ ...emptyForm });
    setCities([]);
    setShowDialog(true);
  }

  function openEdit(b: Branch) {
    setEditing(b);
    const foundCountry = countries.find(c => c.name === b.country || c.code === b.country);
    setForm({
      name: b.name,
      country: b.country || "",
      countryId: foundCountry?.id ?? null,
      city: b.city || "",
      contactUserId: b.contactUserId,
      contactEmail: b.contactEmail || "",
      contactPhone: b.contactPhone || "",
      logoUrl: b.logoUrl || "",
      notes: b.notes || "",
    });
    if (foundCountry) fetchCities(foundCountry.id);
    setShowDialog(true);
  }

  async function uploadLogo(file: File) {
    setLogoUploading(true);
    try {
      const urlRes: any = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type, prefix: "branding" }),
      });
      if (!urlRes.uploadURL) throw new Error(t("branches.uploadLinkFailed"));
      const putRes = await fetch(urlRes.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error(t("branches.uploadFailed"));
      const stripped = urlRes.objectPath.replace(/^\/objects/, "");
      const publicUrl = `${BASE_URL}/api/storage/objects${stripped}`;
      setForm(f => ({ ...f, logoUrl: publicUrl }));
      toast({ title: t("branches.logoUploaded") });
    } catch (err: any) {
      toast({ title: t("branches.uploadFailed"), description: err.message, variant: "destructive" });
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast({ title: t("branches.nameRequired"), variant: "destructive" });
      return;
    }
    setSaving(true);
    const selectedStaff = staffUsers.find(s => s.id === form.contactUserId);
    const body = {
      name: form.name.trim(),
      country: form.country || null,
      city: form.city || null,
      contactName: selectedStaff
        ? `${selectedStaff.firstName} ${selectedStaff.lastName}`.trim()
        : null,
      contactEmail: form.contactEmail.trim() || (selectedStaff?.email ?? null),
      contactPhone: form.contactPhone || null,
      contactUserId: form.contactUserId ?? null,
      logoUrl: form.logoUrl || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (editing) {
        await customFetch(`/api/branches/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast({ title: t("branches.branchUpdated") });
      } else {
        await customFetch(`/api/branches`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast({ title: t("branches.branchCreated") });
      }
      setShowDialog(false);
      fetchBranches();
      fetchStats();
    } catch (err: any) {
      const issues = err?.data?.issues as Array<{ path?: string; message?: string }> | undefined;
      const description = Array.isArray(issues) && issues.length > 0
        ? issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")
        : err.message;
      toast({ title: t("branches.errorTitle"), description, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleArchive(b: Branch) {
    const action = b.archivedAt ? t("branches.actionRestore") : t("branches.actionArchive");
    if (!confirm(t("branches.archiveConfirm", { name: b.name, action }))) return;
    try {
      await customFetch(`/api/branches/${b.id}/${b.archivedAt ? "unarchive" : "archive"}`, { method: "POST" });
      toast({ title: b.archivedAt ? t("branches.branchRestored") : t("branches.branchArchived") });
      fetchBranches();
    } catch (err: any) {
      toast({ title: t("branches.errorTitle"), description: err.message, variant: "destructive" });
    }
  }

  const filtered = branches.filter(b =>
    !search.trim() ||
    b.name.toLowerCase().includes(search.toLowerCase()) ||
    (b.city || "").toLowerCase().includes(search.toLowerCase()) ||
    (b.country || "").toLowerCase().includes(search.toLowerCase())
  );

  function getFlagEmoji(countryNameOrCode: string | null): string {
    if (!countryNameOrCode) return "";
    const found = countries.find(c => c.name === countryNameOrCode || c.code === countryNameOrCode);
    return found?.flagEmoji || "";
  }

  function getContactDisplayName(b: Branch): string {
    if (b.contactUserFirstName || b.contactUserLastName) {
      return `${b.contactUserFirstName || ""} ${b.contactUserLastName || ""}`.trim();
    }
    return b.contactName || "";
  }

  function getContactDisplayEmail(b: Branch): string {
    return b.contactUserEmail || b.contactEmail || "";
  }

  const selectedCountry = countries.find(c => c.id === form.countryId) ?? null;
  const selectedStaff = staffUsers.find(s => s.id === form.contactUserId) ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground">{t("branches.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("branches.subtitle")}</p>
        </div>
        {isSuperAdmin && (
          <Button onClick={openCreate} className="rounded-xl gap-2">
            <Plus className="w-4 h-4" /> {t("branches.newBranch")}
          </Button>
        )}
      </div>

      <Card className="border-none shadow-lg shadow-black/5 p-6">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="relative min-w-[240px] max-w-sm flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder={t("branches.searchPlaceholder")} value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 rounded-xl"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button variant={showArchived ? "secondary" : "outline"} size="sm" onClick={() => setShowArchived(s => !s)} className="rounded-xl">
              {showArchived ? t("branches.hideArchived") : t("branches.showArchived")}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center">
            <Building2 className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
            <p className="text-muted-foreground">
              {showArchived ? t("branches.emptyArchived") : t("branches.emptyActive")}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(b => {
              const archived = !!b.archivedAt;
              const agentCount = stats[b.id]?.agents ?? 0;
              const flagEmoji = getFlagEmoji(b.country);
              const displayName = getContactDisplayName(b);
              const displayEmail = getContactDisplayEmail(b);
              return (
                <Card key={b.id} className={`p-5 border ${archived ? "opacity-60" : ""}`}>
                  <div className="flex items-start gap-3 mb-3">
                    {b.logoUrl ? (
                      <img src={b.logoUrl} alt={b.name} className="w-12 h-12 rounded-lg object-cover border border-border" />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-gradient-to-tr from-primary/20 to-accent/20 flex items-center justify-center">
                        <Building2 className="w-6 h-6 text-primary" />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-display font-bold text-base truncate">{b.name}</h3>
                        {archived && <Badge variant="outline" className="text-xs">{t("branches.archivedBadge")}</Badge>}
                      </div>
                      {(b.city || b.country) && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                          {flagEmoji ? (
                            <span className="text-base leading-none">{flagEmoji}</span>
                          ) : (
                            <MapPin className="w-3 h-3" />
                          )}
                          <span>{[b.city, b.country].filter(Boolean).join(", ")}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1 text-xs text-muted-foreground mb-3 min-h-[3.5rem]">
                    {displayName && <p className="font-medium text-foreground">{displayName}</p>}
                    {displayEmail && <p className="flex items-center gap-1.5"><Mail className="w-3 h-3" /> {displayEmail}</p>}
                    {b.contactPhone && <p className="flex items-center gap-1.5"><Phone className="w-3 h-3" /> {b.contactPhone}</p>}
                    {!displayName && !displayEmail && !b.contactPhone && (
                      <p className="italic">{t("branches.noContactInfo")}</p>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-3 border-t border-border/50">
                    <Badge variant="secondary" className="text-xs">{t("branches.agentCount", { count: agentCount })}</Badge>
                    {isSuperAdmin && (
                      <div className="flex gap-1">
                        <Button size="icon" variant="ghost" className="w-8 h-8" onClick={() => openEdit(b)} title={t("branches.edit")}>
                          <Edit className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="w-8 h-8" onClick={() => handleArchive(b)}
                          title={archived ? t("branches.restore") : t("branches.archive")}>
                          {archived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                        </Button>
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Card>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? t("branches.editDialogTitle") : t("branches.newBranch")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-semibold">{t("branches.branchNameLabel")}</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t("branches.branchNamePlaceholder")} className="rounded-xl mt-1.5" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm font-semibold">{t("branches.countryLabel")}</Label>
                <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={countryOpen}
                      className="w-full justify-between rounded-xl mt-1.5 font-normal h-10 px-3">
                      {selectedCountry ? (
                        <span className="flex items-center gap-2">
                          {selectedCountry.flagEmoji && <span>{selectedCountry.flagEmoji}</span>}
                          <span className="truncate">{selectedCountry.name}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("branches.selectCountry")}</span>
                      )}
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[280px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t("branches.searchCountry")} />
                      <CommandList>
                        <CommandEmpty>{t("branches.noCountryFound")}</CommandEmpty>
                        <CommandGroup>
                          <CommandItem value="__clear__" onSelect={() => {
                            setForm(f => ({ ...f, country: "", countryId: null, city: "" }));
                            setCities([]);
                            setCountryOpen(false);
                          }}>
                            <span className="text-muted-foreground">—</span>
                          </CommandItem>
                          {countries.map(c => (
                            <CommandItem key={c.id} value={`${c.name} ${c.code}`} onSelect={() => {
                              setForm(f => ({ ...f, country: c.name, countryId: c.id, city: "" }));
                              setCountryOpen(false);
                            }}>
                              <Check className={cn("mr-2 h-4 w-4", form.countryId === c.id ? "opacity-100" : "opacity-0")} />
                              {c.flagEmoji && <span className="mr-2">{c.flagEmoji}</span>}
                              {c.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>

              <div>
                <Label className="text-sm font-semibold">{t("branches.cityLabel")}</Label>
                <Popover open={cityOpen} onOpenChange={setCityOpen}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" role="combobox" aria-expanded={cityOpen}
                      className="w-full justify-between rounded-xl mt-1.5 font-normal h-10 px-3"
                      disabled={!form.countryId}>
                      {form.city ? (
                        <span className="truncate">{form.city}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          {citiesLoading ? t("branches.loadingCities") : t("branches.selectCity")}
                        </span>
                      )}
                      {citiesLoading
                        ? <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin" />
                        : <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[280px] p-0" align="start">
                    <Command>
                      <CommandInput placeholder={t("branches.searchCity")} />
                      <CommandList>
                        <CommandEmpty>
                          {citiesLoading ? t("branches.loadingCities") : t("branches.noCity")}
                        </CommandEmpty>
                        <CommandGroup>
                          <CommandItem value="__clear__" onSelect={() => {
                            setForm(f => ({ ...f, city: "" }));
                            setCityOpen(false);
                          }}>
                            <span className="text-muted-foreground">—</span>
                          </CommandItem>
                          {cities.map(c => (
                            <CommandItem key={c.id} value={c.name} onSelect={() => {
                              setForm(f => ({ ...f, city: c.name }));
                              setCityOpen(false);
                            }}>
                              <Check className={cn("mr-2 h-4 w-4", form.city === c.name ? "opacity-100" : "opacity-0")} />
                              {c.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold">{t("branches.contactUserLabel")}</Label>
              <Popover open={staffOpen} onOpenChange={setStaffOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" aria-expanded={staffOpen}
                    className="w-full justify-between rounded-xl mt-1.5 font-normal h-10 px-3">
                    {selectedStaff ? (
                      <span className="flex items-center gap-2 min-w-0">
                        <User className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{`${selectedStaff.firstName} ${selectedStaff.lastName}`}</span>
                        <span className="text-muted-foreground text-xs shrink-0">({selectedStaff.email})</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("branches.selectContactPerson")}</span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[420px] p-0" align="start">
                  <Command>
                    <CommandInput placeholder={t("branches.searchStaff")} />
                    <CommandList>
                      <CommandEmpty>{t("branches.noStaff")}</CommandEmpty>
                      <CommandGroup>
                        <CommandItem value="__none__" onSelect={() => {
                          setForm(f => ({ ...f, contactUserId: null }));
                          setStaffOpen(false);
                        }}>
                          <span className="text-muted-foreground">— {t("branches.noContactPerson")}</span>
                        </CommandItem>
                        {staffUsers.map(s => (
                          <CommandItem key={s.id} value={`${s.firstName} ${s.lastName} ${s.email}`} onSelect={() => {
                            setForm(f => ({ ...f, contactUserId: s.id }));
                            setStaffOpen(false);
                          }}>
                            <Check className={cn("mr-2 h-4 w-4", form.contactUserId === s.id ? "opacity-100" : "opacity-0")} />
                            <div className="flex flex-col">
                              <span>{`${s.firstName} ${s.lastName}`}</span>
                              <span className="text-xs text-muted-foreground">{s.email}</span>
                            </div>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-sm font-semibold">{t("branches.emailLabel")}</Label>
                <Input
                  type="email"
                  value={form.contactEmail}
                  onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))}
                  className="rounded-xl mt-1.5"
                  placeholder={selectedStaff?.email || ""}
                />
              </div>
              <div>
                <Label className="text-sm font-semibold">{t("branches.phoneLabel")}</Label>
                <div className="mt-1.5">
                  <PhoneInput value={form.contactPhone} onChange={v => setForm(f => ({ ...f, contactPhone: v }))} />
                </div>
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold">{t("branches.logoLabel")}</Label>
              <div className="flex items-center gap-3 mt-1.5">
                {form.logoUrl ? (
                  <div className="relative">
                    <img src={form.logoUrl} alt="Logo" className="w-16 h-16 rounded-lg object-cover border border-border" />
                    <button type="button" onClick={() => setForm(f => ({ ...f, logoUrl: "" }))}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-destructive text-white flex items-center justify-center">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-secondary/40 border border-dashed border-border flex items-center justify-center">
                    <ImageIcon className="w-5 h-5 text-muted-foreground" />
                  </div>
                )}
                <Button type="button" variant="outline" size="sm" disabled={logoUploading}
                  onClick={() => logoInputRef.current?.click()} className="rounded-xl gap-2">
                  {logoUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  {logoUploading ? t("branches.uploading") : t("branches.uploadLogo")}
                </Button>
                <input ref={logoInputRef} type="file" accept="image/*" className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ""; }} />
              </div>
            </div>

            <div>
              <Label className="text-sm font-semibold">{t("branches.notesLabel")}</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} className="rounded-xl mt-1.5" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)} className="rounded-xl">{t("branches.cancel")}</Button>
            <Button onClick={handleSave} disabled={saving} className="rounded-xl gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {t("branches.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
