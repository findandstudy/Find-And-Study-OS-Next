import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import { toLatinUpper, digitsOnly } from "@/lib/textTransform";
import { customFetch } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import {
  User, Globe, Shield, Save, Check, Briefcase,
  Loader2, Phone, Mail, TrendingUp, MapPin,
  Upload, X, FileText, Download, Image as ImageIcon, Eye,
  Camera, Lock, KeyRound, LogOut, Code, Copy, ExternalLink,
} from "lucide-react";
import { CountryFlag } from "@/components/CountryFlag";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

const LANGUAGES = [
  { code: "en", label: "English",   country: "GB" },
  { code: "tr", label: "Türkçe",    country: "TR" },
  { code: "ar", label: "العربية",   country: "SA" },
  { code: "fr", label: "Français",  country: "FR" },
  { code: "ru", label: "Русский",   country: "RU" },
  { code: "fa", label: "فارسی",     country: "IR" },
  { code: "zh", label: "中文",       country: "CN" },
  { code: "hi", label: "हिन्दी",       country: "IN" },
  { code: "es", label: "Español",   country: "ES" },
  { code: "id", label: "Bahasa",    country: "ID" },
];

const PHONE_CODES = [
  { code: "+90", country: "TR" },
  { code: "+1", country: "US" },
  { code: "+44", country: "GB" },
  { code: "+49", country: "DE" },
  { code: "+33", country: "FR" },
  { code: "+971", country: "AE" },
  { code: "+966", country: "SA" },
  { code: "+91", country: "IN" },
  { code: "+86", country: "CN" },
  { code: "+81", country: "JP" },
  { code: "+82", country: "KR" },
  { code: "+55", country: "BR" },
  { code: "+234", country: "NG" },
  { code: "+20", country: "EG" },
  { code: "+254", country: "KE" },
  { code: "+27", country: "ZA" },
  { code: "+62", country: "ID" },
  { code: "+60", country: "MY" },
  { code: "+63", country: "PH" },
  { code: "+92", country: "PK" },
  { code: "+880", country: "BD" },
  { code: "+7", country: "RU" },
  { code: "+380", country: "UA" },
  { code: "+48", country: "PL" },
  { code: "+39", country: "IT" },
  { code: "+34", country: "ES" },
  { code: "+31", country: "NL" },
  { code: "+46", country: "SE" },
  { code: "+47", country: "NO" },
  { code: "+358", country: "FI" },
  { code: "+212", country: "MA" },
  { code: "+216", country: "TN" },
  { code: "+213", country: "DZ" },
  { code: "+964", country: "IQ" },
  { code: "+962", country: "JO" },
  { code: "+961", country: "LB" },
  { code: "+994", country: "AZ" },
  { code: "+995", country: "GE" },
  { code: "+998", country: "UZ" },
  { code: "+993", country: "TM" },
];

function splitPhone(phone: string | null) {
  if (!phone) return { code: "+90", number: "" };
  const sorted = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
  for (const pc of sorted) {
    if (phone.startsWith(pc.code)) {
      return { code: pc.code, number: phone.slice(pc.code.length).trim() };
    }
  }
  return { code: "+90", number: phone };
}

