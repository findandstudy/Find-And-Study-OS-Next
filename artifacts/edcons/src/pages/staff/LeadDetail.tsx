import React, { useState, useEffect, useMemo, useRef } from "react";
import { useLocation, Link } from "wouter";
import { useEntityViewTracker } from "@/hooks/use-entity-view-tracker";
import {
  useGetLead,
  useUpdateLead,
  useConvertLead,
  customFetch,
} from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "@/hooks/use-i18n";
import { formatDate } from "@workspace/i18n";
import { useDateFormat } from "@/hooks/use-date-format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneField, isPhoneFieldValid, toPhoneFieldValue } from "@/components/ui/phone-field";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useDocumentPreview } from "@/components/DocumentPreviewDialog";
import { getPreviewKind, type PreviewTarget } from "@/components/documentPreview";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, User, Mail, Phone, Globe, BookOpen, MapPin, MessageSquare, RefreshCw, DollarSign, CalendarClock, Clock, CheckCircle2, Plus, UserCheck2, UserPlus, Pencil, ChevronDown, X, GraduationCap, Power, Trash2, FileText, Download, Eye, Upload, Loader2 } from "lucide-react";
import { uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { Checkbox } from "@/components/ui/checkbox";
import { QuickContactButtons } from "@/components/QuickContact";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { OriginBadge, OriginSection } from "@/components/OriginBadge";
import { AllMessagingHistory } from "@/components/inbox/AllMessagingHistory";
import { AuditLogSection } from "@/components/AuditLogSection";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { StudentPhotoAvatar } from "@/components/StudentPhotoAvatar";
import { getLeadSourceLabel } from "@/lib/leadSourceLabel";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { humanizePipelineStageKey } from "@/lib/pipelineStageLabel";


const SOURCES = ["website", "referral", "social_media", "walk_in", "partner", "other"];


type CountryRecord = { id: number; name: string; code: string; flagEmoji?: string; isActive: boolean };

function useCountries() {
  return useQuery<CountryRecord[]>({
    queryKey: ["countries-all"],
    queryFn: async () => {
      const res: any = await customFetch(`/api/countries?limit=500`);
      return res.data ?? res;
    },
    staleTime: 5 * 60_000,
  });
}

const STATUS_OPTIONS = ["new", "contacted", "interested", "qualified", "converted", "lost"];

const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  contacted: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  interested: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  qualified: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  converted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  lost: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface Props {
  id: number;
  basePath?: string;
}

export default function LeadDetail({ id, basePath = "/staff" }: Props) {
  const { t, lang } = useI18n();
  const { stages: leadStages } = usePipelineStages("lead");
  const leadStageLabelByKey = useMemo(
    () => new Map<string, string>(leadStages.map((stage) => [stage.key, stage.label] as const)),
    [leadStages],
  );
  const leadStatusOptions = useMemo(
    () => (leadStages.length > 0 ? leadStages.map((stage) => stage.key) : STATUS_OPTIONS),
    [leadStages],
  );
  const getLeadStageLabel = (key?: string | null) =>
    key ? (leadStageLabelByKey.get(key) ?? humanizePipelineStageKey(key)) : "";
  const getLeadStageColor = (key?: string | null) =>
    STATUS_COLORS[key ?? ""] ?? "bg-muted text-muted-foreground";
  const dateFormat = useDateFormat();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { user, hasPermission } = useAuth(true);
  useEntityViewTracker("lead", id);
  const queryClient = useQueryClient();
  const [noteText, setNoteText] = useState("");
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [fuTitle, setFuTitle] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuTime, setFuTime] = useState("10:00");
  const [fuNotes, setFuNotes] = useState("");
  const [editingFuId, setEditingFuId] = useState<number | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);

  const isAdmin = user && ["super_admin", "admin", "manager"].includes(user.role);
  const canChangeAssigned = !!isAdmin || hasPermission("records.change_assigned");
  const isStaffUser = user && ["super_admin", "admin", "manager", "staff"].includes(user.role);
  const isAgent = basePath === "/agent";
  const [noteTab, setNoteTab] = useState<"general" | "internal">("general");

  // Lead stage change is governed by the leads.change_stage permission for all
  // roles (Task #564 — agents no longer use a separate Settings toggle).
  const canChangeStage = !!isAdmin || hasPermission("leads.change_stage");

  const { data: lead, isLoading } = useGetLead(id) as { data: any; isLoading: boolean };
  const [mainTab, setMainTab] = useState<"overview" | "documents">("overview");
  const { data: leadDocs = [] } = useQuery<any[]>({
    queryKey: [`/api/leads/${id}/documents`],
    queryFn: () => fetch(`${BASE}/api/leads/${id}/documents`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then(d => Array.isArray(d) ? d : []),
    enabled: !!id,
  });
  const { data: generalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/leads/${id}/notes`, "general"],
    queryFn: () => fetch(`${BASE}/api/leads/${id}/notes?internal=false`, { credentials: "include" }).then(r => r.json()).then(j => Array.isArray(j) ? j : []),
    enabled: !!id,
  });
  const { data: internalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/leads/${id}/notes`, "internal"],
    queryFn: () => fetch(`${BASE}/api/leads/${id}/notes?internal=true`, { credentials: "include" }).then(r => r.json()).then(j => Array.isArray(j) ? j : []),
    enabled: !!id && !!isStaffUser,
  });
  const activeNotes = noteTab === "internal" ? internalNotes : generalNotes;
  const updateLead = useUpdateLead();
  const convertLead = useConvertLead();

  const { data: staffUsersData } = useQuery<any>({
    queryKey: ["/api/users"],
    queryFn: () => customFetch("/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100"),
    // Task #494: load for admin AND for the current assignee so they can reassign/unassign
    enabled: !!(isAdmin || (lead?.assignedToId && lead?.assignedToId === user?.id)),
    staleTime: 5 * 60_000,
  });

  // L1: agents (and sub-agents) can assign their lead to their own agent_staff
  // members. agent_staff users cannot list staff, so the dropdown is only
  // sourced for agent/sub_agent; everyone else falls back to "Assign to me".
  const isAgentManager = isAgent && !!user && ["agent", "sub_agent"].includes(user.role);
  const { data: agentStaffData } = useQuery<any>({
    queryKey: ["/api/agents/me/staff"],
    queryFn: () => customFetch("/api/agents/me/staff?limit=100"),
    enabled: isAgentManager,
    staleTime: 5 * 60_000,
  });
  const assigneeOptions = useMemo(() => {
    if (isAgent) {
      const staff = ((agentStaffData?.data || []) as any[])
        .filter((u: any) => u.isActive !== false)
        .map((u: any) => ({ id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email }));
      if (user && !staff.some((s: any) => s.id === user.id)) {
        staff.unshift({ id: user.id, firstName: (user as any).firstName, lastName: (user as any).lastName, email: (user as any).email });
      }
      return staff;
    }
    const list = Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || [];
    const staffRoles = ["super_admin", "admin", "manager", "staff", "consultant"];
    return list.filter((u: any) => staffRoles.includes(u.role));
  }, [isAgent, agentStaffData, staffUsersData, user]);
  // Task #494: strict rule — assignment dropdown only for admin or current assignee
  const isCurrentLeadAssignee = !!(lead?.assignedToId && lead.assignedToId === user?.id);
  const canAssignLead = isAgent
    ? isAgentManager
    : (!!isAdmin || isCurrentLeadAssignee);
  const canSelfAssign = !isAgent && !isAdmin && !isCurrentLeadAssignee && hasPermission("records.assign_button") && !lead?.assignedToId;

  const [uploadOpen, setUploadOpen] = useState(false);
  const { data: catalogResp } = useQuery<any>({
    queryKey: ["catalog-options"],
    queryFn: () => customFetch("/api/catalog-options"),
    enabled: !!isStaffUser,
    staleTime: 5 * 60_000,
  });
  const docCatalogOptions = useMemo(() => {
    const grouped = (catalogResp as any)?.grouped || {};
    const rows: any[] = grouped["documents"] || [];
    return rows
      .filter((r: any) => r.isActive !== false)
      .map((r: any) => {
        const md = r.metadata || {};
        const label = (typeof md.label === "string" && md.label.trim())
          ? md.label.trim()
          : String(r.value).replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
        return { value: r.value as string, label };
      });
  }, [catalogResp]);

  // T1: Look up the lead's interested program to derive Estimated Budget from tuition
  const interestedProgramName = (lead as any)?.interestedProgram?.trim();
  const { data: programMatchData } = useQuery<any>({
    queryKey: ["lead-program-lookup", interestedProgramName],
    queryFn: () => customFetch(`/api/programs?search=${encodeURIComponent(interestedProgramName)}&limit=1`),
    enabled: !!interestedProgramName,
    staleTime: 5 * 60_000,
  });
  const matchedProgram = (() => {
    const list = Array.isArray(programMatchData) ? programMatchData : programMatchData?.data || [];
    return list[0] as { tuitionFee?: string | number; discountedFee?: string | number; currency?: string } | undefined;
  })();
  const estimatedBudgetDisplay = (() => {
    if (!matchedProgram) return undefined;
    const fee = matchedProgram.discountedFee && Number(matchedProgram.discountedFee) > 0
      ? Number(matchedProgram.discountedFee)
      : matchedProgram.tuitionFee && Number(matchedProgram.tuitionFee) > 0
      ? Number(matchedProgram.tuitionFee)
      : null;
    if (!fee) return undefined;
    const currency = matchedProgram.currency || "USD";
    const symbol = currency === "USD" ? "$" : currency === "EUR" ? "€" : currency === "GBP" ? "£" : `${currency} `;
    const tag = matchedProgram.discountedFee && Number(matchedProgram.discountedFee) > 0 ? " (discounted)" : "";
    return `${symbol}${fee.toLocaleString()}${tag}`;
  })();

  function getAssignedUserName(assignedToId: number | null | undefined): string | null {
    if (!assignedToId) return null;
    if (user && assignedToId === user.id) return t("leadDetailPage.you");
    const source = isAgent
      ? ((agentStaffData?.data || []) as any[])
      : (Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || []);
    const found = source.find((u: any) => u.id === assignedToId);
    if (found) return `${found.firstName || ''} ${found.lastName || ''}`.trim() || found.email;
    return t("leadDetailPage.staffMember");
  }

  async function handleAssign(targetUserId: number | null) {
    setAssigning(true);
    try {
      await customFetch(`/api/leads/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedTo: targetUserId }),
      });
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      toast({ title: targetUserId ? t("leadDetailPage.leadAssigned") : t("leadDetailPage.leadUnassigned") });
    } catch (err: any) {
      toast({ title: t("leadDetailPage.error"), description: err.message, variant: "destructive" });
    } finally {
      setAssigning(false);
    }
  }

  const { data: followUps = [] } = useQuery<any[]>({
    queryKey: [`/api/leads/${id}/follow-ups`],
    queryFn: () => fetch(`${BASE}/api/leads/${id}/follow-ups`, { credentials: "include" }).then(r => r.json()).then(d => Array.isArray(d) ? d : []),
  });

  const createFollowUp = useMutation({
    mutationFn: (body: any) =>
      fetch(`${BASE}/api/leads/${id}/follow-ups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) throw new Error("Failed"); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/follow-ups`] });
      resetFollowUpForm();
      toast({ title: "Follow-up scheduled" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleFollowUp = useMutation({
    mutationFn: ({ fuId, completed }: { fuId: number; completed: boolean }) =>
      fetch(`${BASE}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ completed }),
      }).then(r => { if (!r.ok) throw new Error("Failed"); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/follow-ups`] });
      toast({ title: "Follow-up updated" });
    },
  });

  function handleStatusChange(status: string) {
    // Selecting "converted" must actually create/merge the student record,
    // not just flip the status string. Reuse the idempotent convert endpoint.
    if (status === "converted" && lead?.status !== "converted") {
      if (convertLead.isPending) return;
      convertLead.mutate(
        { id },
        {
          onSuccess: (result: any) => {
            const studentData = result?.student || result;
            const studentName = `${studentData?.firstName || ""} ${studentData?.lastName || ""}`.trim();
            toast({
              title: t("leadDetailPage.leadConverted"),
              description: result?.merged
                ? t("leadDetailPage.mergedWithExisting", { name: studentName })
                : t("leadDetailPage.newStudentCreated", { name: studentName }),
            });
            queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}`] });
            queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
            queryClient.invalidateQueries({ queryKey: ["/api/students"] });
          },
          onError: () => {
            toast({ title: t("leadDetailPage.conversionFailed"), variant: "destructive" });
          },
        }
      );
      return;
    }
    updateLead.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}`] });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          toast({ title: t("leadDetailPage.statusUpdated") });
        },
      }
    );
  }

  function handleConvert() {
    if (!confirm(t("leadDetailPage.convertConfirm"))) return;
    convertLead.mutate(
      { id },
      {
        onSuccess: (result: any) => {
          const studentData = result?.student || result;
          const studentName = `${studentData?.firstName || ""} ${studentData?.lastName || ""}`.trim();
          toast({
            title: t("leadDetailPage.leadConverted"),
            description: result?.merged
              ? t("leadDetailPage.mergedWithExisting", { name: studentName })
              : t("leadDetailPage.newStudentCreated", { name: studentName }),
          });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          setLocation(`${basePath}/leads`);
        },
        onError: () => {
          toast({ title: t("leadDetailPage.conversionFailed"), variant: "destructive" });
        },
      }
    );
  }

  async function handleAddNote() {
    if (!noteText.trim()) return;
    try {
      const csrfToken = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1] ? decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)![1]) : "";
      const resp = await fetch(`${BASE}/api/leads/${id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        credentials: "include",
        body: JSON.stringify({ content: noteText, isInternal: noteTab === "internal" }),
      });
      if (resp.ok) {
        setNoteText("");
        queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/notes`, noteTab] });
      }
    } catch {}
  }

  const deleteNote = useMutation({
    mutationFn: async (noteId: number) => {
      const csrfToken = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1]
        ? decodeURIComponent(document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)![1])
        : "";
      const resp = await fetch(`${BASE}/api/leads/${id}/notes/${noteId}`, {
        method: "DELETE",
        headers: { "x-csrf-token": csrfToken },
        credentials: "include",
      });
      if (!resp.ok && resp.status !== 204) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || "Failed to delete note");
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/notes`, "general"] });
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/notes`, "internal"] });
      toast({ title: "Note deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function handleDeleteNote(noteId: number) {
    if (!window.confirm("Delete this note? This action will be recorded in the audit log.")) return;
    deleteNote.mutate(noteId);
  }

  const editFollowUp = useMutation({
    mutationFn: ({ fuId, body }: { fuId: number; body: any }) =>
      fetch(`${BASE}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); }); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}/follow-ups`] });
      resetFollowUpForm();
      toast({ title: "Follow-up updated" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function resetFollowUpForm() {
    setShowFollowUpForm(false);
    setEditingFuId(null);
    setFuTitle("");
    setFuDate("");
    setFuTime("10:00");
    setFuNotes("");
  }

  function handleCreateFollowUp() {
    if (!fuTitle.trim() || !fuDate) return;
    const scheduledAt = new Date(`${fuDate}T${fuTime}`).toISOString();
    if (editingFuId) {
      editFollowUp.mutate({ fuId: editingFuId, body: { title: fuTitle, scheduledAt, notes: fuNotes || null } });
    } else {
      createFollowUp.mutate({ title: fuTitle, scheduledAt, notes: fuNotes || undefined });
    }
  }

  function startEditFollowUp(fu: any) {
    setEditingFuId(fu.id);
    setFuTitle(fu.title);
    const d = new Date(fu.scheduledAt);
    setFuDate(d.toISOString().slice(0, 10));
    setFuTime(d.toTimeString().slice(0, 5));
    setFuNotes(fu.notes || "");
    setShowFollowUpForm(true);
  }

  function isOverdue(scheduledAt: string) {
    return new Date(scheduledAt) < new Date();
  }

  return (
    <>
      <div className="w-full space-y-6 select-text">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation(`${basePath}/leads`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <StudentPhotoAvatar
            studentId={lead?.convertedStudentId ?? null}
            firstName={lead?.firstName}
            lastName={lead?.lastName}
            className="w-14 h-14 rounded-full shrink-0"
          />
          <div className="flex-1">
            {isLoading ? (
              <Skeleton className="h-8 w-48" />
            ) : (
              <h1 className="text-2xl font-display font-bold text-foreground">
                {lead?.firstName} {lead?.lastName}
              </h1>
            )}
            <p className="text-sm text-muted-foreground mt-0.5">{t("leadDetailPage.leadDetail")}</p>
          </div>
          {!isLoading && lead && (
            <div className="flex items-center gap-2">
              <QuickContactButtons
                name={`${lead.firstName} ${lead.lastName}`}
                email={lead.email}
                phone={lead.phone}
                entityType="lead"
                entityId={id}
                hideEmail={isAgent}
                hideWhatsApp={isAgent}
              />
              {lead.status !== "converted" ? (
                <Button
                  onClick={handleConvert}
                  disabled={convertLead.isPending}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white rounded-full shadow-md"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t("leadDetailPage.convertToStudent")}
                </Button>
              ) : lead.convertedStudentId ? (
                <Link href={`${basePath}/students/${lead.convertedStudentId}`}>
                  <Button className="bg-blue-600 hover:bg-blue-700 text-white rounded-full shadow-md">
                    <GraduationCap className="w-4 h-4 mr-2" />
                    {t("leadDetailPage.viewStudent")}
                  </Button>
                </Link>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex gap-1 border-b">
          <button
            type="button"
            onClick={() => setMainTab("overview")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${mainTab === "overview" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            data-testid="lead-tab-overview"
          >
            {t("leadDetailPage.general")}
          </button>
          <button
            type="button"
            onClick={() => setMainTab("documents")}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-1.5 ${mainTab === "documents" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
            data-testid="lead-tab-documents"
          >
            <FileText className="w-3.5 h-3.5" />
            {t("leadDetailPage.documents")} {leadDocs.length > 0 && <span className="text-xs">({leadDocs.length})</span>}
          </button>
        </div>

        {mainTab === "documents" ? (
          <div className="space-y-3">
            {isStaffUser && (
              <div className="flex justify-end">
                <Button size="sm" onClick={() => setUploadOpen(true)} data-testid="lead-doc-add">
                  <Plus className="w-4 h-4 mr-1.5" /> {t("leadDetailPage.addDocument")}
                </Button>
              </div>
            )}
            <LeadDocumentsTab
              docs={leadDocs}
              firstName={lead?.firstName || ""}
              lastName={lead?.lastName || ""}
            />
          </div>
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          <div className="min-w-0 space-y-4 md:col-span-2">
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold text-foreground">{t("leadDetailPage.contactInformation")}</h2>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setShowEditDialog(true)}>
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {canChangeStage ? (
                  <Select
                    value={lead?.status}
                    onValueChange={handleStatusChange}
                    disabled={updateLead.isPending || convertLead.isPending || isLoading}
                  >
                    <SelectTrigger className="w-36 rounded-full border-border">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {leadStatusOptions.map((s) => (
                        <SelectItem key={s} value={s}>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${getLeadStageColor(s)}`}>
                            {getLeadStageLabel(s)}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  lead?.status && (
                    <Badge className={`px-3 py-1 rounded-full text-xs font-medium border-0 ${getLeadStageColor(lead.status)}`}>
                      {getLeadStageLabel(lead.status)}
                    </Badge>
                  )
                )}
              </div>

              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-5 w-full" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <InfoRow icon={<Mail className="w-4 h-4" />} label={t("leadDetailPage.email")} value={lead?.email} />
                  <InfoRow icon={<Phone className="w-4 h-4" />} label={t("leadDetailPage.phone")} value={lead?.phone} />
                  <InfoRow icon={<BookOpen className="w-4 h-4" />} label={t("leadDetailPage.interestedProgramLabel")} value={lead?.interestedProgram} />
                  <InfoRow icon={<GraduationCap className="w-4 h-4" />} label={t("leadDetailPage.interestedUniversityLabel")} value={lead?.interestedUniversity} />
                  <InfoRow icon={<User className="w-4 h-4" />} label={t("leadDetailPage.sourceLabel")} value={lead?.source} />
                  <InfoRow icon={<DollarSign className="w-4 h-4" />} label={t("leadDetailPage.estimatedBudget")} value={estimatedBudgetDisplay} />
                </div>
              )}

              <div className="pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">{t("leadDetailPage.origin")}</p>
                <OriginSection originType={lead?.originType || "direct"} originDisplayName={lead?.originDisplayName} />
              </div>

              {(lead?.sourcePageUrl || lead?.utmSource || lead?.utmMedium || lead?.utmCampaign || lead?.utmTerm || lead?.utmContent) && (
                <div className="pt-2 border-t">
                  <p className="text-xs font-medium text-muted-foreground mb-2">{t("leadDetailPage.sourceInfo")}</p>
                  <div className="space-y-2 text-sm">
                    {lead?.sourcePageUrl && (
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-muted-foreground shrink-0" />
                        <Badge variant="secondary" className="max-w-full truncate text-xs" title={getLeadSourceLabel(lead?.source, lead.sourcePageUrl)}>
                          {getLeadSourceLabel(lead?.source, lead.sourcePageUrl)}
                        </Badge>
                      </div>
                    )}
                    {(lead?.utmSource || lead?.utmMedium || lead?.utmCampaign || lead?.utmTerm || lead?.utmContent) && (
                      <div className="flex flex-wrap gap-1.5">
                        {lead?.utmSource && <Badge variant="secondary" className="text-[10px]">utm_source: {lead.utmSource}</Badge>}
                        {lead?.utmMedium && <Badge variant="secondary" className="text-[10px]">utm_medium: {lead.utmMedium}</Badge>}
                        {lead?.utmCampaign && <Badge variant="secondary" className="text-[10px]">utm_campaign: {lead.utmCampaign}</Badge>}
                        {lead?.utmTerm && <Badge variant="secondary" className="text-[10px]">utm_term: {lead.utmTerm}</Badge>}
                        {lead?.utmContent && <Badge variant="secondary" className="text-[10px]">utm_content: {lead.utmContent}</Badge>}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {lead?.notes && (
                <div className="pt-2 border-t">
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t("leadDetailPage.initialNotes")}</p>
                  <p className="text-sm text-foreground">{lead.notes}</p>
                </div>
              )}
            </div>

            {/* Follow-ups */}
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-muted-foreground" />
                  <h2 className="font-semibold text-foreground">{t("leadDetailPage.followUps")}</h2>
                  <span className="text-xs text-muted-foreground">({(followUps as any[]).length})</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setShowFollowUpForm(!showFollowUpForm)}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add
                </Button>
              </div>

              {showFollowUpForm && (
                <div className="bg-secondary/30 rounded-xl p-4 space-y-3 border">
                  <Input
                    placeholder={t("leadDetailPage.followUpTitlePlaceholder")}
                    value={fuTitle}
                    onChange={e => setFuTitle(e.target.value)}
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      type="date"
                      value={fuDate}
                      onChange={e => setFuDate(e.target.value)}
                      min={new Date().toISOString().slice(0, 10)}
                    />
                    <Input
                      type="time"
                      value={fuTime}
                      onChange={e => setFuTime(e.target.value)}
                    />
                  </div>
                  <Textarea
                    placeholder={t("leadDetailPage.notesOptional")}
                    value={fuNotes}
                    onChange={e => setFuNotes(e.target.value)}
                    className="resize-none min-h-[60px]"
                  />
                  <div className="flex gap-2 justify-end">
                    <Button variant="ghost" size="sm" onClick={resetFollowUpForm}>{t("leadDetailPage.cancel")}</Button>
                    <Button
                      size="sm"
                      onClick={handleCreateFollowUp}
                      disabled={(editingFuId ? editFollowUp.isPending : createFollowUp.isPending) || !fuTitle.trim() || !fuDate}
                    >
                      {editingFuId ? "Save" : "Schedule"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-2 max-h-60 overflow-y-auto">
                {(followUps as any[]).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No follow-ups scheduled.</p>
                ) : (
                  (followUps as any[]).map((fu: any) => (
                    <div
                      key={fu.id}
                      className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                        fu.completed
                          ? "bg-green-50/50 border-green-200"
                          : isOverdue(fu.scheduledAt)
                          ? "bg-red-50/50 border-red-200"
                          : "bg-secondary/30 border-border"
                      }`}
                    >
                      <button
                        onClick={() => toggleFollowUp.mutate({ fuId: fu.id, completed: !fu.completed })}
                        className={`mt-0.5 shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                          fu.completed
                            ? "bg-green-500 border-green-500 text-white"
                            : "border-muted-foreground/40 hover:border-primary"
                        }`}
                      >
                        {fu.completed && <CheckCircle2 className="w-3 h-3" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className={`text-sm font-medium ${fu.completed ? "line-through text-muted-foreground" : "text-foreground"}`}>
                            {fu.title}
                          </p>
                          {!fu.completed && (
                            <button
                              onClick={() => startEditFollowUp(fu)}
                              className="shrink-0 p-1 rounded hover:bg-secondary transition-colors"
                            >
                              <Pencil className="w-3 h-3 text-muted-foreground" />
                            </button>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <Clock className="w-3 h-3 text-muted-foreground" />
                          <span className={`text-xs ${
                            fu.completed ? "text-muted-foreground" : isOverdue(fu.scheduledAt) ? "text-red-600 font-semibold" : "text-muted-foreground"
                          }`}>
                            {formatDate(fu.scheduledAt, lang, { day: "2-digit", month: "2-digit", year: "numeric" }, dateFormat)}
                            {" "}
                            {new Date(fu.scheduledAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                            {!fu.completed && isOverdue(fu.scheduledAt) && " — Overdue"}
                          </span>
                        </div>
                        {fu.notes && <p className="text-xs text-muted-foreground mt-1">{fu.notes}</p>}
                        <div className="flex items-center gap-3 mt-1 flex-wrap">
                          {fu.createdByName && (
                            <span className="text-xs text-muted-foreground/60">by {fu.createdByName}</span>
                          )}
                          {fu.createdAt && (
                            <span className="text-xs text-muted-foreground/50">
                              {formatDate(fu.createdAt, lang, { day: "2-digit", month: "2-digit", year: "numeric" }, dateFormat)}
                              {" "}
                              {new Date(fu.createdAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                          {fu.updatedAt && fu.createdAt && new Date(fu.updatedAt).getTime() - new Date(fu.createdAt).getTime() > 2000 && (
                            <span className="text-xs text-amber-500/70">
                              (edited{fu.updatedByName ? ` by ${fu.updatedByName}` : ""} {formatDate(fu.updatedAt, lang, { day: "2-digit", month: "2-digit", year: "numeric" }, dateFormat)}
                              {" "}
                              {new Date(fu.updatedAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Notes */}
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-foreground">Notes</h2>
              </div>

              <div className="flex gap-1 border-b">
                <button
                  onClick={() => setNoteTab("general")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "general" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  General ({generalNotes.length})
                </button>
                {isStaffUser && (
                  <button
                    onClick={() => setNoteTab("internal")}
                    className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "internal" ? "border-orange-500 text-orange-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    🔒 Private ({internalNotes.length})
                  </button>
                )}
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto">
                {activeNotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No notes yet.</p>
                ) : (
                  activeNotes.map((note: any) => (
                    <div key={note.id} className={`group relative rounded-xl p-3 ${noteTab === "internal" ? "bg-orange-50 border border-orange-200" : "bg-secondary/50"}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground whitespace-pre-wrap break-words">{note.content}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {note.authorName || "Team"} · {formatDate(note.createdAt, lang)}
                          </p>
                        </div>
                        {isStaffUser && (
                          <button
                            type="button"
                            onClick={() => handleDeleteNote(note.id)}
                            disabled={deleteNote.isPending}
                            className="shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-50"
                            aria-label="Delete note"
                            title="Delete note"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {(noteTab === "general" || isStaffUser) && (
                <div className="flex gap-2 pt-2 border-t">
                  <Textarea
                    placeholder={noteTab === "internal" ? "Add a private note (only visible to staff)..." : "Add a note..."}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    className={`resize-none min-h-[72px] ${noteTab === "internal" ? "border-orange-300 focus-visible:ring-orange-400" : ""}`}
                  />
                  <Button
                    onClick={handleAddNote}
                    disabled={!noteText.trim()}
                    className={`self-end ${noteTab === "internal" ? "bg-orange-500 hover:bg-orange-600" : ""}`}
                  >
                    Add
                  </Button>
                </div>
              )}
            </div>

          </div>

          {/* Right: status card */}
          <div className="min-w-0 space-y-4">
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground">Status</h2>
              {isLoading ? (
                <Skeleton className="h-8 w-24 rounded-full" />
              ) : (
                <Badge
                  className={`px-3 py-1 rounded-full text-sm font-medium border-0 ${getLeadStageColor(lead?.status ?? "new")}`}
                >
                  {getLeadStageLabel(lead?.status)}
                </Badge>
              )}
              {/* T8: Admin can change lead status (incl. lost = inactive) */}
              {canChangeStage && lead && (
                <Select
                  value={lead.status || "new"}
                  onValueChange={(val) => {
                    updateLead.mutate({ id: lead.id, data: { status: val } } as any, {
                      onSuccess: (updated: any) => {
                        queryClient.setQueryData([`/api/leads/${id}`], updated);
                        queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}`] });
                        queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
                        toast({ title: t("leadDetailPage.statusUpdated") });
                      },
                      onError: (err: any) => {
                        toast({ title: t("studentDetailPage.failedToUpdateStatus"), description: err?.message, variant: "destructive" });
                      },
                    });
                  }}
                >
                  <SelectTrigger className="w-full h-8 text-sm" data-testid="lead-status-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {leadStatusOptions.map((stageKey) => (
                      <SelectItem key={stageKey} value={stageKey}>
                        {getLeadStageLabel(stageKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="pt-2 border-t text-xs text-muted-foreground space-y-1">
                <p>Created: {lead ? formatDate(lead.createdAt, lang) : "—"}</p>
                <p>Updated: {lead ? formatDate(lead.updatedAt, lang) : "—"}</p>
              </div>
            </div>

            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <User className="w-4 h-4" />
                {t("leadDetailPage.assignedTo")}
              </h2>
              {isLoading ? (
                <Skeleton className="h-8 w-32" />
              ) : canAssignLead ? (
                <Select
                  value={lead?.assignedToId ? String(lead.assignedToId) : "unassigned"}
                  onValueChange={(val) => handleAssign(val === "unassigned" ? null : Number(val))}
                  disabled={assigning}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("leadDetailPage.selectAssignee")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">{t("leadDetailPage.unassigned")}</SelectItem>
                    {assigneeOptions.map((u: any) => {
                      const label = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
                      return (
                        <SelectItem key={u.id} value={String(u.id)}>
                          {u.id === user?.id ? `${label} (${t("leadDetailPage.you")})` : label}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : canSelfAssign ? (
                <button
                  onClick={() => handleAssign(user!.id)}
                  disabled={assigning}
                  className="text-sm text-primary hover:underline font-medium flex items-center gap-1 disabled:opacity-50"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  {assigning ? t("leadDetailPage.assigning") : t("leadDetailPage.assignToMe")}
                </button>
              ) : lead?.assignedToId ? (
                <div className="flex items-center gap-2">
                  <UserCheck2 className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm font-medium">{getAssignedUserName(lead.assignedToId)}</span>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">{t("leadDetailPage.unassigned")}</p>
              )}
            </div>

            {!isAgent && (
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <Globe className="w-4 h-4" />
                Origin
              </h2>
              {isLoading ? (
                <Skeleton className="h-8 w-32" />
              ) : (
                <div className="space-y-2">
                  <OriginBadge originType={lead?.originType || "direct"} originDisplayName={lead?.originDisplayName} className="text-xs" />
                  {isAdmin && (
                    <Select
                      value={lead?.originType || "direct"}
                      onValueChange={(val) => {
                        updateLead.mutate({
                          id: lead!.id,
                          data: {
                            originType: val,
                            originDisplayName: val === "direct" ? "Find And Study" : null,
                          },
                        } as any, {
                          onSuccess: (updated: any) => {
                            queryClient.setQueryData([`/api/leads/${id}`], updated);
                            queryClient.invalidateQueries({ queryKey: [`/api/leads/${id}`] });
                            queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
                            toast({ title: "Origin updated" });
                          },
                          onError: (err: any) => {
                            toast({ title: "Failed to update origin", description: err?.message, variant: "destructive" });
                          },
                        });
                      }}
                    >
                      <SelectTrigger className="w-full h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">{t("leadDetailPage.direct")}</SelectItem>
                        <SelectItem value="agent">{t("leadDetailPage.agentLabel")}</SelectItem>
                        <SelectItem value="sub_agent">Sub-Agent</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>
            )}

            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <CalendarClock className="w-4 h-4" />
                Next Follow-up
              </h2>
              {(() => {
                const upcoming = (followUps as any[]).filter((f: any) => !f.completed).sort((a: any, b: any) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
                if (upcoming.length === 0) return <p className="text-sm text-muted-foreground">None scheduled</p>;
                const next = upcoming[0];
                return (
                  <div>
                    <p className="text-sm font-medium">{next.title}</p>
                    <p className={`text-xs mt-1 ${isOverdue(next.scheduledAt) ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                      {formatDate(next.scheduledAt, lang, { day: "2-digit", month: "2-digit", year: "numeric" }, dateFormat)}
                      {" "}
                      {new Date(next.scheduledAt).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" })}
                      {isOverdue(next.scheduledAt) && " — Overdue!"}
                    </p>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
        )}
        <div className="space-y-3">
          <h2 className="font-semibold text-foreground flex items-center gap-2">
            <MessageSquare className="w-4 h-4" /> {t("common.allMessaging")}
          </h2>
          <AllMessagingHistory type="lead" id={Number(id)} />
        </div>
        {lead && <AuditLogSection resource="lead" resourceId={lead.id} />}
      </div>
      {lead && (
        <EditLeadDetailDialog
          open={showEditDialog}
          onClose={() => setShowEditDialog(false)}
          lead={lead}
          leadId={id}
        />
      )}
      {isStaffUser && (
        <LeadDocUploadDialog
          open={uploadOpen}
          onClose={() => setUploadOpen(false)}
          leadId={id}
          docOptions={docCatalogOptions}
          onUploaded={() => queryClient.invalidateQueries({
            predicate: (query) => query.queryKey.some((key) =>
              typeof key === "string" && (
                key.includes("document") ||
                key.includes("student") ||
                key.includes("application") ||
                key.includes(`/api/leads/${id}`)
              )
            ),
          })}
        />
      )}
    </>
  );
}

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
    <>
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
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function MultiCountrySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { data: cfFilters } = useQuery<{ countries: string[] }>({
    queryKey: ["course-finder-filters"],
    queryFn: () => customFetch("/api/course-finder/filters"),
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
    <>
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
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${localSelected.includes(c.name) ? "bg-primary/10 font-medium" : ""}`}
              onClick={e => { e.preventDefault(); e.stopPropagation(); toggle(c.name); }}>
              <Checkbox checked={localSelected.includes(c.name)} className="pointer-events-none" />
              <CountryFlag code={c.code} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function EditLeadDetailDialog({ open, onClose, lead, leadId }: {
  open: boolean; onClose: () => void; lead: any; leadId: number;
}) {
  const { t } = useI18n();
  const { hasPermission } = useAuth();
  const canSeeRevenue = hasPermission("leads.view_commission");
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "",
    source: "website", interestedProgram: "", interestedUniversity: "", interestedCountry: "", nationality: "", estimatedValue: "",
    interestedLevel: "",
  });
  const updateLead = useUpdateLead();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { levels: studyLevels } = useStudyLevels();

  useEffect(() => {
    if (open && lead) {
      setForm({
        firstName: lead.firstName || "", lastName: lead.lastName || "",
        email: lead.email || "", phone: toPhoneFieldValue(lead.phoneE164 || lead.phone),
        source: lead.source || "website", interestedProgram: lead.interestedProgram || "",
        interestedUniversity: lead.interestedUniversity || "",
        interestedCountry: lead.interestedCountry || "", nationality: lead.nationality || "",
        estimatedValue: lead.estimatedValue ? String(lead.estimatedValue) : "",
        interestedLevel: lead.interestedLevel || "",
      });
    }
  }, [open, lead]);

  function handleSave() {
    if (!form.firstName || !form.lastName || !isPhoneFieldValid(form.phone)) return;
    const payload: any = { ...form, phone: form.phone || "" };
    const parsedVal = parseFloat(form.estimatedValue);
    if (form.estimatedValue && !isNaN(parsedVal)) payload.estimatedValue = parsedVal;
    else delete payload.estimatedValue;

    updateLead.mutate(
      { id: leadId, data: payload },
      {
        onSuccess: () => {
          toast({ title: "Lead updated" });
          queryClient.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
          queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
          onClose();
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update lead", variant: "destructive" });
        },
      }
    );
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{t("leadDetailPage.editLead")}</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-4 py-2">
          <div className="space-y-1.5">
            <Label>First Name *</Label>
            <Input value={form.firstName} onChange={e => setForm({ ...form, firstName: e.target.value.toUpperCase().replace(/[^A-ZÀ-ÖØ-Þ\s'-]/g, "") })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>Last Name *</Label>
            <Input value={form.lastName} onChange={e => setForm({ ...form, lastName: e.target.value.toUpperCase().replace(/[^A-ZÀ-ÖØ-Þ\s'-]/g, "") })} className="uppercase" />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.email")}</Label>
            <Input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.phone")}</Label>
            <PhoneField value={form.phone} onChange={v => setForm({ ...form, phone: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.nationality")}</Label>
            <NationalityCombobox value={form.nationality} onChange={v => setForm({ ...form, nationality: v })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.source")}</Label>
            <Select value={form.source} onValueChange={v => setForm({ ...form, source: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCES.map(s => (
                  <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, " ")}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.interestedProgram")}</Label>
            <Input value={form.interestedProgram} onChange={e => setForm({ ...form, interestedProgram: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.interestedUniversity")}</Label>
            <Input value={form.interestedUniversity} onChange={e => setForm({ ...form, interestedUniversity: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("leadDetailPage.interestedCountry")}</Label>
            <MultiCountrySelect value={form.interestedCountry} onChange={v => setForm({ ...form, interestedCountry: v })} />
          </div>
          <div className="space-y-1.5 col-span-2">
            <Label>{t("studentsPage.interestedLevel")}</Label>
            <Select value={form.interestedLevel} onValueChange={v => setForm({ ...form, interestedLevel: v })}>
              <SelectTrigger><SelectValue placeholder="Select level..." /></SelectTrigger>
              <SelectContent>
                {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {canSeeRevenue && (
            <div className="space-y-1.5 col-span-2">
              <Label>Estimated Value (USD)</Label>
              <Input type="number" min="0" step="100" value={form.estimatedValue} onChange={e => setForm({ ...form, estimatedValue: e.target.value })} />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("leadDetailPage.cancel")}</Button>
          <Button onClick={handleSave} disabled={updateLead.isPending || !form.firstName || !form.lastName}>
            {updateLead.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function InfoRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value?: string | null;
}) {
  return (
    <>
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="font-medium text-foreground break-words select-text">{value || "—"}</p>
      </div>
    </div>
    </>
  );
}

const LEAD_DOC_TYPE_LABELS: Record<string, string> = {
  passport: "Pasaport",
  photo: "Vesikalık Fotoğraf",
  photograph: "Vesikalık Fotoğraf",
  hs_diploma: "Lise Diploması",
  hs_transcript: "Lise Transkripti",
  bachelor_diploma: "Lisans Diploması",
  bachelor_transcript: "Lisans Transkripti",
  master_diploma: "Yüksek Lisans Diploması",
  master_transcript: "Yüksek Lisans Transkripti",
  language_proof: "Dil Belgesi",
  equivalency_letter: "Denklik Belgesi",
  cv: "CV",
  motivation_letter: "Niyet Mektubu",
  reference_letter: "Referans Mektubu",
  other: "Diğer",
};

function formatBytes(n?: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadLeadDoc(doc: any, firstName: string, lastName: string) {
  const mimeType = doc.mimeType || "application/octet-stream";
  const ext = mimeType === "application/pdf" ? ".pdf"
    : mimeType.startsWith("image/") ? `.${mimeType.split("/")[1] || "img"}`
    : "";
  const label = LEAD_DOC_TYPE_LABELS[doc.type] || doc.type || "document";
  const fullName = `${firstName} ${lastName}`.trim() || "lead";
  const baseName = `${fullName} - ${label}`.replace(/[\\/:*?"<>|]/g, "_");
  const filename = baseName.endsWith(ext) ? baseName : `${baseName}${ext}`;
  if (doc.fileKey) {
    const link = document.createElement("a");
    link.href = `${BASE}/api/documents/${doc.id}/download?filename=${encodeURIComponent(filename)}`;
    link.download = filename;
    link.click();
  } else if (doc.fileData) {
    const link = document.createElement("a");
    link.href = `data:${mimeType};base64,${doc.fileData}`;
    link.download = filename;
    link.click();
  } else if (doc.fileUrl) {
    const link = document.createElement("a");
    link.href = doc.fileUrl;
    link.download = filename;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.click();
  }
}

function LeadDocumentsTab({ docs, firstName, lastName }: {
  docs: any[];
  firstName: string;
  lastName: string;
}) {
  const { t, lang } = useI18n();
  const { getTriggerProps, dialog } = useDocumentPreview();

  // Track every blob: URL we create so they can be revoked on unmount. We revoke
  // only on unmount (not when `docs` changes) so a blob that is still being shown
  // in the open modal or a freshly opened background tab is never invalidated.
  const createdBlobUrls = useRef<string[]>([]);

  // Pre-build preview targets. Lead-only documents stored as base64 are turned
  // into blob: URLs because the per-document download endpoint is not accessible
  // to all roles for leads (no studentId). A real href lets a middle click open
  // the file in a background tab without navigating away from the page.
  const previewTargets = useMemo(() => {
    const map = new Map<number, PreviewTarget>();
    for (const d of docs || []) {
      const kind = getPreviewKind(d.mimeType);
      if (d.fileKey) {
        map.set(d.id, {
          href: `${BASE}/api/documents/${d.id}/download?disposition=inline`,
          downloadHref: `${BASE}/api/documents/${d.id}/download`,
          kind,
          name: d.name,
        });
      } else if (d.fileData) {
        try {
          const mime = d.mimeType || "application/octet-stream";
          const byteChars = atob(d.fileData);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          const blob = new Blob([bytes], { type: mime });
          const url = URL.createObjectURL(blob);
          createdBlobUrls.current.push(url);
          map.set(d.id, { href: url, downloadHref: url, kind, name: d.name });
        } catch {
          /* ignore malformed base64 */
        }
      } else if (d.fileUrl) {
        map.set(d.id, { href: d.fileUrl, downloadHref: d.fileUrl, kind, name: d.name });
      }
    }
    return map;
  }, [docs]);

  useEffect(() => {
    return () => {
      for (const url of createdBlobUrls.current) {
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
      }
      createdBlobUrls.current = [];
    };
  }, []);

  if (!docs || docs.length === 0) {
    return (
      <div className="bg-card rounded-2xl border shadow-sm p-12 text-center text-muted-foreground">
        <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p className="font-medium">{t("common.leadNoDocsYet")}</p>
        <p className="text-xs mt-1">{t("common.leadNoDocsDesc")}</p>
      </div>
    );
  }
  return (
    <div className="bg-card rounded-2xl border shadow-sm overflow-hidden">
      {dialog}
      <table className="w-full text-sm">
        <thead className="bg-secondary/50">
          <tr>
            <th className="text-left px-4 py-3 font-semibold text-foreground">{t("leadDetailPage.tableFile")}</th>
            <th className="text-left px-4 py-3 font-semibold text-foreground">{t("leadDetailPage.tableType")}</th>
            <th className="text-left px-4 py-3 font-semibold text-foreground">{t("leadDetailPage.tableSize")}</th>
            <th className="text-left px-4 py-3 font-semibold text-foreground">{t("leadDetailPage.tableUploaded")}</th>
            <th className="text-right px-4 py-3 font-semibold text-foreground">{t("leadDetailPage.tableActions")}</th>
          </tr>
        </thead>
        <tbody>
          {docs.map((doc: any) => {
            const canPreview = !!(doc.fileKey || doc.fileData || doc.fileUrl);
            const previewTarget = previewTargets.get(doc.id);
            return (
              <tr key={doc.id} className="border-t hover:bg-primary/5 transition-colors" data-testid={`lead-doc-row-${doc.id}`}>
                <td className="px-4 py-3 font-medium">{doc.name}</td>
                <td className="px-4 py-3 text-muted-foreground">{LEAD_DOC_TYPE_LABELS[doc.type] || doc.type}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatBytes(doc.sizeBytes)}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDate(doc.createdAt, lang, "dateShort")}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-2">
                    {previewTarget && (
                      <a
                        {...getTriggerProps(previewTarget)}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium"
                        data-testid={`lead-doc-preview-${doc.id}`}
                      >
                        <Eye className="w-3.5 h-3.5" /> {t("leadDetailPage.preview")}
                      </a>
                    )}
                    {canPreview && (
                      <button
                        onClick={() => downloadLeadDoc(doc, firstName, lastName)}
                        className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium"
                        data-testid={`lead-doc-download-${doc.id}`}
                      >
                        <Download className="w-3.5 h-3.5" /> {t("leadDetailPage.download")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LeadDocUploadDialog({ open, onClose, leadId, docOptions, onUploaded }: {
  open: boolean;
  onClose: () => void;
  leadId: number;
  docOptions: { value: string; label: string }[];
  onUploaded: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [docType, setDocType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setDocType("");
    setFile(null);
  }

  function handleClose() {
    if (!uploading) {
      reset();
      onClose();
    }
  }

  async function handleUpload() {
    if (!docType) {
      toast({ title: t("leadDetailPage.selectDocTypeFirst"), variant: "destructive" });
      return;
    }
    if (!file) {
      toast({ title: t("leadDetailPage.selectFileFirst"), variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(file);
      await customFetch(`/api/leads/${leadId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: docType, fileKey, mimeType, sizeBytes, originalFileName: file.name }),
      });
      toast({ title: t("leadDetailPage.documentUploaded") });
      reset();
      onUploaded();
      onClose();
    } catch (err: any) {
      toast({ title: t("common.error"), description: err?.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5 text-primary" />
            {t("leadDetailPage.addDocument")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">{t("leadDetailPage.documentType")}</Label>
            {docOptions.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("leadDetailPage.noDocTypes")}</p>
            ) : (
              <Select value={docType} onValueChange={setDocType} disabled={uploading}>
                <SelectTrigger data-testid="lead-doc-type-select">
                  <SelectValue placeholder={t("leadDetailPage.selectDocType")} />
                </SelectTrigger>
                <SelectContent>
                  {docOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-semibold">{t("leadDetailPage.file")}</Label>
            <div
              onClick={() => { if (!uploading) fileInputRef.current?.click(); }}
              className="border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
            >
              <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground truncate">
                {file ? file.name : t("leadDetailPage.clickToSelectFile")}
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="hidden"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={uploading}>{t("common.cancel")}</Button>
          <Button onClick={handleUpload} disabled={uploading || !docType || !file} data-testid="lead-doc-upload-submit">
            {uploading
              ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t("leadDetailPage.uploading")}</>
              : t("leadDetailPage.upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
