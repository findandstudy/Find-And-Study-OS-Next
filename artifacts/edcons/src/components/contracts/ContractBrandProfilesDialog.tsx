import { useEffect, useState } from "react";
import { Edit, FileCheck2, Loader2, Plus, Power, ShieldCheck, Trash2, Upload } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

export type ContractBrandConfig = {
  brandName: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  pageTitle: string;
  pageSubtitle: string;
  pdfHeaderText: string;
  pdfFooterText: string;
  companySignatureDataUrl: string;
};

export type ContractBrandProfile = {
  id: number;
  key: string;
  name: string;
  config: Partial<ContractBrandConfig>;
  hasCompanySignature: boolean;
  isActive: boolean;
};

const EMPTY_CONFIG: ContractBrandConfig = {
  brandName: "",
  logoUrl: "",
  primaryColor: "#143591",
  accentColor: "#0f766e",
  pageTitle: "",
  pageSubtitle: "",
  pdfHeaderText: "",
  pdfFooterText: "",
  companySignatureDataUrl: "",
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profiles: ContractBrandProfile[];
  onChanged: () => Promise<void> | void;
};

export function ContractBrandProfilesDialog({ open, onOpenChange, profiles, onChanged }: Props) {
  const { toast } = useToast();
  const [editing, setEditing] = useState<ContractBrandProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [signatureAction, setSignatureAction] = useState<"unchanged" | "replace" | "remove">("unchanged");
  const [form, setForm] = useState({ key: "", name: "", config: EMPTY_CONFIG, isActive: true });

  useEffect(() => {
    if (!open) setEditing(null);
  }, [open]);

  function reset() {
    setEditing(null);
    setSignatureAction("unchanged");
    setForm({ key: "", name: "", config: EMPTY_CONFIG, isActive: true });
  }

  function edit(profile: ContractBrandProfile) {
    setEditing(profile);
    setSignatureAction("unchanged");
    setForm({
      key: profile.key,
      name: profile.name,
      isActive: profile.isActive,
      config: { ...EMPTY_CONFIG, ...profile.config },
    });
  }

  function loadCompanySignature(file?: File) {
    if (!file) return;
    if (!(["image/png", "image/jpeg"].includes(file.type))) {
      toast({ title: "PNG or JPEG required", description: "Upload the official stamp/signature as a PNG or JPEG image.", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Signature image is too large", description: "Maximum file size is 2 MB.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setSignatureAction("replace");
      setForm(current => ({
        ...current,
        config: { ...current.config, companySignatureDataUrl: String(reader.result || "") },
      }));
    };
    reader.onerror = () => toast({ title: "Signature image could not be read", variant: "destructive" });
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!form.key.trim() || !form.name.trim()) {
      toast({ title: "Brand key and name are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const config: Record<string, unknown> = { ...form.config };
      if (editing && signatureAction === "unchanged") delete config.companySignatureDataUrl;
      if (signatureAction === "remove") config.companySignatureDataUrl = "";
      await customFetch(editing ? `/api/contract-brands/${editing.id}` : "/api/contract-brands", {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, config }),
      });
      toast({ title: editing ? "Brand profile updated" : "Brand profile created" });
      reset();
      await onChanged();
    } catch (error: any) {
      toast({ title: "Brand profile could not be saved", description: error.message, variant: "destructive" });
    }
    setSaving(false);
  }

  async function deactivate(profile: ContractBrandProfile) {
    if (!confirm(`Deactivate ${profile.name}? Existing contracts keep their saved branding snapshot.`)) return;
    try {
      await customFetch(`/api/contract-brands/${profile.id}`, { method: "DELETE" });
      await onChanged();
    } catch (error: any) {
      toast({ title: "Brand profile could not be deactivated", description: error.message, variant: "destructive" });
    }
  }

  const configFields: Array<[keyof ContractBrandConfig, string, string]> = [
    ["brandName", "Displayed brand name", "Find And Study"],
    ["logoUrl", "Logo URL", "https://…/logo.png"],
    ["pageTitle", "Signing page title", "Agency Information"],
    ["pageSubtitle", "Signing page subtitle", "Please complete your details"],
    ["pdfHeaderText", "PDF header", "Official agreement"],
    ["pdfFooterText", "PDF footer", "Company contact / legal text"],
  ];
  const signatureConfigured = Boolean(form.config.companySignatureDataUrl)
    || Boolean(editing?.hasCompanySignature && signatureAction === "unchanged");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Contract brand profiles</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground">Manage reusable signing-page and PDF branding once, then assign it to any contract template.</p>
        <div className="grid grid-cols-1 lg:grid-cols-[.9fr_1.1fr] gap-5">
          <div className="space-y-2">
            {profiles.length === 0 && <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground text-center">No brand profiles yet.</div>}
            {profiles.map(profile => (
              <div key={profile.id} className="rounded-lg border p-3 flex items-center gap-3">
                {profile.config.logoUrl ? <img src={profile.config.logoUrl} alt="" className="h-10 w-14 object-contain rounded border" /> : <div className="h-10 w-14 rounded border" style={{ background: profile.config.primaryColor || "#143591" }} />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{profile.name}</div>
                  <div className="text-xs text-muted-foreground font-mono">{profile.key} · {profile.isActive ? "active" : "inactive"}</div>
                  <div className={`mt-1 inline-flex items-center gap-1 text-xs ${profile.hasCompanySignature ? "text-emerald-600" : "text-amber-600"}`}>
                    {profile.hasCompanySignature ? <FileCheck2 className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    {profile.hasCompanySignature ? "Official signature configured" : "Official signature required"}
                  </div>
                </div>
                <Button type="button" size="icon" variant="ghost" onClick={() => edit(profile)}><Edit className="h-4 w-4" /></Button>
                {profile.isActive && <Button type="button" size="icon" variant="ghost" onClick={() => deactivate(profile)}><Trash2 className="h-4 w-4 text-destructive" /></Button>}
              </div>
            ))}
          </div>
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">{editing ? `Edit ${editing.name}` : "New brand profile"}</h3>
              {editing && <Button type="button" size="sm" variant="ghost" onClick={reset}><Plus className="h-4 w-4 mr-1" /> New</Button>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Key</Label><Input value={form.key} onChange={event => setForm(current => ({ ...current, key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }))} placeholder="find_and_study" /></div>
              <div><Label>Name</Label><Input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="Find And Study" /></div>
            </div>
            {configFields.map(([key, label, placeholder]) => (
              <div key={key}><Label>{label}</Label><Input value={String(form.config[key] || "")} placeholder={placeholder} onChange={event => setForm(current => ({ ...current, config: { ...current.config, [key]: event.target.value } }))} /></div>
            ))}
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Primary color</Label><Input type="color" className="h-10 p-1" value={form.config.primaryColor} onChange={event => setForm(current => ({ ...current, config: { ...current.config, primaryColor: event.target.value } }))} /></div>
              <div><Label>Accent color</Label><Input type="color" className="h-10 p-1" value={form.config.accentColor} onChange={event => setForm(current => ({ ...current, config: { ...current.config, accentColor: event.target.value } }))} /></div>
            </div>
            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="h-5 w-5 mt-0.5 text-primary" />
                <div>
                  <Label>Official company stamp & signature</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Private. It is never shown during form entry or review; it is added only to the final PDF after the counterparty signs.</p>
                </div>
              </div>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-sm hover:bg-muted/50">
                <Upload className="h-4 w-4" />
                {signatureConfigured ? "Replace stamp/signature" : "Upload stamp/signature"}
                <input className="sr-only" type="file" accept="image/png,image/jpeg" onChange={event => loadCompanySignature(event.target.files?.[0])} />
              </label>
              {form.config.companySignatureDataUrl ? (
                <div className="rounded-md border bg-white p-3">
                  <img src={form.config.companySignatureDataUrl} alt="Official company stamp and signature preview" className="mx-auto h-24 max-w-full object-contain" />
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><FileCheck2 className="h-3.5 w-3.5" /> Ready for final PDFs</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => { setSignatureAction("remove"); setForm(current => ({ ...current, config: { ...current.config, companySignatureDataUrl: "" } })); }}>Remove</Button>
                  </div>
                </div>
              ) : signatureConfigured ? (
                <div className="rounded-md border bg-emerald-50 p-3 text-sm text-emerald-800">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1"><FileCheck2 className="h-4 w-4" /> Official signature is securely configured</span>
                    <Button type="button" size="sm" variant="outline" onClick={() => setSignatureAction("remove")}>Remove</Button>
                  </div>
                  <p className="mt-1 text-xs">The saved image is intentionally not returned by the API. Upload a replacement to change it.</p>
                </div>
              ) : (
                <p className="text-xs text-amber-700">A template using this profile cannot be published until an official signature is uploaded.</p>
              )}
            </div>
            <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isActive} onChange={event => setForm(current => ({ ...current, isActive: event.target.checked }))} /><Power className="h-4 w-4" /> Active</label>
            <Button type="button" onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{editing ? "Save brand profile" : "Create brand profile"}</Button>
          </div>
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