async function uploadFileToStorage(file: File): Promise<string> {
  const urlRes = await customFetch<any>(`/api/storage/uploads/request-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
  });
  if (!urlRes.uploadURL || !urlRes.objectPath) throw new Error("Failed to get upload URL");
  const putRes = await fetch(urlRes.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
  if (!putRes.ok) throw new Error("Upload failed");
  const strippedPath = urlRes.objectPath.replace(/^\/objects/, "");
  return `${BASE_URL}/api/storage/objects${strippedPath}`;
}

export default function AgentAccount() {
  const { user } = useAuth(true);
  const { t, lang, setLang } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const contractPollStart = useRef<number>(Date.now());

  const [form, setForm] = useState({ firstName: "", lastName: "", phoneCode: "+90", phoneNumber: "", email: "", avatarUrl: "" });
  const [saving, setSaving] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [pwForm, setPwForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [changingPw, setChangingPw] = useState(false);

  useEffect(() => {
    if (user) {
      const { code, number } = splitPhone((user as any).phone || "");
      setForm({
        firstName: user.firstName || "",
        lastName:  user.lastName  || "",
        phoneCode: code,
        phoneNumber: number,
        email: user.email || "",
        avatarUrl: user.avatarUrl || "",
      });
    }
  }, [user]);

  const { data: agentProfile, isLoading: agentLoading } = useQuery({
    queryKey: ["agent-me"],
    enabled: !!user,
    queryFn: () => customFetch<any>("/api/agents/me"),
    // Re-fetch when the tab regains focus so admin-side changes (e.g.
    // uploading/replacing the contract file) appear without a hard reload.
    refetchOnWindowFocus: true,
    // Poll every 5 s until contractUrl is populated (background PDF worker runs
    // ~30 s after signing). Stop after 2 minutes to avoid indefinite polling
    // for agents who genuinely have no signed contract yet.
    refetchInterval: (query) => {
      const d = query.state.data as any;
      if (!d || d.contractUrl) return false;
      if (Date.now() - contractPollStart.current > 120_000) return false;
      return 5_000;
    },
  });

  async function handleAvatarUpload(file: File) {
    if (!user) return;
    setAvatarUploading(true);
    try {
      const avatarUrl = await uploadFileToStorage(file);
      setForm(f => ({ ...f, avatarUrl }));
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile photo updated" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally { setAvatarUploading(false); }
  }

  async function handleRemoveAvatar() {
    if (!user) return;
    try {
      setForm(f => ({ ...f, avatarUrl: "" }));
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarUrl: null }),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile photo removed" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleSaveProfile() {
    if (!user) return;
    setSaving(true);
    try {
      const phone = form.phoneNumber ? `${form.phoneCode}${form.phoneNumber}` : undefined;
      const payload: Record<string, unknown> = { phone, avatarUrl: form.avatarUrl || null };
      if (!isImmutable) {
        payload.firstName = form.firstName;
        payload.lastName  = form.lastName;
        if (form.email) payload.email = form.email;
      }
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await qc.invalidateQueries({ queryKey: ["/api/auth/me"] });
      toast({ title: "Profile updated", description: "Your information has been saved." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match", variant: "destructive" });
      return;
    }
    if (pwForm.newPassword.length < 6) {
      toast({ title: "Error", description: "Password must be at least 6 characters", variant: "destructive" });
      return;
    }
    setChangingPw(true);
    try {
      await customFetch("/api/users/me/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwForm.currentPassword, newPassword: pwForm.newPassword }),
      });
      setPwForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      toast({ title: "Password changed", description: "Your password has been updated successfully." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally { setChangingPw(false); }
  }

  async function handleSaveLang(code: string) {
    if (!user) return;
    setLang(code as any);
    try {
      await customFetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: code }),
      });
    } catch {}
  }

  const isImmutable = user?.role === "agent" || user?.role === "sub_agent";
  const initials = `${user?.firstName?.[0] || ""}${user?.lastName?.[0] || user?.email?.[0] || "?"}`.toUpperCase();

  return (
      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-display font-bold text-foreground">{t("agentAccount.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("agentAccount.subtitle")}</p>
        </div>

        <Tabs defaultValue="profile" className="space-y-0">
          <TabsList className="w-full justify-start rounded-none border-b bg-transparent p-0 h-auto gap-0">
            {[
              { value: "profile", label: "Profile", icon: User },
              { value: "agency", label: "Agency", icon: Briefcase },
              { value: "web-to-lead", label: "Web to Lead", icon: Code },
              { value: "language", label: "Language", icon: Globe },
              { value: "security", label: "Security", icon: Shield },
            ].map(tab => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-5 py-3 gap-2 text-sm font-medium"
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          {/* ── Profile Tab ── */}
          <TabsContent value="profile" className="pt-6 space-y-6">
            <div className="grid lg:grid-cols-[280px_1fr] gap-6">
              {/* Left: Avatar Card */}
              <Card className="border shadow-sm p-6 flex flex-col items-center text-center h-fit">
                <div className="relative group mb-4">
                  {form.avatarUrl ? (
                    <img src={form.avatarUrl} alt="" className="w-28 h-28 rounded-full object-cover ring-4 ring-primary/10" />
                  ) : (
                    <div className="w-28 h-28 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center text-white font-display font-bold text-3xl ring-4 ring-primary/10">
                      {initials}
                    </div>
                  )}
                  <button
                    onClick={() => avatarInputRef.current?.click()}
                    disabled={avatarUploading}
                    className="absolute inset-0 rounded-full bg-black/0 group-hover:bg-black/40 flex items-center justify-center transition-all opacity-0 group-hover:opacity-100 cursor-pointer"
                  >
                    {avatarUploading ? <Loader2 className="w-6 h-6 text-white animate-spin" /> : <Camera className="w-6 h-6 text-white" />}
                  </button>
                  {form.avatarUrl && (
                    <button onClick={handleRemoveAvatar} className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-destructive text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive/90 shadow-md">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleAvatarUpload(f); e.target.value = ""; }} />
                </div>
                <h3 className="font-display font-bold text-lg text-foreground">{user?.firstName} {user?.lastName}</h3>
                <p className="text-muted-foreground text-sm mt-0.5">{user?.email}</p>
                <Badge className="bg-amber-500/10 text-amber-600 border-amber-200 text-xs mt-3">
                  {user?.role === "sub_agent" ? "Sub Agent" : "Agent"}
                </Badge>
                <p className="text-[11px] text-muted-foreground mt-3">Hover photo to change</p>
              </Card>

              {/* Right: Profile Form */}
              <div className="space-y-6">
                <Card className="border shadow-sm p-6">
                  <h3 className="font-display font-semibold text-base mb-5">Personal Information</h3>
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        First Name
                        {isImmutable && (
                          <Tooltip>
                            <TooltipTrigger asChild><Lock className="w-3 h-3 text-muted-foreground/60 cursor-help" /></TooltipTrigger>
                            <TooltipContent><p>{t("agentAccount.immutableFieldTooltip")}</p></TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: toLatinUpper(e.target.value) }))} className="h-10 uppercase" disabled={isImmutable} />
                      {isImmutable && <p className="text-[11px] text-muted-foreground">{t("agentAccount.immutableFieldHint")}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        Last Name
                        {isImmutable && (
                          <Tooltip>
                            <TooltipTrigger asChild><Lock className="w-3 h-3 text-muted-foreground/60 cursor-help" /></TooltipTrigger>
                            <TooltipContent><p>{t("agentAccount.immutableFieldTooltip")}</p></TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: toLatinUpper(e.target.value) }))} className="h-10 uppercase" disabled={isImmutable} />
                      {isImmutable && <p className="text-[11px] text-muted-foreground">{t("agentAccount.immutableFieldHint")}</p>}
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Mail className="w-3 h-3" /> Email
                        {isImmutable && (
                          <Tooltip>
                            <TooltipTrigger asChild><Lock className="w-3 h-3 text-muted-foreground/60 cursor-help" /></TooltipTrigger>
                            <TooltipContent><p>{t("agentAccount.immutableFieldTooltip")}</p></TooltipContent>
                          </Tooltip>
                        )}
                      </Label>
                      <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="h-10" disabled={isImmutable} />
                      {isImmutable && <p className="text-[11px] text-muted-foreground">{t("agentAccount.immutableFieldHint")}</p>}
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                        <Phone className="w-3 h-3" /> Phone
                      </Label>
                      <div className="flex gap-2">
                        <PhoneCodePicker value={form.phoneCode} onChange={v => setForm(f => ({ ...f, phoneCode: v }))} triggerClassName="w-[110px] h-10 shrink-0" />
                        <Input
                          value={form.phoneNumber}
                          onChange={e => setForm(f => ({ ...f, phoneNumber: digitsOnly(e.target.value) }))}
                          inputMode="numeric"
                          placeholder="555 123 4567"
                          className="h-10 flex-1"
                        />
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end mt-5 pt-4 border-t border-border/50">
                    <Button onClick={handleSaveProfile} disabled={saving} size="sm" className="gap-2 px-6">
                      {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                      Save Changes
                    </Button>
                  </div>
                </Card>

                <Card className="border shadow-sm p-6">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
                      <KeyRound className="w-4 h-4 text-amber-600" />
                    </div>
                    <h3 className="font-display font-semibold text-base">Change Password</h3>
                  </div>
                  <div className="grid sm:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Current Password</Label>
                      <Input type="password" value={pwForm.currentPassword} onChange={e => setPwForm(f => ({ ...f, currentPassword: e.target.value }))} className="h-10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">New Password</Label>
                      <Input type="password" value={pwForm.newPassword} onChange={e => setPwForm(f => ({ ...f, newPassword: e.target.value }))} placeholder="Min 6 characters" className="h-10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-medium text-muted-foreground">Confirm Password</Label>
                      <Input type="password" value={pwForm.confirmPassword} onChange={e => setPwForm(f => ({ ...f, confirmPassword: e.target.value }))} className="h-10" />
                    </div>
                  </div>
                  <div className="flex justify-end mt-5 pt-4 border-t border-border/50">
                    <Button onClick={handleChangePassword} disabled={changingPw || !pwForm.currentPassword || !pwForm.newPassword} variant="outline" size="sm" className="gap-2 px-6">
                      {changingPw ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                      Update Password
                    </Button>
                  </div>
                </Card>
              </div>
            </div>
          </TabsContent>

          {/* ── Agency Tab ── */}
          <TabsContent value="agency" className="pt-6">
            <AgencyTab agentProfile={agentProfile} agentLoading={agentLoading} isStaff={user?.role === "agent_staff"} />
          </TabsContent>

          {/* ── Web to Lead Tab ── */}
          <TabsContent value="web-to-lead" className="pt-6">
            <WebToLeadTab />
          </TabsContent>

          {/* ── Language Tab ── */}
          <TabsContent value="language" className="pt-6">
            <Card className="border shadow-sm p-6">
              <h3 className="font-display font-semibold text-base mb-5">Language Preference</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {LANGUAGES.map(l => (
                  <button key={l.code} onClick={() => handleSaveLang(l.code)}
                    className={`flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all hover:border-primary/50
                      ${lang === l.code ? "border-primary bg-primary/5 shadow-sm" : "border-border/60 hover:bg-secondary/30"}`}>
                    <CountryFlag code={l.country} size="xl" />
                    <div className="flex-1">
                      <p className="font-semibold text-foreground text-sm">{l.label}</p>
                      <p className="text-xs text-muted-foreground">{l.code.toUpperCase()}</p>
                    </div>
                    {lang === l.code && <Check className="w-5 h-5 text-primary" />}
                  </button>
                ))}
              </div>
            </Card>
          </TabsContent>

          {/* ── Security Tab ── */}
          <TabsContent value="security" className="pt-6">
            <div className="grid lg:grid-cols-2 gap-6">
              <Card className="border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                    <Shield className="w-4 h-4 text-blue-600" />
                  </div>
                  <h3 className="font-display font-semibold text-base">Account Security</h3>
                </div>
                <div className="space-y-3">
                  <div className="flex justify-between items-center py-3 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">Account Status</span>
                    <Badge className="bg-green-500/10 text-green-600 border-green-200 text-xs">Active</Badge>
                  </div>
                  <div className="flex justify-between items-center py-3 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">Role</span>
                    <Badge className="bg-amber-500/10 text-amber-600 border-amber-200 text-xs capitalize">
                      {user?.role?.replace("_", " ")}
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center py-3 border-b border-border/50">
                    <span className="text-sm text-muted-foreground">Account ID</span>
                    <span className="font-mono text-sm text-foreground">#{user?.id}</span>
                  </div>
                  <div className="flex justify-between items-center py-3">
                    <span className="text-sm text-muted-foreground">Authentication</span>
                    <span className="text-sm text-foreground">Email & Password</span>
                  </div>
                </div>
              </Card>
              <Card className="border shadow-sm p-6 flex flex-col">
                <div className="flex items-center gap-3 mb-5">
                  <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
                    <LogOut className="w-4 h-4 text-red-500" />
                  </div>
                  <h3 className="font-display font-semibold text-base">Session</h3>
                </div>
                <p className="text-sm text-muted-foreground mb-5 flex-1">Sign out of your current session on this device. You will need to log in again to access your account.</p>
                <Button variant="outline" className="w-full text-destructive hover:bg-destructive/5 hover:border-destructive/30 gap-2" asChild>
                  <a href="/api/auth/logout">
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </a>
                </Button>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
  );
}

function AgencyTab({ agentProfile, agentLoading, isStaff = false }: { agentProfile: any; agentLoading: boolean; isStaff?: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [businessName, setBusinessName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (agentProfile) {
      setBusinessName(agentProfile.businessName || "");
    }
  }, [agentProfile]);

  async function handleSaveAgency() {
    setSaving(true);
    try {
      await customFetch("/api/agents/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessName }),
      });
      await qc.invalidateQueries({ queryKey: ["agent-me"] });
      toast({ title: "Agency updated", description: "Your business name has been saved." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDocUpload(field: "logoUrl" | "businessCertUrl", file: File) {
    try {
      const url = await uploadFileToStorage(file);
      await customFetch("/api/agents/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: url }),
      });
      await qc.invalidateQueries({ queryKey: ["agent-me"] });
      toast({ title: "Document uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  }

  async function handleDocRemove(field: "logoUrl" | "businessCertUrl") {
    try {
      await customFetch("/api/agents/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: "" }),
      });
      await qc.invalidateQueries({ queryKey: ["agent-me"] });
      toast({ title: "Document removed" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  if (agentLoading) {
    return (
      <Card className="border shadow-sm p-6">
        <h3 className="font-display font-semibold text-base mb-6">Agency Information</h3>
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="h-10 bg-secondary animate-pulse rounded-lg" />)}
        </div>
      </Card>
    );
  }

  if (!agentProfile) {
    return (
      <Card className="border shadow-sm p-6">
        <h3 className="font-display font-semibold text-base mb-6">Agency Information</h3>
        <div className="text-center py-12 text-muted-foreground">
          <Briefcase className="w-12 h-12 mx-auto mb-3 text-muted-foreground/20" />
          <p className="font-medium">No agency profile yet</p>
          <p className="text-sm mt-1">Your agency details will appear here once set up by an admin</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid lg:grid-cols-[1fr_280px] gap-6">
        <Card className="border shadow-sm p-6">
          <h3 className="font-display font-semibold text-base mb-5">Agency Details</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between p-3.5 rounded-lg bg-secondary/40 border border-border/50">
              <div className="flex items-center gap-3">
                <Briefcase className="w-4 h-4 text-primary" />
                <div>
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Agency Code</p>
                  <p className="text-sm font-bold text-foreground font-mono">
                    {agentProfile.agencyCode || <span className="text-muted-foreground italic font-normal text-xs">Not assigned</span>}
                  </p>
                </div>
              </div>
              <Badge variant="outline" className="text-[10px] shrink-0">Admin</Badge>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                Business Name
                {isStaff && <Lock className="w-3 h-3 text-muted-foreground/60" />}
              </Label>
              <Input
                value={businessName}
                onChange={e => !isStaff && setBusinessName(e.target.value)}
                placeholder="Your legal company name"
                className="h-10"
                disabled={isStaff}
              />
              <p className="text-[11px] text-muted-foreground">
                {isStaff
                  ? "Only the account owner can edit the business name"
                  : "Enter your registered legal company / business name"}
              </p>
            </div>

            {!isStaff && (
              <div className="flex justify-end pt-3 border-t border-border/50">
                <Button onClick={handleSaveAgency} disabled={saving} size="sm" className="gap-2 px-6">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  Save Changes
                </Button>
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-3">
          {[
            { label: "Country",         icon: MapPin,      value: agentProfile.country, color: "bg-blue-500/10 text-blue-600" },
            { label: "Commission Rate", icon: TrendingUp,  value: agentProfile.commissionRate ? `${agentProfile.commissionRate}%` : null, color: "bg-green-500/10 text-green-600" },
            { label: "Status",          icon: Check,        value: agentProfile.status, color: "bg-emerald-500/10 text-emerald-600" },
          ].map((f, i) => (
            <Card key={i} className="border shadow-sm p-4">
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-lg ${f.color} flex items-center justify-center`}>
                  <f.icon className="w-4 h-4" />
                </div>
                <div className="flex-1">
                  <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">{f.label}</p>
                  <p className="text-sm font-semibold text-foreground capitalize">
                    {f.value || <span className="text-muted-foreground italic font-normal text-xs">Not set</span>}
                  </p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Card className="border shadow-sm p-6">
        <h3 className="font-display font-semibold text-base mb-5">Documents</h3>
        <div className="grid sm:grid-cols-3 gap-5">
          <DocumentUploader
            label="Logo for Agent Panel"
            accept="image/*"
            value={agentProfile.logoUrl}
            onUpload={file => handleDocUpload("logoUrl", file)}
            onRemove={() => handleDocRemove("logoUrl")}
            icon={<ImageIcon className="w-5 h-5" />}
          />
          <DocumentViewer
            label="Contract"
            value={agentProfile.contractUrl}
            startDate={agentProfile.contractStartDate}
            endDate={agentProfile.contractEndDate}
          />
          <DocumentUploader
            label="Business Certificate"
            accept="image/*,.pdf"
            value={agentProfile.businessCertUrl}
            onUpload={file => handleDocUpload("businessCertUrl", file)}
            onRemove={() => handleDocRemove("businessCertUrl")}
            icon={<FileText className="w-5 h-5" />}
          />
        </div>
      </Card>
    </div>
  );
}

