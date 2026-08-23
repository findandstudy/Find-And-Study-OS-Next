import { useState, useEffect, useRef, useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import {
  Users, Plus, Search, Edit, Trash2, X, Loader2, Save,
  Building2, Mail, Phone, MapPin, Upload, Eye, EyeOff,
  ChevronLeft, ChevronRight, UserPlus, Network,
  MoreHorizontal, KeyRound, LogIn, Power, ShieldCheck, ShieldOff,
  ArrowUpDown, ArrowUp, ArrowDown,
} from "lucide-react";
import { CountryFlag } from "@/components/CountryFlag";
import { ExportImportToolbar } from "@/components/admin/ExportImportToolbar";
import { QuickContactButtons } from "@/components/QuickContact";
import { ColumnHeader } from "@/components/ui/column-header";
import { useI18n } from "@/hooks/use-i18n";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

function fixStorageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace(/\/api\/storage\/objects\/objects\//, "/api/storage/objects/");
}

import { MANAGER_ROLES as _MANAGER_ROLES } from "@workspace/roles";
const MANAGER_ROLES = _MANAGER_ROLES;
const CATEGORIES = ["Big", "Medium", "Small"];

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

type Agent = {
  id: number;
  userId: number | null;
  parentAgentId: number | null;
  agencyCode: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  state: string | null;
  city: string | null;
  address: string | null;
  companyName: string | null;
  businessName: string | null;
  category: string | null;
  commissionRate: number | null;
  subAgentCommissionRate: number | null;
  hideServiceFees: boolean;
  status: string;
  logoUrl: string | null;
  agentIdProofUrl: string | null;
  businessCertUrl: string | null;
  contractUrl: string | null;
  contractStartDate: string | null;
  contractEndDate: string | null;
  branch: string | null;
  branchIds?: number[];
  notes: string | null;
  createdAt: string;
  assignedStaffId: number | null;
  assignedStaffName: string | null;
  assignedStaffList?: Array<{ userId: number; isPrimary: boolean; firstName: string | null; lastName: string | null; role: string | null }>;
};

const emptyForm = {
  agencyCode: "", firstName: "", lastName: "", email: "", phone: "", phoneCode: "+90",
  country: "", state: "", city: "", address: "",
  businessName: "", category: "", commissionRate: "",
  logoUrl: "", agentIdProofUrl: "", businessCertUrl: "", contractUrl: "",
  contractStartDate: "", contractEndDate: "",
  branch: "", notes: "",
  parentAgentId: "", subAgentCommissionRate: "", hideServiceFees: false,
  assignedStaff: [] as Array<{ userId: number; isPrimary: boolean }>,
  branchIds: [] as number[],
  entityType: "company", taxNumber: "", preferredContractLanguage: "",
  assignedContractTemplateId: "",
};

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

export default function AgentsPage() {
  const { t } = useI18n();
  const { user } = useAuth(true);
  const { toast } = useToast();
  const isManager = MANAGER_ROLES.includes(user?.role || "");

  const [activeTab, setActiveTab] = useState("agents");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [subAgents, setSubAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [subSearch, setSubSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState("all");
  const [subCountryFilter, setSubCountryFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [subPage, setSubPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [subTotalPages, setSubTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [subTotal, setSubTotal] = useState(0);

  const [showDialog, setShowDialog] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [isSubAgent, setIsSubAgent] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [idProofUploading, setIdProofUploading] = useState(false);
  const [certUploading, setCertUploading] = useState(false);
  const [contractUploading, setContractUploading] = useState(false);
  const logoRef = useRef<HTMLInputElement>(null);
  const idProofRef = useRef<HTMLInputElement>(null);
  const certRef = useRef<HTMLInputElement>(null);
  const contractRef = useRef<HTMLInputElement>(null);

  const [parentAgents, setParentAgents] = useState<Agent[]>([]);
  const [branchOptions, setBranchOptions] = useState<{ id: number; name: string }[]>([]);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [staffMembers, setStaffMembers] = useState<{ id: number; firstName: string; lastName: string; role: string }[]>([]);
  const [countries, setCountries] = useState<{ id: number; name: string; code: string }[]>([]);
  const [cities, setCities] = useState<{ id: number; name: string }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [subSelectedIds, setSubSelectedIds] = useState<Set<number>>(new Set());
  const [passwordDialog, setPasswordDialog] = useState<{ agentId: number; agentName: string } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [resendingCredentials, setResendingCredentials] = useState<Set<number>>(new Set());

  async function fetchCountries() {
    try {
      const res: any = await customFetch(`/api/countries?limit=300`);
      setCountries(res.data || []);
    } catch {}
  }

  async function fetchCities(countryId: number) {
    try {
      const res: any = await customFetch(`/api/cities?countryId=${countryId}&limit=500`);
      setCities(res.data || []);
    } catch {}
  }

  async function fetchAgents() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type: "agent", page: String(page), limit: "20", search });
      if (countryFilter !== "all") params.set("country", countryFilter);
      const res: any = await customFetch(`/api/agents?${params}`);
      setAgents(res.data);
      setTotal(res.meta.total);
      setTotalPages(res.meta.totalPages);
    } catch {}
    setLoading(false);
  }

  async function fetchSubAgents() {
    try {
      const params = new URLSearchParams({ type: "sub_agent", page: String(subPage), limit: "20", search: subSearch });
      if (subCountryFilter !== "all") params.set("country", subCountryFilter);
      const res: any = await customFetch(`/api/agents?${params}`);
      setSubAgents(res.data);
      setSubTotal(res.meta.total);
      setSubTotalPages(res.meta.totalPages);
    } catch {}
  }

  async function fetchParentAgents() {
    try {
      const res: any = await customFetch(`/api/agents?type=agent&limit=100`);
      setParentAgents(res.data);
    } catch {}
  }

  async function fetchStaffMembers() {
    try {
      const res: any = await customFetch(`/api/users?limit=100`);
      const staff = (res.data || []).filter((u: any) =>
        ["super_admin", "admin", "manager", "staff", "consultant"].includes(u.role) && u.isActive !== false
      );
      setStaffMembers(staff);
    } catch {}
  }

  useEffect(() => { fetchAgents(); }, [page, search, countryFilter]);
  useEffect(() => { fetchSubAgents(); }, [subPage, subSearch, subCountryFilter]);
  // Keep the admin view fresh: refetch on window focus and when tab regains
  // visibility, so business-name (and other) edits made by the agent show up
  // without a hard reload.
  useEffect(() => {
    function refresh() { fetchAgents(); fetchSubAgents(); }
    function onVisible() { if (document.visibilityState === "visible") refresh(); }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [page, search, countryFilter, subPage, subSearch, subCountryFilter]);
  async function fetchBranchOptions() {
    try {
      const res: any = await customFetch(`/api/branches?archived=0`);
      setBranchOptions((res.data || []).map((b: any) => ({ id: b.id, name: b.name })));
    } catch {}
  }

  useEffect(() => { fetchParentAgents(); fetchCountries(); fetchStaffMembers(); fetchBranchOptions(); }, []);

  function openCreate(isSub: boolean) {
    setEditingAgent(null);
    setIsSubAgent(isSub);
    setForm({ ...emptyForm });
    setCities([]);
    setShowDialog(true);
  }

  function seedFormFromAgent(agent: Agent) {
    setEditingAgent(agent);
    setIsSubAgent(!!agent.parentAgentId);
    const { code, number } = splitPhone(agent.phone);
    setForm({
      agencyCode: agent.agencyCode || "",
      firstName: agent.firstName,
      lastName: agent.lastName,
      email: agent.email || "",
      phone: number,
      phoneCode: code,
      country: agent.country || "",
      state: agent.state || "",
      city: agent.city || "",
      address: agent.address || "",
      businessName: agent.businessName || "",
      category: agent.category || "",
      commissionRate: agent.commissionRate?.toString() || "",
      logoUrl: agent.logoUrl || "",
      agentIdProofUrl: agent.agentIdProofUrl || "",
      businessCertUrl: agent.businessCertUrl || "",
      contractUrl: agent.contractUrl || "",
      contractStartDate: agent.contractStartDate ? agent.contractStartDate.split("T")[0] : "",
      contractEndDate: agent.contractEndDate ? agent.contractEndDate.split("T")[0] : "",
      branch: agent.branch || "",
      branchIds: Array.isArray(agent.branchIds) ? agent.branchIds : [],
      notes: agent.notes || "",
      parentAgentId: agent.parentAgentId?.toString() || "",
      subAgentCommissionRate: agent.subAgentCommissionRate?.toString() || "",
      hideServiceFees: agent.hideServiceFees,
      assignedStaff: Array.isArray((agent as any).assignedStaffList) && (agent as any).assignedStaffList.length > 0
        ? (agent as any).assignedStaffList.map((s: any) => ({ userId: s.userId, isPrimary: !!s.isPrimary }))
        : (agent.assignedStaffId ? [{ userId: agent.assignedStaffId, isPrimary: true }] : []),
      entityType: (agent as any).entityType || "company",
      taxNumber: (agent as any).taxNumber || "",
      preferredContractLanguage: (agent as any).preferredContractLanguage || "",
      assignedContractTemplateId: (agent as any).assignedContractTemplateId?.toString() || "",
    });
    if (agent.country) {
      const c = countries.find(ct => ct.name === agent.country);
      if (c) fetchCities(c.id);
      else setCities([]);
    } else {
      setCities([]);
    }
  }

  const openEditTokenRef = useRef(0);
  async function openEdit(agent: Agent) {
    // Seed immediately from the row snapshot so the dialog opens instantly,
    // then refetch the live row so values edited by the agent (e.g. business
    // name, logo) appear without requiring a hard reload.
    const token = ++openEditTokenRef.current;
    seedFormFromAgent(agent);
    setShowDialog(true);
    try {
      const fresh: any = await customFetch(`/api/agents/${agent.id}`);
      if (token !== openEditTokenRef.current) return; // stale response, ignore
      if (fresh && fresh.id) {
        seedFormFromAgent(fresh as Agent);
        setAgents(prev => prev.map(a => a.id === fresh.id ? { ...a, ...fresh } : a));
        setSubAgents(prev => prev.map(a => a.id === fresh.id ? { ...a, ...fresh } : a));
      }
    } catch {}
  }

  async function uploadFile(file: File, field: string, setUploading: (v: boolean) => void) {
    setUploading(true);
    try {
      const urlRes: any = await customFetch(`/api/storage/uploads/request-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.uploadURL) throw new Error("No upload URL");
      const putRes = await fetch(urlRes.uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      if (!putRes.ok) throw new Error("Upload failed");
      const strippedPath = urlRes.objectPath.replace(/^\/objects/, "");
      const publicUrl = `${BASE_URL}/api/storage/objects${strippedPath}`;
      setForm(f => ({ ...f, [field]: publicUrl }));
      toast({ title: "File uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast({ title: "Error", description: "First Name and Last Name are required.", variant: "destructive" });
      return;
    }
    if (!form.email.trim()) {
      toast({ title: "Error", description: "Email is required.", variant: "destructive" });
      return;
    }
    if (isSubAgent && !form.parentAgentId) {
      toast({ title: "Error", description: "Parent Agent is required for sub-agents.", variant: "destructive" });
      return;
    }

    setSaving(true);
    const phone = form.phone.trim() ? `${form.phoneCode}${form.phone.trim()}` : "";
    const body: Record<string, any> = {
      agencyCode: form.agencyCode.trim() || null,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      phone: phone || null,
      country: form.country.trim() || null,
      state: form.state.trim() || null,
      city: form.city.trim() || null,
      address: form.address.trim() || null,
      businessName: form.businessName.trim() || null,
      category: form.category || null,
      commissionRate: form.commissionRate ? parseFloat(form.commissionRate) : null,
      logoUrl: form.logoUrl || null,
      agentIdProofUrl: form.agentIdProofUrl || null,
      businessCertUrl: form.businessCertUrl || null,
      contractUrl: form.contractUrl || null,
      contractStartDate: form.contractStartDate || null,
      contractEndDate: form.contractEndDate || null,
      branch: form.branch.trim() || null,
      branchIds: Array.isArray(form.branchIds) ? form.branchIds : [],
      notes: form.notes.trim() || null,
      parentAgentId: isSubAgent && form.parentAgentId ? parseInt(form.parentAgentId) : null,
      subAgentCommissionRate: form.subAgentCommissionRate ? parseFloat(form.subAgentCommissionRate) : null,
      hideServiceFees: form.hideServiceFees,
      assignedStaff: !isSubAgent ? form.assignedStaff : [],
      entityType: form.entityType || "company",
      taxNumber: form.taxNumber.trim() || null,
      preferredContractLanguage: form.preferredContractLanguage || null,
      assignedContractTemplateId: form.assignedContractTemplateId ? parseInt(form.assignedContractTemplateId, 10) : null,
    };

    try {
      if (editingAgent) {
        await customFetch(`/api/agents/${editingAgent.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast({ title: "Agent updated" });
      } else {
        await customFetch(`/api/agents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast({ title: isSubAgent ? "Sub-agent created" : "Agent created" });
      }
      setShowDialog(false);
      fetchAgents();
      fetchSubAgents();
      fetchParentAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleAssignStaff(agentId: number, staffId: number | null) {
    try {
      await customFetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedStaffId: staffId }),
      });
      toast({ title: staffId ? "Contact person assigned" : "Contact person removed" });
      fetchAgents();
      fetchSubAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleBulkAssignStaff(ids: Set<number>, staffId: number | null) {
    if (ids.size === 0) return;
    try {
      await customFetch(`/api/agents/bulk-assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(ids), assignedStaffId: staffId }),
      });
      const staffName = staffId ? staffMembers.find(s => s.id === staffId) : null;
      toast({ title: staffId ? `Contact person assigned to ${ids.size} agent(s)` : `Contact person removed from ${ids.size} agent(s)` });
      setSelectedIds(new Set());
      setSubSelectedIds(new Set());
      fetchAgents();
      fetchSubAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("Are you sure you want to delete this agent?")) return;
    try {
      await customFetch(`/api/agents/${id}`, { method: "DELETE" });
      toast({ title: "Agent deleted" });
      setSelectedIds(s => { const n = new Set(s); n.delete(id); return n; });
      setSubSelectedIds(s => { const n = new Set(s); n.delete(id); return n; });
      fetchAgents();
      fetchSubAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleBulkDelete(ids: Set<number>) {
    if (ids.size === 0) return;
    if (!confirm(`Are you sure you want to delete ${ids.size} agent(s)?`)) return;
    try {
      await customFetch(`/api/agents/bulk-delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(ids) }),
      });
      toast({ title: `${ids.size} agent(s) deleted` });
      setSelectedIds(new Set());
      setSubSelectedIds(new Set());
      fetchAgents();
      fetchSubAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleToggleStatus(agent: Agent) {
    const newStatus = agent.status === "active" ? "inactive" : "active";
    try {
      await customFetch(`/api/agents/${agent.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      toast({ title: `Agent ${newStatus === "active" ? "activated" : "deactivated"}` });
      fetchAgents();
      fetchSubAgents();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleSetPassword() {
    if (!passwordDialog) return;
    setPasswordSaving(true);
    try {
      await customFetch(`/api/agents/${passwordDialog.agentId}/set-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      toast({ title: "Password updated" });
      setPasswordDialog(null);
      setNewPassword("");
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setPasswordSaving(false);
    }
  }

  async function handleImpersonate(agent: Agent) {
    if (!confirm(`Login as ${agent.firstName} ${agent.lastName}? You will be logged out of your current session.`)) return;
    try {
      const res: any = await customFetch(`/api/agents/${agent.id}/impersonate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.redirectTo) {
        const base = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
        window.location.href = `${base}${res.redirectTo}`;
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  async function handleResendCredentials(agent: Agent) {
    if (!confirm(t("staffAgents.resendCredentialsConfirm", { name: `${agent.firstName} ${agent.lastName}` }))) return;
    setResendingCredentials(prev => new Set(prev).add(agent.id));
    try {
      const res: any = await customFetch(`/api/agents/${agent.id}/resend-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.emailSent) {
        toast({ title: t("staffAgents.resendCredentialsSent"), description: `${agent.firstName} ${agent.lastName}` });
      } else {
        toast({ title: t("staffAgents.resendCredentialsQueued"), description: `${agent.firstName} ${agent.lastName}`, variant: "default" });
      }
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setResendingCredentials(prev => { const s = new Set(prev); s.delete(agent.id); return s; });
    }
  }

  function toggleSelect(id: number, selected: Set<number>, setSelected: React.Dispatch<React.SetStateAction<Set<number>>>) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(data: Agent[], selected: Set<number>, setSelected: React.Dispatch<React.SetStateAction<Set<number>>>) {
    if (data.every(a => selected.has(a.id))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(data.map(a => a.id)));
    }
  }

  function getParentName(parentId: number | null) {
    if (!parentId) return "-";
    const p = parentAgents.find(a => a.id === parentId);
    return p ? `${p.firstName} ${p.lastName}` : `#${parentId}`;
  }

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      active: "bg-green-500/10 text-green-600 border-green-200",
      inactive: "bg-gray-500/10 text-gray-600 border-gray-200",
      suspended: "bg-red-500/10 text-red-600 border-red-200",
    };
    return colors[s] || "bg-gray-500/10 text-gray-600 border-gray-200";
  };

  function getContractStatus(agent: Agent): { label: string; color: string; daysLeft: number | null } {
    if (!agent.contractEndDate) return { label: "", color: "", daysLeft: null };
    const now = new Date();
    const end = new Date(agent.contractEndDate);
    const diffMs = end.getTime() - now.getTime();
    const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (daysLeft <= 0) return { label: "Expired", color: "bg-red-500/10 text-red-600 border-red-300", daysLeft };
    if (daysLeft <= 60) return { label: "Expiring Soon", color: "bg-orange-500/10 text-orange-600 border-orange-300", daysLeft };
    return { label: "Active", color: "bg-green-500/10 text-green-600 border-green-200", daysLeft };
  }

  type AgentSortKey = "agent" | "contact" | "category" | "commission" | "status" | "parent" | "country" | "contactPerson";
  type AgentSortDir = "asc" | "desc";

  function AgentSortHeader({ label, sortKey, currentSort, onSort, className }: {
    label: string; sortKey: AgentSortKey; currentSort: { key: AgentSortKey; dir: AgentSortDir }; onSort: (k: AgentSortKey) => void; className?: string;
  }) {
    const active = currentSort.key === sortKey;
    return (
      <>
      <th className={`py-3 px-3 font-semibold text-muted-foreground cursor-pointer select-none hover:bg-muted/50 transition-colors ${className || ""}`}
        onClick={() => onSort(sortKey)}>
        <div className="flex items-center gap-1.5">
          {label}
          {active ? (currentSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 text-muted-foreground/50" />}
        </div>
      </th>
      </>
    );
  }

  function AgentTable({ data, showParent }: { data: Agent[]; showParent?: boolean }) {
    const selected = showParent ? subSelectedIds : selectedIds;
    const setSelected = showParent ? setSubSelectedIds : setSelectedIds;
    const [agentSort, setAgentSort] = useState<{ key: AgentSortKey; dir: AgentSortDir }>({ key: "agent", dir: "asc" });
    const [agentColFilters, setAgentColFilters] = useState({ agent: "", contact: "", country: "all", category: "all", contactPerson: "all", status: "all" });

    function handleAgentSort(key: AgentSortKey) {
      setAgentSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
    }

    const uniqueAgentCountries = useMemo(() => {
      const set = new Set<string>();
      data.forEach(a => { if (a.country) set.add(a.country); });
      return Array.from(set).sort();
    }, [data]);
    const uniqueAgentCategories = useMemo(() => {
      const set = new Set<string>();
      data.forEach(a => { if (a.category) set.add(a.category); });
      return Array.from(set).sort();
    }, [data]);
    const uniqueContactPersons = useMemo(() => {
      const m = new Map<string, string>();
      data.forEach(a => { if (a.assignedStaffName) m.set(a.assignedStaffName, a.assignedStaffName); });
      return Array.from(m.values()).sort();
    }, [data]);
    const uniqueAgentStatuses = useMemo(() => {
      const set = new Set<string>();
      data.forEach(a => { if (a.status) set.add(a.status); });
      return Array.from(set).sort();
    }, [data]);

    const filteredData = data.filter(a => {
      if (agentColFilters.agent) {
        const fn = `${a.firstName || ""} ${a.lastName || ""} ${a.businessName || ""}`.toLowerCase();
        if (!fn.includes(agentColFilters.agent.toLowerCase())) return false;
      }
      if (agentColFilters.contact && !`${a.email || ""} ${a.phone || ""}`.toLowerCase().includes(agentColFilters.contact.toLowerCase())) return false;
      if (agentColFilters.country !== "all" && (a.country || "") !== agentColFilters.country) return false;
      if (agentColFilters.category !== "all" && (a.category || "") !== agentColFilters.category) return false;
      if (agentColFilters.contactPerson !== "all" && (a.assignedStaffName || "") !== agentColFilters.contactPerson) return false;
      if (agentColFilters.status !== "all" && (a.status || "") !== agentColFilters.status) return false;
      return true;
    });

    const allChecked = filteredData.length > 0 && filteredData.every(a => selected.has(a.id));
    const someChecked = filteredData.some(a => selected.has(a.id));

    const sortedData = [...filteredData].sort((a, b) => {
      const dir = agentSort.dir === "asc" ? 1 : -1;
      switch (agentSort.key) {
        case "agent": { const nameA = `${a.firstName} ${a.lastName}`; const nameB = `${b.firstName} ${b.lastName}`; return dir * nameA.localeCompare(nameB); }
        case "contact": return dir * ((a.email || "").localeCompare(b.email || ""));
        case "parent": return dir * (getParentName(a.parentAgentId).localeCompare(getParentName(b.parentAgentId)));
        case "category": return dir * ((a.category || "").localeCompare(b.category || ""));
        case "commission": return dir * ((a.commissionRate ?? 0) - (b.commissionRate ?? 0));
        case "status": return dir * ((a.status || "").localeCompare(b.status || ""));
        case "country": return dir * ((a.country || "").localeCompare(b.country || ""));
        case "contactPerson": return dir * ((a.assignedStaffName || "").localeCompare(b.assignedStaffName || ""));
        default: return 0;
      }
    });
    return (
      <>
      <div className="overflow-x-auto">
        {isManager && someChecked && (
          <div className="flex items-center gap-3 mb-3 p-3 rounded-xl bg-primary/5 border border-primary/20 flex-wrap">
            <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
            <Select onValueChange={v => handleBulkAssignStaff(selected, v === "none" ? null : Number(v))}>
              <SelectTrigger className="h-8 text-xs w-[180px] rounded-lg">
                <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                <SelectValue placeholder={t("agentsPage.assignContactPerson")} />
              </SelectTrigger>
              <SelectContent className="max-h-60">
                <SelectItem value="none">{t("agentsPage.unassigned")}</SelectItem>
                {staffMembers.map(s => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {`${s.firstName || ""} ${s.lastName || ""}`.trim() || "Staff"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="destructive" className="rounded-lg gap-1.5 h-8" onClick={() => handleBulkDelete(selected)}>
              <Trash2 className="w-3.5 h-3.5" /> Delete Selected
            </Button>
            <Button size="sm" variant="outline" className="rounded-lg h-8" onClick={() => setSelected(new Set())}>
              Clear Selection
            </Button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 text-left">
              {isManager && (
                <th className="py-3 px-3 w-10">
                  <Checkbox checked={allChecked} onCheckedChange={() => toggleSelectAll(filteredData, selected, setSelected)} />
                </th>
              )}
              <ColumnHeader
                asTh
                label="Agent"
                sort={{ sortKey: "agent", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "text", value: agentColFilters.agent, onChange: v => setAgentColFilters(f => ({ ...f, agent: v })), placeholder: "Filter by name…", label: "Agent contains" }}
              />
              <ColumnHeader
                asTh
                label="Contact"
                sort={{ sortKey: "contact", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "text", value: agentColFilters.contact, onChange: v => setAgentColFilters(f => ({ ...f, contact: v })), placeholder: "Filter by email/phone…", label: "Contact contains" }}
              />
              {showParent && (
                <ColumnHeader
                  asTh
                  label="Parent Agent"
                  sort={{ sortKey: "parent", current: agentSort, onSort: handleAgentSort }}
                />
              )}
              <ColumnHeader
                asTh
                label="Country"
                sort={{ sortKey: "country", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "select", value: agentColFilters.country, onChange: v => setAgentColFilters(f => ({ ...f, country: v })), options: uniqueAgentCountries.map(c => ({ value: c, label: c })), label: "Country" }}
              />
              <ColumnHeader
                asTh
                label="Category"
                sort={{ sortKey: "category", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "select", value: agentColFilters.category, onChange: v => setAgentColFilters(f => ({ ...f, category: v })), options: uniqueAgentCategories.map(c => ({ value: c, label: c })), label: "Category" }}
              />
              <ColumnHeader
                asTh
                label="Commission %"
                sort={{ sortKey: "commission", current: agentSort, onSort: handleAgentSort }}
              />
              <ColumnHeader
                asTh
                label="Contact Person"
                sort={{ sortKey: "contactPerson", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "select", value: agentColFilters.contactPerson, onChange: v => setAgentColFilters(f => ({ ...f, contactPerson: v })), options: uniqueContactPersons.map(c => ({ value: c, label: c })), label: "Contact person" }}
              />
              <ColumnHeader
                asTh
                label="Status"
                sort={{ sortKey: "status", current: agentSort, onSort: handleAgentSort }}
                filter={{ type: "select", value: agentColFilters.status, onChange: v => setAgentColFilters(f => ({ ...f, status: v })), options: uniqueAgentStatuses.map(s => ({ value: s, label: s })), label: "Status" }}
              />
              <th className="py-3 px-3 font-semibold text-muted-foreground">Contract</th>
              {isManager && <th className="py-3 px-3 font-semibold text-muted-foreground text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {sortedData.length === 0 ? (
              <tr><td colSpan={showParent ? 11 : 10} className="py-12 text-center text-muted-foreground">No agents found</td></tr>
            ) : sortedData.map(a => (
              <tr key={a.id} className={`border-b border-border/30 hover:bg-secondary/30 transition-colors ${selected.has(a.id) ? "bg-primary/5" : ""}`}>
                {isManager && (
                  <td className="py-3 px-3">
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={() => toggleSelect(a.id, selected, setSelected)} />
                  </td>
                )}
                <td className="py-3 px-3">
                  <div className="flex items-center gap-3">
                    {a.logoUrl ? (
                      <img src={fixStorageUrl(a.logoUrl)!} alt={(a as any).name || 'Agent logo'} width={36} height={36} loading="lazy" className="w-9 h-9 rounded-lg object-cover border border-border" />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-primary/20 to-accent/20 flex items-center justify-center font-bold text-xs text-primary">
                        {a.firstName[0]}{a.lastName[0]}
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-foreground">{a.firstName} {a.lastName}</p>
                      <p className="text-xs text-muted-foreground">{a.agencyCode || a.businessName || "-"}</p>
                    </div>
                  </div>
                </td>
                <td className="py-3 px-3">
                  <p className="text-foreground text-xs">{a.email || "-"}</p>
                  <p className="text-muted-foreground text-xs">{a.phone || "-"}</p>
                  <div className="mt-1">
                    <QuickContactButtons
                      name={`${a.firstName} ${a.lastName}`}
                      email={a.email}
                      phone={a.phone}
                      entityType="agent"
                      entityId={a.id}
                    />
                  </div>
                </td>
                {showParent && <td className="py-3 px-3 text-xs text-foreground">{getParentName(a.parentAgentId)}</td>}
                <td className="py-3 px-3">
                  {a.country ? (
                    <div className="flex items-center gap-1.5 text-xs">
                      {(() => {
                        const v = a.country.trim();
                        const code = /^[A-Za-z]{2}$/.test(v)
                          ? v
                          : countries.find(c => c.name.toLowerCase() === v.toLowerCase())?.code;
                        return code ? <CountryFlag code={code} size="sm" /> : null;
                      })()}
                      <span>{a.country}</span>
                    </div>
                  ) : <span className="text-muted-foreground text-xs">-</span>}
                </td>
                <td className="py-3 px-3">
                  {a.category ? <Badge variant="outline" className="text-xs">{a.category}</Badge> : <span className="text-muted-foreground text-xs">-</span>}
                </td>
                <td className="py-3 px-3 font-mono text-foreground">{a.commissionRate != null ? `${a.commissionRate}%` : "-"}</td>
                <td className="py-3 px-3">
                  {isManager ? (
                    <Select
                      value={a.assignedStaffId ? String(a.assignedStaffId) : "none"}
                      onValueChange={v => handleAssignStaff(a.id, v === "none" ? null : Number(v))}
                    >
                      <SelectTrigger className="h-7 text-xs w-[140px]">
                        <SelectValue placeholder={t("agentsPage.assign")} />
                      </SelectTrigger>
                      <SelectContent className="max-h-60">
                        <SelectItem value="none">{t("agentsPage.unassigned")}</SelectItem>
                        {staffMembers.map(s => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {`${s.firstName || ""} ${s.lastName || ""}`.trim() || "Staff"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="text-xs">{a.assignedStaffName || "-"}</span>
                  )}
                  {Array.isArray(a.assignedStaffList) && a.assignedStaffList.length > 1 && (
                    <span
                      className="ml-1 text-[10px] text-muted-foreground"
                      title={a.assignedStaffList
                        .filter(s => !s.isPrimary)
                        .map(s => `${s.firstName || ""} ${s.lastName || ""}`.trim())
                        .join(", ")}
                    >
                      +{a.assignedStaffList.length - 1}
                    </span>
                  )}
                </td>
                <td className="py-3 px-3">
                  <Badge className={`text-xs ${statusBadge(a.status)}`}>{a.status}</Badge>
                </td>
                <td className="py-3 px-3">
                  {(() => {
                    const cs = getContractStatus(a);
                    if (!cs.label) return <span className="text-muted-foreground text-xs">-</span>;
                    return (
                      <div className="space-y-0.5">
                        <Badge variant="outline" className={`text-xs ${cs.color}`}>{cs.label}</Badge>
                        {cs.daysLeft !== null && cs.daysLeft > 0 && (
                          <p className="text-xs text-muted-foreground">{cs.daysLeft}d left</p>
                        )}
                      </div>
                    );
                  })()}
                </td>
                {isManager && (
                  <td className="py-3 px-3 text-right">
                    <div className="flex gap-1 justify-end">
                      <Button size="icon" variant="ghost" className="w-7 h-7" onClick={() => openEdit(a)}>
                        <Edit className="w-3.5 h-3.5" />
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="ghost" className="w-7 h-7">
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => { setPasswordDialog({ agentId: a.id, agentName: `${a.firstName} ${a.lastName}` }); setNewPassword(""); }}>
                            <KeyRound className="w-4 h-4 mr-2" /> Set Password
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={resendingCredentials.has(a.id)}
                            onClick={() => handleResendCredentials(a)}
                          >
                            <Mail className="w-4 h-4 mr-2" />
                            {resendingCredentials.has(a.id) ? "..." : t("staffAgents.resendCredentials")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleImpersonate(a)}>
                            <LogIn className="w-4 h-4 mr-2" /> Login as {a.firstName} {a.lastName}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => handleToggleStatus(a)}>
                            {a.status === "active" ? (
                              <><ShieldOff className="w-4 h-4 mr-2" /> Deactivate</>
                            ) : (
                              <><ShieldCheck className="w-4 h-4 mr-2" /> Activate</>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDelete(a.id)}>
                            <Trash2 className="w-4 h-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
    );
  }

  function AgentPagination({ currentPage, totalItems, setPageFn }: { currentPage: number; totalItems: number; setPageFn: (p: number) => void }) {
    return (
      <>
      <TablePagination
        currentPage={currentPage}
        totalItems={totalItems}
        pageSize={20}
        onPageChange={setPageFn}
      />
      </>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground">{t("staffAgents.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("staffAgents.subtitle")}</p>
          </div>
        </div>

        {(() => {
          const allAgentsList = [...agents, ...subAgents];
          const expiring = allAgentsList.filter(a => {
            if (!a.contractEndDate) return false;
            const d = Math.ceil((new Date(a.contractEndDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            return d > 0 && d <= 60;
          });
          const expired = allAgentsList.filter(a => {
            if (!a.contractEndDate) return false;
            return new Date(a.contractEndDate).getTime() < Date.now();
          });
          if (expiring.length === 0 && expired.length === 0) return null;
          return (
            <div className="space-y-2">
              {expired.length > 0 && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800">
                  <div className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                  <p className="text-sm text-red-700 dark:text-red-400">
                    <span className="font-semibold">{expired.length} agent(s)</span> with expired contracts:{" "}
                    {expired.slice(0, 3).map(a => `${a.firstName} ${a.lastName}`).join(", ")}
                    {expired.length > 3 ? ` +${expired.length - 3} more` : ""}
                  </p>
                </div>
              )}
              {expiring.length > 0 && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800">
                  <div className="w-2 h-2 rounded-full bg-orange-500 animate-pulse shrink-0" />
                  <p className="text-sm text-orange-700 dark:text-orange-400">
                    <span className="font-semibold">{expiring.length} agent(s)</span> with contracts expiring within 60 days:{" "}
                    {expiring.slice(0, 3).map(a => {
                      const d = Math.ceil((new Date(a.contractEndDate!).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                      return `${a.firstName} ${a.lastName} (${d}d)`;
                    }).join(", ")}
                    {expiring.length > 3 ? ` +${expiring.length - 3} more` : ""}
                  </p>
                </div>
              )}
            </div>
          );
        })()}

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="rounded-xl bg-secondary/50 p-1">
            <TabsTrigger value="agents" className="rounded-lg gap-2"><Users className="w-4 h-4" /> Agent List ({total})</TabsTrigger>
            <TabsTrigger value="sub-agents" className="rounded-lg gap-2"><Network className="w-4 h-4" /> Sub Agents ({subTotal})</TabsTrigger>
          </TabsList>

          {/* ── Agent List ── */}
          <TabsContent value="agents" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
                <div className="flex items-center gap-3 flex-1 flex-wrap">
                  <div className="relative min-w-[200px] max-w-sm flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={t("agentsPage.searchAgents")} value={search}
                      onChange={e => { setSearch(e.target.value); setPage(1); }}
                      className="pl-9 rounded-xl" />
                  </div>
                  <Select value={countryFilter} onValueChange={v => { setCountryFilter(v); setPage(1); }}>
                    <SelectTrigger className="w-[160px] h-9 text-sm rounded-xl">
                      <MapPin className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                      <SelectValue placeholder="Country" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      <SelectItem value="all">All Countries</SelectItem>
                      {countries.map(c => (
                        <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {isManager && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <ExportImportToolbar
                      exportPath="/api/agents/export"
                      importPath="/api/agents/import"
                      templatePath="/api/agents/template"
                      downloadName="agents"
                      selectedIds={Array.from(selectedIds)}
                      onImported={() => { setSelectedIds(new Set()); fetchAgents(); }}
                    />
                    <Button onClick={() => openCreate(false)} className="rounded-xl gap-2">
                      <Plus className="w-4 h-4" /> {t("staffAgents.newAgent")}
                    </Button>
                  </div>
                )}
              </div>
              {loading ? (
                <div className="flex justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
              ) : (
                <AgentTable data={agents} />
              )}
              <AgentPagination currentPage={page} totalItems={total} setPageFn={setPage} />
            </Card>
          </TabsContent>

          {/* ── Sub Agents ── */}
          <TabsContent value="sub-agents" className="mt-6">
            <Card className="border-none shadow-lg shadow-black/5 p-6">
              <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
                <div className="flex items-center gap-3 flex-1 flex-wrap">
                  <div className="relative min-w-[200px] max-w-sm flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder={t("agentsPage.searchSubAgents")} value={subSearch}
                      onChange={e => { setSubSearch(e.target.value); setSubPage(1); }}
                      className="pl-9 rounded-xl" />
                  </div>
                  <Select value={subCountryFilter} onValueChange={v => { setSubCountryFilter(v); setSubPage(1); }}>
                    <SelectTrigger className="w-[160px] h-9 text-sm rounded-xl">
                      <MapPin className="w-3.5 h-3.5 mr-1.5 text-muted-foreground" />
                      <SelectValue placeholder="Country" />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      <SelectItem value="all">All Countries</SelectItem>
                      {countries.map(c => (
                        <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {isManager && (
                  <Button onClick={() => openCreate(true)} className="rounded-xl gap-2">
                    <UserPlus className="w-4 h-4" /> {t("staffAgents.newSubAgent")}
                  </Button>
                )}
              </div>

              <div className="mb-4 p-3 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-400">
                <p className="font-semibold mb-1">How Sub-Agents work:</p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Sub-agents are linked to a parent agent and operate under them.</li>
                  <li>Students & applications submitted by sub-agents flow to the parent agent first, then to you.</li>
                  <li>Sub-agents earn commission based on the rate set by their parent agent.</li>
                  <li>Parent agents can choose to hide service fee visibility from their sub-agents.</li>
                </ul>
              </div>

              <AgentTable data={subAgents} showParent />
              <AgentPagination currentPage={subPage} totalItems={subTotal} setPageFn={setSubPage} />
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Password Dialog ── */}
      {passwordDialog && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-md">
            <div className="px-6 py-4 border-b border-border/50 flex items-center justify-between">
              <h2 className="font-display font-bold text-lg text-foreground flex items-center gap-2">
                <KeyRound className="w-5 h-5" /> Set Password
              </h2>
              <Button size="icon" variant="ghost" onClick={() => setPasswordDialog(null)} className="w-8 h-8 rounded-lg">
                <X className="w-4 h-4" />
              </Button>
            </div>
            <div className="p-6 space-y-4">
              <p className="text-sm text-muted-foreground">Set a new password for <strong>{passwordDialog.agentName}</strong></p>
              <div className="space-y-1.5">
                <Label>{t("agentsPage.newPassword")}</Label>
                <Input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} className="rounded-xl" placeholder="Min. 6 characters" />
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border/50 flex justify-end gap-3">
              <Button variant="outline" onClick={() => setPasswordDialog(null)} className="rounded-xl">{t("staffAgents.cancel")}</Button>
              <Button onClick={handleSetPassword} disabled={passwordSaving || newPassword.length < 6} className="rounded-xl gap-2">
                {passwordSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Password
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Create / Edit Dialog ── */}
      {showDialog && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-card border-b border-border/50 px-6 py-4 rounded-t-2xl flex items-center justify-between z-10">
              <h2 className="font-display font-bold text-lg text-foreground">
                {editingAgent ? (isSubAgent ? t("staffAgents.editSubAgent") : t("staffAgents.editAgent")) : (isSubAgent ? t("staffAgents.newSubAgent") : t("staffAgents.newAgent"))}
              </h2>
              <Button size="icon" variant="ghost" onClick={() => setShowDialog(false)} className="w-8 h-8 rounded-lg">
                <X className="w-4 h-4" />
              </Button>
            </div>

            <div className="p-6 space-y-6">
              {/* Sub-Agent Parent */}
              {isSubAgent && (
                <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
                  <Label className="text-sm font-semibold mb-2 block">Parent Agent <span className="text-red-500">*</span></Label>
                  <Select value={form.parentAgentId} onValueChange={v => setForm(f => ({ ...f, parentAgentId: v }))}>
                    <SelectTrigger className="rounded-xl">
                      <SelectValue placeholder={t("agentsPage.selectParentAgent")} />
                    </SelectTrigger>
                    <SelectContent>
                      {parentAgents.map(pa => (
                        <SelectItem key={pa.id} value={pa.id.toString()}>{pa.firstName} {pa.lastName} {pa.businessName ? `(${pa.businessName})` : ""}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Agency Code */}
              <div className="space-y-1.5">
                <Label>{t("agentsPage.agencyCode")}</Label>
                <Input value={form.agencyCode} onChange={e => setForm(f => ({ ...f, agencyCode: e.target.value }))} className="rounded-xl" placeholder="e.g. AG-001" />
              </div>

              {/* Name */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>First Name <span className="text-red-500">*</span></Label>
                  <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} className="rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label>Last Name <span className="text-red-500">*</span></Label>
                  <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} className="rounded-xl" />
                </div>
              </div>

              {/* Contact */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1"><Mail className="w-3.5 h-3.5" /> Email <span className="text-red-500">*</span></Label>
                  <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1"><Phone className="w-3.5 h-3.5" /> Mobile No. <span className="text-red-500">*</span></Label>
                  <div className="flex gap-2">
                    <PhoneCodePicker value={form.phoneCode} onChange={v => setForm(f => ({ ...f, phoneCode: v }))} triggerClassName="w-28 shrink-0" />
                    <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="Mobile No." className="rounded-xl" />
                  </div>
                </div>
              </div>

              {/* Location */}
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" /> Country</Label>
                  <Select value={form.country} onValueChange={v => {
                    setForm(f => ({ ...f, country: v, city: "" }));
                    const c = countries.find(ct => ct.name === v);
                    if (c) fetchCities(c.id);
                    else setCities([]);
                  }}>
                    <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select Country" /></SelectTrigger>
                    <SelectContent className="max-h-60">
                      {countries.map(c => (
                        <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("agentsPage.state")}</Label>
                  <Input value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} className="rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label>City / Location</Label>
                  {cities.length > 0 ? (
                    <Select value={form.city} onValueChange={v => setForm(f => ({ ...f, city: v }))}>
                      <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select City" /></SelectTrigger>
                      <SelectContent className="max-h-60">
                        {cities.map(c => (
                          <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} className="rounded-xl" placeholder={form.country ? "No cities found, type manually" : "Select country first"} />
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t("agentsPage.address")}</Label>
                <Input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} className="rounded-xl" />
              </div>

              {/* Business */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Business Name</Label>
                  <Input value={form.businessName} onChange={e => setForm(f => ({ ...f, businessName: e.target.value }))} className="rounded-xl" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("agentsPage.category")}</Label>
                  <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                    <SelectTrigger className="rounded-xl"><SelectValue placeholder="Select" /></SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Contract identity */}
              <div className="grid sm:grid-cols-2 gap-4">
                <ContractTemplatePicker
                  value={form.assignedContractTemplateId}
                  showCreateNote={!editingAgent}
                  onChange={(id, tpl) => setForm(f => ({
                    ...f,
                    assignedContractTemplateId: id,
                    ...(tpl ? { entityType: tpl.entityType, preferredContractLanguage: tpl.language } : {}),
                  }))}
                />
                <div className="space-y-1.5">
                  <Label>Tax / ID Number</Label>
                  <Input value={form.taxNumber} onChange={e => setForm(f => ({ ...f, taxNumber: e.target.value }))} className="rounded-xl" placeholder="VKN / TCKN" />
                </div>
              </div>

              {/* Commission */}
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label>Commission Percent <span className="text-red-500">*</span></Label>
                  <Input type="number" min="0" max="100" step="0.5" value={form.commissionRate}
                    onChange={e => setForm(f => ({ ...f, commissionRate: e.target.value }))}
                    className="rounded-xl" placeholder="e.g. 15" />
                </div>
                {!isSubAgent && (
                  <div className="space-y-1.5">
                    <Label>Sub-Agent Commission Rate (%)</Label>
                    <Input type="number" min="0" max="100" step="0.5" value={form.subAgentCommissionRate}
                      onChange={e => setForm(f => ({ ...f, subAgentCommissionRate: e.target.value }))}
                      className="rounded-xl" placeholder="Commission for sub-agents" />
                  </div>
                )}
              </div>

              {/* Assigned Staff (multi + primary) */}
              {!isSubAgent && (
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1"><UserPlus className="w-3.5 h-3.5" /> Assigned Staff</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" className="w-full justify-between rounded-xl">
                        <span className="text-xs truncate">
                          {form.assignedStaff.length === 0
                            ? "Select staff..."
                            : `${form.assignedStaff.length} staff selected`}
                        </span>
                        <ChevronRight className="h-4 w-4 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[320px] p-2 max-h-72 overflow-auto">
                      {staffMembers.length === 0 && <p className="text-xs text-muted-foreground p-2">No staff found</p>}
                      {staffMembers.map(s => {
                        const entry = form.assignedStaff.find(e => e.userId === s.id);
                        const checked = !!entry;
                        const isPrimary = entry?.isPrimary || false;
                        return (
                          <div key={s.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-primary/10 rounded-md">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={v => {
                                setForm(f => {
                                  const list = [...f.assignedStaff];
                                  if (v) {
                                    if (!list.find(e => e.userId === s.id)) {
                                      list.push({ userId: s.id, isPrimary: list.length === 0 });
                                    }
                                  } else {
                                    const idx = list.findIndex(e => e.userId === s.id);
                                    if (idx >= 0) {
                                      const wasPrimary = list[idx].isPrimary;
                                      list.splice(idx, 1);
                                      if (wasPrimary && list.length > 0) list[0].isPrimary = true;
                                    }
                                  }
                                  return { ...f, assignedStaff: list };
                                });
                              }}
                            />
                            <div className="flex-1 text-xs">
                              {s.firstName} {s.lastName}
                              <span className="text-muted-foreground ml-1">({s.role.replace(/_/g, " ")})</span>
                            </div>
                            {checked && (
                              <button
                                type="button"
                                title={isPrimary ? "Primary contact" : "Set as primary contact"}
                                onClick={() => {
                                  setForm(f => ({
                                    ...f,
                                    assignedStaff: f.assignedStaff.map(e => ({ ...e, isPrimary: e.userId === s.id })),
                                  }));
                                }}
                                className={`text-lg leading-none ${isPrimary ? "text-amber-500" : "text-muted-foreground hover:text-amber-400"}`}
                              >
                                {isPrimary ? "★" : "☆"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </PopoverContent>
                  </Popover>
                  <p className="text-xs text-muted-foreground">
                    The staff marked with a star is shown as the "Primary contact". When at least one staff is selected, exactly one must be primary.
                  </p>
                  {form.assignedStaff.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {form.assignedStaff.map(e => {
                        const s = staffMembers.find(m => m.id === e.userId);
                        if (!s) return null;
                        return (
                          <Badge key={e.userId} variant={e.isPrimary ? "default" : "secondary"} className="text-xs">
                            {e.isPrimary && <span className="mr-1">★</span>}
                            {s.firstName} {s.lastName}
                          </Badge>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Sub-agent settings for parent agents */}
              {!isSubAgent && (
                <div className="flex items-center gap-3 p-4 rounded-xl border border-border/50">
                  <button
                    onClick={() => setForm(f => ({ ...f, hideServiceFees: !f.hideServiceFees }))}
                    className={`relative w-12 h-6 rounded-full transition-all ${form.hideServiceFees ? "bg-primary" : "bg-secondary border-2 border-border"}`}>
                    <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${form.hideServiceFees ? "translate-x-6" : ""}`} />
                  </button>
                  <div>
                    <p className="font-semibold text-sm text-foreground flex items-center gap-1.5">
                      {form.hideServiceFees ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      Hide Service Fees from Sub-Agents
                    </p>
                    <p className="text-xs text-muted-foreground">When enabled, sub-agents under this agent won't see service fee details.</p>
                  </div>
                </div>
              )}

              {/* File Uploads */}
              <div className="space-y-4">
                <h3 className="font-display font-semibold text-foreground">Documents</h3>
                <div className="grid sm:grid-cols-3 gap-4">
                  {/* Logo */}
                  <div className="space-y-2">
                    <Label className="text-xs">Logo for Agent Panel</Label>
                    <div className="relative h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                      {form.logoUrl ? (
                        <>
                          <img src={fixStorageUrl(form.logoUrl)!} alt="Logo" className="max-h-20 max-w-full object-contain" />
                          <button onClick={() => setForm(f => ({ ...f, logoUrl: "" }))} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive/90 text-white flex items-center justify-center"><X className="w-3 h-3" /></button>
                        </>
                      ) : (
                        <button onClick={() => logoRef.current?.click()} className="flex flex-col items-center gap-1 text-muted-foreground hover:text-primary text-xs" disabled={logoUploading}>
                          {logoUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                          <span>{logoUploading ? "Uploading..." : "Upload"}</span>
                        </button>
                      )}
                    </div>
                    <input ref={logoRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, "logoUrl", setLogoUploading); e.target.value = ""; }} />
                  </div>

                  {/* ID Proof */}
                  <div className="space-y-2">
                    <Label className="text-xs">Agent ID Proof</Label>
                    <div className="relative h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                      {form.agentIdProofUrl ? (
                        <>
                          <p className="text-xs text-green-600 font-medium px-2 text-center">Uploaded</p>
                          <button onClick={() => setForm(f => ({ ...f, agentIdProofUrl: "" }))} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive/90 text-white flex items-center justify-center"><X className="w-3 h-3" /></button>
                        </>
                      ) : (
                        <button onClick={() => idProofRef.current?.click()} className="flex flex-col items-center gap-1 text-muted-foreground hover:text-primary text-xs" disabled={idProofUploading}>
                          {idProofUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                          <span>{idProofUploading ? "Uploading..." : "Upload"}</span>
                        </button>
                      )}
                    </div>
                    <input ref={idProofRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, "agentIdProofUrl", setIdProofUploading); e.target.value = ""; }} />
                  </div>

                  {/* Business Cert */}
                  <div className="space-y-2">
                    <Label className="text-xs">Business Certificate</Label>
                    <div className="relative h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                      {form.businessCertUrl ? (
                        <>
                          <p className="text-xs text-green-600 font-medium px-2 text-center">Uploaded</p>
                          <button onClick={() => setForm(f => ({ ...f, businessCertUrl: "" }))} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive/90 text-white flex items-center justify-center"><X className="w-3 h-3" /></button>
                        </>
                      ) : (
                        <button onClick={() => certRef.current?.click()} className="flex flex-col items-center gap-1 text-muted-foreground hover:text-primary text-xs" disabled={certUploading}>
                          {certUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                          <span>{certUploading ? "Uploading..." : "Upload"}</span>
                        </button>
                      )}
                    </div>
                    <input ref={certRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, "businessCertUrl", setCertUploading); e.target.value = ""; }} />
                  </div>
                </div>
              </div>

              {/* Contract Dates */}
              <div className="space-y-4">
                <h3 className="font-display font-semibold text-foreground flex items-center gap-2">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>
                  {t("staffAgents.contractDetails")}
                </h3>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>{t("staffAgents.contractStartDate")}</Label>
                    <Input type="date" value={form.contractStartDate}
                      onChange={e => setForm(f => ({ ...f, contractStartDate: e.target.value }))}
                      className="rounded-xl" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("staffAgents.contractEndDate")}</Label>
                    <Input type="date" value={form.contractEndDate}
                      onChange={e => setForm(f => ({ ...f, contractEndDate: e.target.value }))}
                      className="rounded-xl" />
                  </div>
                </div>

                {/* Contract File */}
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("staffAgents.contractFile")}</Label>
                  <div className="relative h-24 rounded-xl border-2 border-dashed border-border hover:border-primary/50 transition-colors flex items-center justify-center overflow-hidden bg-secondary/20">
                    {form.contractUrl ? (
                      <>
                        <div className="flex flex-col items-center gap-1 text-green-600">
                          <p className="text-xs font-medium">{t("staffAgents.contractUploaded")}</p>
                          <a href={form.contractUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] underline hover:text-primary">{t("staffAgents.viewDownload")}</a>
                        </div>
                        <button onClick={() => setForm(f => ({ ...f, contractUrl: "" }))} className="absolute top-1 right-1 w-5 h-5 rounded-full bg-destructive/90 text-white flex items-center justify-center"><X className="w-3 h-3" /></button>
                      </>
                    ) : (
                      <button onClick={() => contractRef.current?.click()} className="flex flex-col items-center gap-1 text-muted-foreground hover:text-primary text-xs" disabled={contractUploading}>
                        {contractUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                        <span>{contractUploading ? t("staffAgents.uploading") : t("staffAgents.uploadContract")}</span>
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("staffAgents.contractHelp")}</p>
                  <input ref={contractRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadFile(f, "contractUrl", setContractUploading); e.target.value = ""; }} />
                </div>
                {form.contractStartDate && form.contractEndDate && (() => {
                  const end = new Date(form.contractEndDate);
                  const now = new Date();
                  const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                  const isExpired = daysLeft <= 0;
                  const isExpiring = daysLeft > 0 && daysLeft <= 60;
                  const bgColor = isExpired ? "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-800" :
                    isExpiring ? "bg-orange-50 border-orange-200 dark:bg-orange-950/30 dark:border-orange-800" :
                    "bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800";
                  const textColor = isExpired ? "text-red-700 dark:text-red-400" :
                    isExpiring ? "text-orange-700 dark:text-orange-400" :
                    "text-green-700 dark:text-green-400";
                  const label = isExpired ? t("staffAgents.expired") : isExpiring ? t("staffAgents.expiringSoon") : t("staffAgents.active");
                  return (
                    <div className={`p-3 rounded-xl border ${bgColor} flex items-center justify-between`}>
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${isExpired ? "bg-red-500" : isExpiring ? "bg-orange-500 animate-pulse" : "bg-green-500"}`} />
                        <span className={`text-sm font-medium ${textColor}`}>{label}</span>
                      </div>
                      <span className={`text-sm font-semibold ${textColor}`}>
                        {isExpired ? t("staffAgents.expiredAgo", { n: Math.abs(daysLeft) }) : t("staffAgents.daysRemaining", { n: daysLeft })}
                      </span>
                    </div>
                  );
                })()}
              </div>

              {/* Branches (multi-select) — Point of Contact removed; use Assigned Staff instead */}
              <div className="space-y-1.5">
                <Label>{t("staffAgents.branches")}</Label>
                <Popover open={branchPickerOpen} onOpenChange={setBranchPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button type="button" variant="outline" className="w-full justify-start rounded-xl font-normal h-auto min-h-[40px] py-2 flex-wrap gap-1">
                      {form.branchIds.length === 0 ? (
                        <span className="text-muted-foreground">{t("staffAgents.selectBranches")}</span>
                      ) : (
                        form.branchIds.map(id => {
                          const b = branchOptions.find(o => o.id === id);
                          return b ? <Badge key={id} variant="secondary" className="text-xs">{b.name}</Badge> : null;
                        })
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[260px] p-2" align="start">
                    {branchOptions.length === 0 ? (
                      <p className="text-xs text-muted-foreground p-2">{t("staffAgents.noBranches")}</p>
                    ) : (
                      <div className="max-h-60 overflow-y-auto space-y-1">
                        {branchOptions.map(b => {
                          const checked = form.branchIds.includes(b.id);
                          return (
                            <button
                              key={b.id}
                              type="button"
                              onClick={() => {
                                setForm(f => ({
                                  ...f,
                                  branchIds: checked
                                    ? f.branchIds.filter(x => x !== b.id)
                                    : [...f.branchIds, b.id],
                                }));
                              }}
                              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-md hover:bg-secondary text-left"
                            >
                              <Checkbox checked={checked} className="pointer-events-none" />
                              <span className="flex-1">{b.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label>{t("staffAgents.notes")}</Label>
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={3}
                  className="flex w-full rounded-xl border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
              </div>
            </div>

            {/* Footer */}
            <div className="sticky bottom-0 bg-card border-t border-border/50 px-6 py-4 rounded-b-2xl flex justify-end gap-3">
              <Button variant="outline" onClick={() => setShowDialog(false)} className="rounded-xl">{t("staffAgents.cancel")}</Button>
              <Button onClick={handleSave} disabled={saving} className="rounded-xl gap-2 px-6">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {editingAgent ? t("staffAgents.update") : t("staffAgents.createAgent")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ContractTemplatePicker({ value, onChange, showCreateNote }: {
  value: string;
  onChange: (id: string, tpl?: { entityType: string; language: string }) => void;
  showCreateNote: boolean;
}) {
  const [templates, setTemplates] = useState<Array<{ id: number; name: string; language: string; entityType: string; version: number; isActive: boolean }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    customFetch(`/api/contract-templates`).then((r: any) => {
      setTemplates(r.data || r || []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const active = templates.filter(t => t.isActive);
  const NO_CONTRACT = "__none__";

  return (
    <div className="space-y-1.5">
      <Label>Contract Template <span className="text-muted-foreground font-normal">(optional)</span></Label>
      {loading ? (
        <div className="text-xs text-muted-foreground">Loading templates…</div>
      ) : (
        <Select
          value={value || NO_CONTRACT}
          onValueChange={v => {
            if (v === NO_CONTRACT) { onChange(""); return; }
            const tpl = active.find(t => String(t.id) === v);
            onChange(v, tpl ? { entityType: tpl.entityType, language: tpl.language } : undefined);
          }}
        >
          <SelectTrigger className="rounded-xl"><SelectValue placeholder="No contract" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CONTRACT}>No contract</SelectItem>
            {active.map(t => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.name} — {t.language.toUpperCase()} · {t.entityType === "individual" ? "Individual" : "Company"} v{t.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {!loading && active.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No active templates available. Leave this as "No contract", or create one in the Contract Templates section.
        </p>
      )}
      {showCreateNote && (
        <p className="text-xs text-muted-foreground">
          If a template is selected, the agent is emailed login credentials and an admin-driven signing session is opened — they must sign before the deadline. Choose "No contract" to let the agent use the system without signing.
        </p>
      )}
    </div>
  );
}