function DocumentUploader({
  label, accept, value, onUpload, onRemove, icon,
}: {
  label: string; accept: string; value?: string | null;
  onUpload: (file: File) => void; onRemove: () => void;
  icon: React.ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFile(file: File) {
    setUploading(true);
    try {
      await onUpload(file);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
      <div className="relative w-full aspect-[4/3] rounded-lg border-2 border-dashed border-border/60 hover:border-primary/40 transition-colors flex items-center justify-center overflow-hidden bg-secondary/30">
        {value ? (
          <>
            {accept.includes("image") && !value.match(/\.pdf$/i) ? (
              <img src={value} alt={label} className="max-h-full max-w-full object-contain p-2" />
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-primary">
                <FileText className="w-7 h-7" />
                <span className="text-[10px] font-medium">Uploaded</span>
              </div>
            )}
            <div className="absolute top-1.5 right-1.5 flex gap-1">
              <a href={value} target="_blank" rel="noopener noreferrer"
                className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center hover:bg-primary/90 shadow-sm">
                <Eye className="w-3 h-3" />
              </a>
              <button onClick={onRemove}
                className="w-6 h-6 rounded-full bg-destructive text-white flex items-center justify-center hover:bg-destructive/90 shadow-sm">
                <X className="w-3 h-3" />
              </button>
            </div>
          </>
        ) : (
          <button onClick={() => inputRef.current?.click()} disabled={uploading}
            className="flex flex-col items-center gap-1.5 text-muted-foreground hover:text-primary transition-colors p-4">
            {uploading ? <Loader2 className="w-5 h-5 animate-spin" /> : icon || <Upload className="w-5 h-5" />}
            <span className="text-[10px] font-medium">{uploading ? "Uploading..." : "Upload"}</span>
          </button>
        )}
      </div>
      <input ref={inputRef} type="file" accept={accept} className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
    </div>
  );
}

function DocumentViewer({
  label, value, startDate, endDate,
}: {
  label: string;
  value?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}) {
  // Derive a friendly file name from the storage URL (strip query/hash, take
  // last path segment, decode URI). Falls back to "contract" if unparseable.
  const fileName = (() => {
    if (!value) return "";
    try {
      const clean = value.split("?")[0].split("#")[0];
      const last = clean.substring(clean.lastIndexOf("/") + 1);
      return decodeURIComponent(last) || "contract";
    } catch {
      return "contract";
    }
  })();

  function fmtDate(d?: string | null) {
    if (!d) return null;
    try {
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return d;
      return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`;
    } catch {
      return d;
    }
  }

  const start = fmtDate(startDate);
  const end = fmtDate(endDate);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs font-medium text-muted-foreground">{label}</Label>
        <Badge variant="outline" className="text-[9px] px-1.5 py-0">Admin Only</Badge>
      </div>
      <div className="relative w-full aspect-[4/3] rounded-lg border-2 border-dashed border-border/60 bg-secondary/30 flex items-center justify-center overflow-hidden">
        {value ? (
          <>
            {value.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i) ? (
              <img src={value} alt={label} className="max-h-full max-w-full object-contain p-2" />
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-green-600 px-3 text-center">
                <FileText className="w-7 h-7" />
                <span className="text-[10px] font-medium break-all line-clamp-2" title={fileName}>{fileName}</span>
              </div>
            )}
            <div className="absolute top-1.5 right-1.5">
              <a href={value} target="_blank" rel="noopener noreferrer" download={fileName}
                className="w-6 h-6 rounded-full bg-primary text-white flex items-center justify-center hover:bg-primary/90 shadow-sm">
                <Download className="w-3 h-3" />
              </a>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground/40 p-4">
            <FileText className="w-7 h-7" />
            <span className="text-[10px] font-medium text-center">No contract<br />Uploaded by admin</span>
          </div>
        )}
      </div>
      {value && (
        <div className="space-y-0.5">
          <p className="text-[11px] font-medium text-foreground break-all" title={fileName}>{fileName}</p>
          {(start || end) && (
            <p className="text-[10px] text-muted-foreground">
              {start ? `Start: ${start}` : ""}
              {start && end ? "  ·  " : ""}
              {end ? `End: ${end}` : ""}
            </p>
          )}
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            download={fileName}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
          >
            <Download className="w-3 h-3" />
            Download
          </a>
        </div>
      )}
    </div>
  );
}

function WebToLeadTab() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { data: tokenData, isLoading } = useQuery<{ embedToken: string }>({
    queryKey: ["embed-token"],
    queryFn: () => customFetch(`/api/agents/me/embed-token`) as Promise<{ embedToken: string }>,
  });

  const apiDomain = window.location.origin;
  const token = tokenData?.embedToken || "";

  const formCode = `<form action="${apiDomain}/api/public/lead/${token}" method="POST" style="max-width:440px;margin:0 auto;font-family:system-ui,-apple-system,sans-serif;padding:32px;border-radius:16px;background:#ffffff;box-shadow:0 4px 24px rgba(0,0,0,0.08);border:1px solid #e5e7eb" onsubmit="var ins=this.querySelectorAll('input[type=text]');for(var i=0;i<ins.length;i++){ins[i].value=ins[i].value.toUpperCase();}">
  <h3 style="margin:0 0 4px;font-size:20px;font-weight:700;color:#111827;text-align:center">Get in Touch</h3>
  <p style="margin:0 0 20px;font-size:13px;color:#6b7280;text-align:center">Fill in your details and we'll contact you shortly.</p>
  <div style="display:flex;gap:10px;margin-bottom:14px">
    <div style="flex:1">
      <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">First Name <span style="color:#ef4444">*</span></label>
      <input name="firstName" type="text" required pattern="[A-Za-z\\u00C0-\\u017F\\s'-]+" title="Latin characters only" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;text-transform:uppercase;transition:border-color 0.2s" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#d1d5db'" />
    </div>
    <div style="flex:1">
      <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Last Name <span style="color:#ef4444">*</span></label>
      <input name="lastName" type="text" required pattern="[A-Za-z\\u00C0-\\u017F\\s'-]+" title="Latin characters only" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;text-transform:uppercase;transition:border-color 0.2s" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#d1d5db'" />
    </div>
  </div>
  <div style="margin-bottom:14px">
    <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Phone <span style="color:#ef4444">*</span></label>
    <div style="display:flex;gap:6px">
      <select name="phoneCode" style="width:90px;padding:10px 6px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;outline:none;cursor:pointer">
        <option value="+90">🇹🇷 +90</option><option value="+1">🇺🇸 +1</option><option value="+44">🇬🇧 +44</option><option value="+49">🇩🇪 +49</option><option value="+33">🇫🇷 +33</option><option value="+39">🇮🇹 +39</option><option value="+34">🇪🇸 +34</option><option value="+31">🇳🇱 +31</option><option value="+46">🇸🇪 +46</option><option value="+41">🇨🇭 +41</option><option value="+7">🇷🇺 +7</option><option value="+380">🇺🇦 +380</option><option value="+86">🇨🇳 +86</option><option value="+91">🇮🇳 +91</option><option value="+92">🇵🇰 +92</option><option value="+93">🇦🇫 +93</option><option value="+966">🇸🇦 +966</option><option value="+971">🇦🇪 +971</option><option value="+964">🇮🇶 +964</option><option value="+98">🇮🇷 +98</option><option value="+962">🇯🇴 +962</option><option value="+961">🇱🇧 +961</option><option value="+20">🇪🇬 +20</option><option value="+212">🇲🇦 +212</option><option value="+234">🇳🇬 +234</option><option value="+55">🇧🇷 +55</option><option value="+61">🇦🇺 +61</option><option value="+81">🇯🇵 +81</option><option value="+82">🇰🇷 +82</option><option value="+60">🇲🇾 +60</option><option value="+65">🇸🇬 +65</option><option value="+880">🇧🇩 +880</option>
      </select>
      <input name="phoneNumber" type="tel" required placeholder="555 000 0000" style="flex:1;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;transition:border-color 0.2s" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#d1d5db'" />
      <input type="hidden" name="phone" />
    </div>
  </div>
  <div style="margin-bottom:20px">
    <label style="display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px">Email <span style="color:#ef4444">*</span></label>
    <input name="email" type="email" required placeholder="you@example.com" style="width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;box-sizing:border-box;outline:none;transition:border-color 0.2s" onfocus="this.style.borderColor='#3b82f6'" onblur="this.style.borderColor='#d1d5db'" />
  </div>
  <button type="submit" style="width:100%;padding:12px;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;transition:opacity 0.2s" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'" onclick="var f=this.closest('form');f.phone.value=f.phoneCode.value+f.phoneNumber.value;">Submit</button>
  <p style="margin:12px 0 0;font-size:11px;color:#9ca3af;text-align:center">Your information is secure and will not be shared.</p>
</form>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(formCode);
    setCopied(true);
    toast({ title: "Copied!", description: "Form code copied to clipboard." });
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <Card className="border shadow-sm p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <Code className="w-4 h-4 text-blue-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("agentAccount.webToLeadTitle")}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          {t("agentAccount.webToLeadDesc")}
        </p>

        <div className="relative">
          <div className="absolute top-3 right-3 z-10">
            <Button size="sm" variant="secondary" onClick={handleCopy} className="gap-1.5 text-xs shadow-sm">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? t("agentAccount.copied") : t("agentAccount.copyCode")}
            </Button>
          </div>
          <pre className="bg-secondary/50 border rounded-xl p-4 pr-28 text-xs text-foreground/80 overflow-x-auto whitespace-pre-wrap break-all max-h-72 overflow-y-auto font-mono leading-relaxed">
            {formCode}
          </pre>
        </div>
      </Card>

      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
            <Eye className="w-4 h-4 text-green-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("agentAccount.formPreview")}</h3>
        </div>
        <div className="bg-secondary/30 rounded-xl p-4">
          <iframe
            title={t("agentAccount.formPreview")}
            srcDoc={formCode}
            sandbox=""
            referrerPolicy="no-referrer"
            className="w-full min-h-[640px] rounded-xl border bg-white"
          />
        </div>
      </Card>

      <Card className="border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ExternalLink className="w-4 h-4 text-amber-600" />
          </div>
          <h3 className="font-display font-semibold text-base">{t("agentAccount.howToUse")}</h3>
        </div>
        <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
          <li>{t("agentAccount.howToStep1")}</li>
          <li>{t("agentAccount.howToStep2")}</li>
          <li>{t("agentAccount.howToStep3")}</li>
          <li>{t("agentAccount.howToStep4")}</li>
          <li>{t("agentAccount.howToStep5")}</li>
        </ol>
      </Card>
    </div>
  );
}
