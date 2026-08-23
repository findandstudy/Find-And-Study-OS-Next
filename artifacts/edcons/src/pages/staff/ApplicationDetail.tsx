import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useEntityViewTracker } from "@/hooks/use-entity-view-tracker";
import {
  useGetApplication,
  useUpdateApplication,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";
import { formatDate } from "@workspace/i18n";
import { useI18n } from "@/hooks/use-i18n";
import { apiFetch } from "@/lib/apiFetch";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";
import { StageDocUploadDialog } from "@/components/StageDocUploadDialog";
import { StageDocRequestDialog } from "@/components/StageDocRequestDialog";
import { StageDocsIncompleteDialog } from "@/components/StageDocsIncompleteDialog";
import { requestStageChange, type MissingDocEntry } from "@/lib/stageTransition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  ArrowLeft, MessageSquare, User, BookOpen, DollarSign,
  MapPin, GraduationCap, Globe, Calendar, Pencil, TrendingUp,
  CalendarClock, CheckCircle2, Clock, Plus, Send, RotateCcw, XCircle, Hash,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { QuickContactButtons } from "@/components/QuickContact";
import { StageDocumentsPanel } from "@/components/StageDocumentsPanel";
import { ApplicationDocumentsPanel, APPLICATION_DOC_STAGES } from "@/components/ApplicationDocumentsPanel";
import { AuditLogSection } from "@/components/AuditLogSection";
import { OriginBadge, OriginSection } from "@/components/OriginBadge";
import { useAuth } from "@/hooks/use-auth";
import { StudentDocChecklist } from "@/components/StudentDocChecklist";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import PortalSubmissionPanel from "@/components/PortalSubmissionPanel";
import { StudentPhotoAvatar } from "@/components/StudentPhotoAvatar";

function formatCurrency(v: number | string | null | undefined) {
  if (!v) return "—";
  const num = typeof v === "string" ? parseFloat(v) : v;
  if (isNaN(num)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
}

function getStageColor(stageKey: string) {
  const colors: Record<string, string> = {
    inquiry: "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300",
    documents_collected: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    submitted: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    offer_received: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    visa_applied: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
    visa_approved: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
    enrolled: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    rejected: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  };
  return colors[stageKey] || "bg-gray-100 text-gray-700 dark:bg-gray-800/50 dark:text-gray-300";
}

interface Props {
  id: number;
  basePath?: string;
}


export default function ApplicationDetail({ id, basePath = "/staff" }: Props) {
  const { t } = useI18n();
  const { labelOf: studyLabelOf } = useStudyLevels();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  useEntityViewTracker("application", id);
  const queryClient = useQueryClient();
  const isAgent = basePath === "/agent";
  const [noteText, setNoteText] = useState("");
  const [noteTab, setNoteTab] = useState<"general" | "internal">("general");
  const [editOpen, setEditOpen] = useState(false);
  const [stageDocUpload, setStageDocUpload] = useState<{ targetStage: string; targetStageLabel: string } | null>(null);
  const [studentDocsMissing, setStudentDocsMissing] = useState<string[] | null>(null);
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [editingFuId, setEditingFuId] = useState<number | null>(null);
  const [fuTitle, setFuTitle] = useState("");
  const [fuDate, setFuDate] = useState("");
  const [fuTime, setFuTime] = useState("10:00");
  const [fuNotes, setFuNotes] = useState("");
  // Task #269 — shared document-request / incomplete-docs flow.
  const [docRequestDialog, setDocRequestDialog] = useState<{ stage: string; stageLabel: string; suggestedDocTypes: string[]; title: string | null; retryTarget: string } | null>(null);
  const [docsIncompleteDialog, setDocsIncompleteDialog] = useState<{ currentStageLabel: string; missing: MissingDocEntry[]; retryTarget: string } | null>(null);
  const { user: authUser, hasPermission, hasAgentStaffPermission } = useAuth();
  const canSeeCommission = hasPermission("applications.view_commission");
  const isAdmin = authUser && ["super_admin", "admin", "manager"].includes(authUser.role);
  const canChangeStage = !!isAdmin || hasPermission("applications.change_stage");
  const isStaffUser = authUser && ["super_admin", "admin", "manager", "staff"].includes(authUser.role);

  const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  const { data: app, isLoading } = useGetApplication(id) as { data: any; isLoading: boolean };

  const { data: generalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/applications/${id}/notes`, "general"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/applications/${id}/notes?internal=false`);
      const body = await res.json().catch(() => []);
      return Array.isArray(body) ? body : [];
    },
    enabled: !!id,
  });
  const { data: internalNotes = [] } = useQuery<any[]>({
    queryKey: [`/api/applications/${id}/notes`, "internal"],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/applications/${id}/notes?internal=true`);
      const body = await res.json().catch(() => []);
      return Array.isArray(body) ? body : [];
    },
    enabled: !!id && !!isStaffUser,
  });

  const activeNotes = Array.isArray(noteTab === "internal" ? internalNotes : generalNotes)
    ? (noteTab === "internal" ? internalNotes : generalNotes)
    : [];
  const { stages: pipelineStages } = usePipelineStages("application");
  const updateApp = useUpdateApplication();
  // Task #269 — routes the centralized PATCH's document-gating 422 responses to
  // the matching modal (doc-request on entry, incomplete-docs on forward move,
  // file upload, student docs). Returns true once the move completes.
  async function handleStageChange(stage: string): Promise<boolean> {
    const stageLabelOf = (key: string) => pipelineStages.find(s => s.key === key)?.label ?? key;
    const result = await requestStageChange(Number(id), stage);
    switch (result.kind) {
      case "ok":
        queryClient.invalidateQueries({ queryKey: [`/api/applications/${id}`] });
        toast({ title: t("applicationDetailPage.stageUpdated") });
        return true;
      case "doc_selection_required":
        setDocRequestDialog({
          stage: result.requiredStage,
          stageLabel: stageLabelOf(result.requiredStage),
          suggestedDocTypes: result.suggestedDocTypes,
          title: result.actionLabel,
          retryTarget: stage,
        });
        return false;
      case "docs_incomplete":
        setDocsIncompleteDialog({
          currentStageLabel: stageLabelOf(result.currentStage),
          missing: result.missing,
          retryTarget: stage,
        });
        return false;
      case "docs_required":
        setStageDocUpload({ targetStage: stage, targetStageLabel: stageLabelOf(stage) });
        return false;
      case "student_docs_required":
        setStudentDocsMissing(result.missingDocTypes);
        return false;
      default:
        toast({ title: t("applicationDetailPage.errorTitle"), description: result.message || t("applicationDetailPage.couldNotUpdateStage"), variant: "destructive" });
        return false;
    }
  }

  async function handleAddNote() {
    if (!noteText.trim()) return;
    try {
      const resp = await apiFetch(`${BASE_URL}/api/applications/${id}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: noteText, isInternal: noteTab === "internal" }),
      });
      if (resp.ok) {
        setNoteText("");
        queryClient.invalidateQueries({ queryKey: [`/api/applications/${id}/notes`, noteTab] });
      }
    } catch {}
  }

  const { data: studentDocs = [] } = useQuery<any[]>({
    queryKey: [`student-docs-for-app-${app?.studentId}`],
    queryFn: async () => {
      const res = await apiFetch(`${BASE_URL}/api/documents?studentId=${app!.studentId}`);
      return res.json();
    },
    enabled: !!app?.studentId,
    staleTime: 30_000,
  });

  // Follow-ups are tied to the student, not the application — the same list is
  // shared across all of a student's applications and their student profile.
  // Reuse the existing student follow-up endpoints with app.studentId.
  const { data: followUps = [] } = useQuery<any[]>({
    queryKey: [`/api/students/${app?.studentId}/follow-ups`],
    queryFn: () => apiFetch(`${BASE_URL}/api/students/${app!.studentId}/follow-ups`).then(r => r.json()).then(d => Array.isArray(d) ? d : []),
    enabled: !!app?.studentId && !!isStaffUser,
  });

  const createFollowUp = useMutation({
    mutationFn: (body: any) =>
      apiFetch(`${BASE_URL}/api/students/${app!.studentId}/follow-ups`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); }); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/students/${app?.studentId}/follow-ups`] });
      resetFollowUpForm();
      toast({ title: "Follow-up scheduled" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleFollowUp = useMutation({
    mutationFn: ({ fuId, completed }: { fuId: number; completed: boolean }) =>
      apiFetch(`${BASE_URL}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed }),
      }).then(r => { if (!r.ok) throw new Error("Failed"); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/students/${app?.studentId}/follow-ups`] });
      toast({ title: "Follow-up updated" });
    },
  });

  const editFollowUp = useMutation({
    mutationFn: ({ fuId, body }: { fuId: number; body: any }) =>
      apiFetch(`${BASE_URL}/api/follow-ups/${fuId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(r => { if (!r.ok) return r.json().then(e => { throw new Error(e.error || "Failed"); }); return r.json(); }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/students/${app?.studentId}/follow-ups`] });
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

  const stageLabel = pipelineStages.find(s => s.key === app?.stage)?.label || app?.stage?.replace(/_/g, " ") || "—";
  const levelLabel = studyLabelOf(app?.level) || app?.level || "—";

  return (
    <>
      <div className="w-full space-y-6 select-text">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => setLocation(`${basePath}/applications`)}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <StudentPhotoAvatar
            studentId={app?.studentId ?? null}
            firstName={app?.studentFirstName}
            lastName={app?.studentLastName}
            className="w-14 h-14 rounded-full shrink-0"
          />
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <Skeleton className="h-8 w-48" />
            ) : app?.studentId ? (
              <h1
                role="link"
                tabIndex={0}
                onClick={() => setLocation(`${basePath}/students/${app.studentId}`)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLocation(`${basePath}/students/${app.studentId}`); } }}
                className="text-2xl font-display font-bold text-foreground truncate cursor-pointer hover:text-primary hover:underline transition-colors"
              >
                {app?.studentFirstName} {app?.studentLastName}
              </h1>
            ) : (
              <h1 className="text-2xl font-display font-bold text-foreground truncate">
                {app?.studentFirstName} {app?.studentLastName}
              </h1>
            )}
            <p className="text-sm text-muted-foreground mt-0.5">{t("applicationDetailPage.applicationHash", { id })}</p>
          </div>
          <div className="flex items-center gap-2">
            {!isLoading && (
              <Badge className={`capitalize px-3 py-1 rounded-full text-sm font-medium border-0 ${getStageColor(app?.stage ?? "inquiry")}`}>
                {stageLabel}
              </Badge>
            )}
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} className="gap-1.5">
              <Pencil className="w-3.5 h-3.5" /> {t("applicationDetailPage.edit")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
          <div className="min-w-0 space-y-4 md:col-span-2">
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold text-foreground">{t("applicationDetailPage.applicationDetails")}</h2>
                {canChangeStage ? (
                <Select
                  value={app?.stage}
                  onValueChange={handleStageChange}
                  disabled={updateApp.isPending || isLoading}
                >
                  <SelectTrigger className="w-48 rounded-full border-border">
                    <SelectValue placeholder={t("applicationDetailPage.changeStage")} />
                  </SelectTrigger>
                  <SelectContent>
                    {(() => {
                      // Agents must not see future pipeline stages anywhere.
                      if (!isAgent) return pipelineStages;
                      const currentIdx = pipelineStages.findIndex(s => s.key === app?.stage);
                      return currentIdx >= 0 ? pipelineStages.slice(0, currentIdx + 1) : pipelineStages;
                    })().map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        <span className="capitalize">{s.label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                ) : (
                  app?.stage && (
                    <span className="capitalize px-3 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">
                      {pipelineStages.find(s => s.key === app.stage)?.label ?? app.stage.replace(/_/g, " ")}
                    </span>
                  )
                )}
              </div>

              {isLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <InfoRow icon={<User className="w-4 h-4" />} label={t("applicationDetailPage.student")} value={app?.studentFirstName && app?.studentLastName ? `${app.studentFirstName} ${app.studentLastName}` : undefined} />
                  <InfoRow icon={<Globe className="w-4 h-4" />} label={t("applicationDetailPage.country")} value={app?.country} />
                  <InfoRow icon={<GraduationCap className="w-4 h-4" />} label={t("applicationDetailPage.university")} value={app?.universityName} />
                  <InfoRow icon={<Hash className="w-4 h-4" />} label={t("applicationDetailPage.universityApplicationId")} value={app?.universityApplicationId} />
                  <InfoRow icon={<BookOpen className="w-4 h-4" />} label={t("applicationDetailPage.program")} value={app?.programName} />
                  <InfoRow icon={<BookOpen className="w-4 h-4" />} label={t("applicationDetailPage.level")} value={levelLabel} />
                  <InfoRow icon={<Globe className="w-4 h-4" />} label={t("applicationDetailPage.language")} value={app?.instructionLanguage} />
                  <InfoRow icon={<Calendar className="w-4 h-4" />} label={t("applicationDetailPage.intake")} value={app?.intake} />
                  <InfoRow icon={<Calendar className="w-4 h-4" />} label={t("applicationDetailPage.deadline")} value={app?.deadline} />
                  <InfoRow icon={<DollarSign className="w-4 h-4" />} label={t("applicationDetailPage.tuitionFee")} value={formatCurrency(app?.tuitionFee)} />
                  <InfoRow icon={<DollarSign className="w-4 h-4" />} label={t("applicationDetailPage.scholarship")} value={formatCurrency(app?.scholarship)} />
                  {canSeeCommission && app?.commissionAmount && parseFloat(app.commissionAmount) > 0 && (
                    <InfoRow icon={<TrendingUp className="w-4 h-4" />} label={t("applicationDetailPage.commission")} value={formatCurrency(app.commissionAmount)} />
                  )}
                  {canSeeCommission && app?.commissionStatus && (
                    <InfoRow icon={<TrendingUp className="w-4 h-4" />} label={t("applicationDetailPage.commissionStatus")} value={app.commissionStatus.replace(/_/g, " ")} />
                  )}
                </div>
              )}

              <div className="pt-3 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">{t("applicationDetailPage.originLabel")}</p>
                <OriginSection originType={(app as any)?.originType || "direct"} originDisplayName={(app as any)?.originDisplayName} originStudentId={(app as any)?.originStudentId} />
              </div>

              {app?.notes && (
                <div className="pt-3 border-t">
                  <p className="text-xs font-medium text-muted-foreground mb-1">{t("applicationDetailPage.notes")}</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{app.notes}</p>
                </div>
              )}
            </div>

            {app && (
              <div className="bg-card rounded-2xl border shadow-sm p-4">
                <StudentDocChecklist
                  level={app.level}
                  documents={studentDocs}
                  programId={app.programId ?? null}
                />
              </div>
            )}

            {app && authUser && hasAgentStaffPermission("documents") && (
              <>
                <ApplicationDocumentsPanel
                  applicationId={id}
                  userRole={authUser.role}
                  userId={authUser.id}
                  currentStage={app.stage}
                />
                <StageDocumentsPanel
                  applicationId={id}
                  currentStage={app.stage}
                  userRole={authUser.role}
                  userId={authUser.id}
                  excludeStages={APPLICATION_DOC_STAGES}
                />
              </>
            )}

            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-muted-foreground" />
                <h2 className="font-semibold text-foreground">{t("applicationDetailPage.notes")}</h2>
              </div>

              <div className="flex gap-1 border-b">
                <button
                  onClick={() => setNoteTab("general")}
                  className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "general" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {t("applicationDetailPage.general")} ({generalNotes.length})
                </button>
                {isStaffUser && (
                  <button
                    onClick={() => setNoteTab("internal")}
                    className={`px-3 py-1.5 text-sm font-medium border-b-2 transition-colors ${noteTab === "internal" ? "border-orange-500 text-orange-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    🔒 {t("applicationDetailPage.private")} ({internalNotes.length})
                  </button>
                )}
              </div>

              <div className="space-y-3 max-h-60 overflow-y-auto">
                {activeNotes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("applicationDetailPage.noNotesYet")}</p>
                ) : (
                  activeNotes.map((note: any) => (
                    <div key={note.id} className={`rounded-xl p-3 ${noteTab === "internal" ? "bg-orange-50 border border-orange-200" : "bg-secondary/50"}`}>
                      <p className="text-sm text-foreground">{note.content}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {note.authorName || t("applicationDetailPage.team")} · {new Date(note.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  ))
                )}
              </div>

              {(noteTab === "general" || isStaffUser) && (
                <div className="flex gap-2 pt-2 border-t">
                  <Textarea
                    placeholder={noteTab === "internal" ? t("applicationDetailPage.addInternalNotePh") : t("applicationDetailPage.addNotePh")}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    className={`resize-none min-h-[72px] ${noteTab === "internal" ? "border-orange-300 focus-visible:ring-orange-400" : ""}`}
                  />
                  <Button
                    onClick={handleAddNote}
                    disabled={!noteText.trim()}
                    className={`self-end ${noteTab === "internal" ? "bg-orange-500 hover:bg-orange-600" : ""}`}
                  >
                    {t("applicationDetailPage.add")}
                  </Button>
                </div>
              )}
            </div>

            {app && isStaffUser && (
              <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CalendarClock className="w-4 h-4 text-primary" />
                    <h2 className="font-semibold text-foreground">Follow-ups</h2>
                    <span className="text-xs text-muted-foreground">({(followUps as any[]).length})</span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full"
                    onClick={() => { resetFollowUpForm(); setShowFollowUpForm(!showFollowUpForm); }}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add
                  </Button>
                </div>

                {showFollowUpForm && (
                  <div className="bg-secondary/30 rounded-xl p-4 space-y-3 border">
                    <Input
                      placeholder={t("studentDetailPage.followUpTitlePlaceholder")}
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
                      placeholder={t("studentDetailPage.notesOptional")}
                      value={fuNotes}
                      onChange={e => setFuNotes(e.target.value)}
                      className="resize-none min-h-[60px]"
                    />
                    <div className="flex gap-2 justify-end">
                      <Button variant="ghost" size="sm" onClick={resetFollowUpForm}>{t("studentDetailPage.cancel")}</Button>
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

                <div className="space-y-2 max-h-[400px] overflow-y-auto">
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
                              {formatDate(fu.scheduledAt, "tr", { day: "2-digit", month: "2-digit", year: "numeric" })}
                              {" "}
                              {new Date(fu.scheduledAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                              {!fu.completed && isOverdue(fu.scheduledAt) && " — Overdue"}
                            </span>
                          </div>
                          {fu.notes && <p className="text-xs text-muted-foreground mt-1">{fu.notes}</p>}
                          <div className="flex items-center gap-3 mt-1 flex-wrap">
                            {fu.createdByName && (
                              <span className="text-xs text-muted-foreground/60" data-testid="fu-created-by">by {fu.createdByName}</span>
                            )}
                            {fu.createdAt && (
                              <span className="text-xs text-muted-foreground/50">
                                {formatDate(fu.createdAt, "tr", { day: "2-digit", month: "2-digit", year: "numeric" })}
                                {" "}
                                {new Date(fu.createdAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                              </span>
                            )}
                            {fu.updatedAt && fu.createdAt && new Date(fu.updatedAt).getTime() - new Date(fu.createdAt).getTime() > 2000 && (
                              <span className="text-xs text-amber-500/70" data-testid="fu-edited-by">
                                (edited{fu.updatedByName ? ` by ${fu.updatedByName}` : ""} {formatDate(fu.updatedAt, "tr", { day: "2-digit", month: "2-digit", year: "numeric" })}
                                {" "}
                                {new Date(fu.updatedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })})
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

          </div>

          <div className="min-w-0 space-y-4">
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground">{t("applicationDetailPage.stageProgress")}</h2>
              {isLoading ? (
                <Skeleton className="h-8 w-28 rounded-full" />
              ) : (
                <div className="space-y-2">
                  {(() => {
                    // Agents must not see future pipeline stages — only the
                    // ones up to and including the current stage. Staff/admin
                    // see the full timeline.
                    if (!isAgent) return pipelineStages;
                    const currentIdx = pipelineStages.findIndex(s => s.key === app?.stage);
                    return currentIdx >= 0 ? pipelineStages.slice(0, currentIdx + 1) : pipelineStages;
                  })().map((stage) => (
                    <div
                      key={stage.key}
                      className={`flex items-center gap-2 text-xs py-1 ${app?.stage === stage.key ? "font-bold text-foreground" : "text-muted-foreground"}`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full ${app?.stage === stage.key ? "bg-primary" : "bg-border"}`}
                      />
                      <span className="capitalize">{stage.label}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="pt-2 border-t text-xs text-muted-foreground space-y-1">
                <p>{t("applicationDetailPage.created")}: {app ? new Date(app.createdAt).toLocaleDateString() : "—"}</p>
                {app?.updatedAt && <p>{t("applicationDetailPage.updated")}: {new Date(app.updatedAt).toLocaleDateString()}</p>}
                {app?.season && <p>{t("applicationDetailPage.season")}: {app.season}</p>}
              </div>
            </div>

            {app?.studentEmail && (
              <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
                <h2 className="font-semibold text-foreground text-sm">{t("applicationDetailPage.studentContact")}</h2>
                <div className="text-sm space-y-1.5">
                  <p className="text-foreground">{app.studentFirstName} {app.studentLastName}</p>
                  <p className="text-muted-foreground text-xs">{app.studentEmail}</p>
                  {app.studentPhone && <p className="text-muted-foreground text-xs">{app.studentPhone}</p>}
                </div>
                <QuickContactButtons
                  name={`${app.studentFirstName} ${app.studentLastName}`}
                  email={app.studentEmail}
                  phone={app.studentPhone}
                  entityType="application"
                  entityId={id}
                  hideEmail={isAgent}
                  hideWhatsApp={isAgent}
                />
              </div>
            )}

            {!isAgent && (
            <div className="bg-card rounded-2xl border shadow-sm p-6 space-y-3">
              <h2 className="font-semibold text-foreground flex items-center gap-2">
                <Globe className="w-4 h-4" />
                {t("applicationDetailPage.originLabel")}
              </h2>
              {isLoading ? (
                <Skeleton className="h-8 w-32" />
              ) : (
                <div className="space-y-2">
                  <OriginBadge originType={app?.originType || "direct"} originDisplayName={app?.originDisplayName} className="text-xs" />
                  {isAdmin && (
                    <Select
                      value={app?.originType || "direct"}
                      onValueChange={(val) => {
                        updateApp.mutate({
                          id: app!.id,
                          data: {
                            originType: val,
                            originDisplayName: val === "direct" ? "Find And Study" : null,
                          },
                        } as any);
                      }}
                    >
                      <SelectTrigger className="w-full h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="direct">{t("applicationDetailPage.direct")}</SelectItem>
                        <SelectItem value="agent">{t("applicationDetailPage.agentLabel")}</SelectItem>
                        <SelectItem value="sub_agent">{t("applicationDetailPage.subAgent")}</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>
            )}

            {app?.studentId && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation(`${basePath}/students/${app.studentId}`)}
              >
                <User className="w-4 h-4 mr-2" />
                {t("applicationDetailPage.viewStudentProfile")}
              </Button>
            )}
          </div>
        </div>
        {app && <AuditLogSection resource="application" resourceId={app.id} />}
        {app && (isStaffUser || hasAgentStaffPermission("applications")) && (
          <PortalSubmissionPanel applicationId={app.id} universityName={app.universityName} />
        )}
      </div>

      {app && (
        <EditApplicationInlineDialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          app={app}
          stages={pipelineStages}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: [`/api/applications/${id}`] });
            toast({ title: t("applicationDetailPage.applicationUpdated") });
          }}
        />
      )}
      {stageDocUpload && (
        <StageDocUploadDialog
          open={!!stageDocUpload}
          onClose={() => setStageDocUpload(null)}
          applicationId={id}
          targetStage={stageDocUpload.targetStage}
          targetStageLabel={stageDocUpload.targetStageLabel}
          onUploaded={() => {
            queryClient.invalidateQueries({ queryKey: [`/api/applications/${id}`] });
          }}
        />
      )}

      {/* Task #269 — document-request modal shown when moving INTO a stage with
          the "Belge Yükle" action. On save, retry the move. */}
      {docRequestDialog && (
        <StageDocRequestDialog
          open={!!docRequestDialog}
          onOpenChange={(o) => { if (!o) setDocRequestDialog(null); }}
          applicationId={Number(id)}
          stage={docRequestDialog.stage}
          stageLabel={docRequestDialog.stageLabel}
          suggestedDocTypes={docRequestDialog.suggestedDocTypes}
          title={docRequestDialog.title}
          onSaved={() => {
            const target = docRequestDialog.retryTarget;
            setDocRequestDialog(null);
            queryClient.invalidateQueries({ queryKey: [`/api/applications/${id}`] });
            void handleStageChange(target);
          }}
        />
      )}

      {/* Task #269 — incomplete-docs blocker on forward moves. */}
      {docsIncompleteDialog && (
        <StageDocsIncompleteDialog
          open={!!docsIncompleteDialog}
          onOpenChange={(o) => { if (!o) setDocsIncompleteDialog(null); }}
          applicationId={Number(id)}
          currentStageLabel={docsIncompleteDialog.currentStageLabel}
          missing={docsIncompleteDialog.missing}
          isAdmin={!!isAdmin}
          onRetry={() => {
            const target = docsIncompleteDialog.retryTarget;
            setDocsIncompleteDialog(null);
            void handleStageChange(target);
          }}
        />
      )}

      <Dialog open={!!studentDocsMissing} onOpenChange={() => setStudentDocsMissing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <GraduationCap className="w-5 h-5" />
              {t("applicationDetailPage.missingMandatoryDocs")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("applicationDetailPage.missingDocsDescription")}
            </p>
            <ul className="space-y-1.5">
              {(studentDocsMissing || []).map((docType) => {
                const labels: Record<string, string> = {
                  high_school_diploma_translation: "High School Diploma (Translation)",
                  class_10th_ssc_marks_sheet: "Class 10th/SSC Marks Sheet",
                  class_12th_hsc_certificate: "Class 12th/+2/HSC Certificate",
                  class_12th_hsc_marks_sheet: "Class 12th/+2/HSC Marks Sheet",
                  diploma_certificate: "Diploma Certificate",
                  diploma_transcript: "Diploma Transcript",
                  bachelors_certificate: "Bachelors Certificate",
                  bachelors_transcript: "Bachelors Transcript",
                  bachelors_provisional_certificate: "Bachelors Provisional Certificate",
                  bachelors_transcript_all_semesters: "Bachelors Transcript (All Semesters)",
                  masters_certificate: "Masters Certificate",
                  masters_transcript: "Masters Transcript",
                  masters_provisional_certificate: "Masters Provisional Certificate",
                  masters_transcript_all_semesters: "Masters Transcript (All Semesters)",
                  passport: "Passport",
                  cv: "CV / Resume",
                  lor: "Letter of Recommendation",
                  sop: "Statement of Purpose",
                  essay: "Essay",
                  experience_letters: "Experience Letters",
                  other_certificates_documents: "Other Certificates/Documents",
                  ielts_pte_gre_gmat_toefl_duolingo: "IELTS/PTE/GRE/GMAT/TOEFL/Duolingo",
                  photo: "Photo",
                  diploma_recognition: "Diploma Recognition",
                };
                return (
                  <li key={docType} className="flex items-center gap-2 text-sm text-red-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
                    {labels[docType] || docType}
                  </li>
                );
              })}
            </ul>
          </div>
          <DialogFooter className="gap-2">
            {app?.studentId && (
              <Button
                variant="outline"
                onClick={() => {
                  setStudentDocsMissing(null);
                  setLocation(`${basePath}/students/${app.studentId}`);
                }}
              >
                <User className="w-4 h-4 mr-2" />
                Öğrenci Profiline Git
              </Button>
            )}
            <Button variant="ghost" onClick={() => setStudentDocsMissing(null)}>
              Kapat
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EditApplicationInlineDialog({ open, onClose, app, stages, onSaved }: {
  open: boolean; onClose: () => void; app: any; stages: any[]; onSaved: () => void;
}) {
  const { t } = useI18n();
  const { levels: studyLevels } = useStudyLevels();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    stage: app?.stage || "",
    country: app?.country || "",
    universityName: app?.universityName || "",
    universityApplicationId: app?.universityApplicationId || "",
    programName: app?.programName || "",
    level: app?.level || "",
    instructionLanguage: app?.instructionLanguage || "",
    intake: app?.intake || "",
    deadline: app?.deadline || "",
    tuitionFee: app?.tuitionFee || "",
    scholarship: app?.scholarship || "",
    notes: app?.notes || "",
  });
  const [docUploadDialog, setDocUploadDialog] = useState<{ targetStage: string; targetStageLabel: string } | null>(null);
  const [docRequestDialog, setDocRequestDialog] = useState<{ stage: string; stageLabel: string; suggestedDocTypes: string[]; title: string | null } | null>(null);
  const [docsIncompleteDialog, setDocsIncompleteDialog] = useState<{ currentStageLabel: string; missing: MissingDocEntry[] } | null>(null);
  const { user: inlineAuthUser } = useAuth();
  const inlineIsAdmin = !!inlineAuthUser && ["super_admin", "admin", "manager"].includes(inlineAuthUser.role);
  const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

  async function handleSave() {
    const data: Record<string, any> = {};
    for (const [key, val] of Object.entries(form)) {
      const current = app?.[key];
      const currentNorm = current === null || current === undefined ? "" : String(current);
      const valNorm = val === null || val === undefined ? "" : String(val);
      if (valNorm !== currentNorm) data[key] = val === "" ? null : val;
    }
    if (Object.keys(data).length === 0) { onClose(); return; }

    setSaving(true);
    try {
      const csrfRaw = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
      const csrfToken = csrfRaw ? decodeURIComponent(csrfRaw) : "";
      const res = await fetch(`${BASE_URL}/api/applications/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (res.ok) {
        onSaved();
        onClose();
        return;
      }
      const body: { code?: string; error?: string; message?: string } =
        await res.json().catch(() => ({}));
      const stageLabelOf = (key: string) => stages.find((s: any) => s.key === key)?.label ?? key;
      if (res.status === 422 && (body as any).code === "DOC_SELECTION_REQUIRED") {
        const stage = (body as any).requiredStage || data.stage;
        setDocRequestDialog({
          stage,
          stageLabel: stageLabelOf(stage),
          suggestedDocTypes: Array.isArray((body as any).suggestedDocTypes) ? (body as any).suggestedDocTypes : [],
          title: typeof (body as any).actionLabel === "string" ? (body as any).actionLabel : null,
        });
        return;
      }
      if (res.status === 422 && (body as any).code === "DOCS_INCOMPLETE") {
        setDocsIncompleteDialog({
          currentStageLabel: stageLabelOf((body as any).currentStage || app?.stage || ""),
          missing: Array.isArray((body as any).missing) ? (body as any).missing : [],
        });
        return;
      }
      if (res.status === 422 && body.code === "DOCS_REQUIRED") {
        setDocUploadDialog({ targetStage: data.stage, targetStageLabel: stageLabelOf(data.stage) });
        return;
      }
      toast({
        title: `${t("applicationDetailPage.saveFailed")} (${res.status})`,
        description: body.error || body.message || res.statusText || t("applicationDetailPage.unknownServerError"),
        variant: "destructive",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("applicationDetailPage.requestNotSent");
      toast({
        title: t("applicationDetailPage.networkError"),
        description: message,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <>
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("applicationDetailPage.editApplication")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">{t("applicationDetailPage.stage")}</Label>
            <Select value={form.stage} onValueChange={v => setForm({ ...form, stage: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.country")}</Label>
            <Input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("applicationDetailPage.university")}</Label>
            <Input value={form.universityName} onChange={e => setForm({ ...form, universityName: e.target.value })} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("applicationDetailPage.universityApplicationId")}</Label>
            <Input
              value={form.universityApplicationId}
              maxLength={128}
              autoComplete="off"
              onChange={e => setForm({ ...form, universityApplicationId: e.target.value })}
            />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("applicationDetailPage.program")}</Label>
            <Input value={form.programName} onChange={e => setForm({ ...form, programName: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.level")}</Label>
            <Select value={form.level} onValueChange={v => setForm({ ...form, level: v })}>
              <SelectTrigger><SelectValue placeholder={t("applicationDetailPage.select")} /></SelectTrigger>
              <SelectContent>
                {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.language")}</Label>
            <Input value={form.instructionLanguage} onChange={e => setForm({ ...form, instructionLanguage: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.intake")}</Label>
            <Input value={form.intake} onChange={e => setForm({ ...form, intake: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.deadline")}</Label>
            <Input value={form.deadline} onChange={e => setForm({ ...form, deadline: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.tuitionFee")}</Label>
            <Input type="number" value={form.tuitionFee} onChange={e => setForm({ ...form, tuitionFee: e.target.value })} />
          </div>
          <div>
            <Label className="text-xs">{t("applicationDetailPage.scholarship")}</Label>
            <Input type="number" value={form.scholarship} onChange={e => setForm({ ...form, scholarship: e.target.value })} />
          </div>
          <div className="col-span-2">
            <Label className="text-xs">{t("applicationDetailPage.notes")}</Label>
            <Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="resize-none min-h-[60px]" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("applicationDetailPage.cancel")}</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {docUploadDialog && (
      <StageDocUploadDialog
        open={!!docUploadDialog}
        onClose={() => setDocUploadDialog(null)}
        applicationId={app.id}
        targetStage={docUploadDialog.targetStage}
        targetStageLabel={docUploadDialog.targetStageLabel}
        onUploaded={() => { onSaved(); onClose(); }}
      />
    )}
    {docRequestDialog && (
      <StageDocRequestDialog
        open={!!docRequestDialog}
        onOpenChange={(o) => { if (!o) setDocRequestDialog(null); }}
        applicationId={app.id}
        stage={docRequestDialog.stage}
        stageLabel={docRequestDialog.stageLabel}
        suggestedDocTypes={docRequestDialog.suggestedDocTypes}
        title={docRequestDialog.title}
        onSaved={() => {
          setDocRequestDialog(null);
          void handleSave();
        }}
      />
    )}
    {docsIncompleteDialog && (
      <StageDocsIncompleteDialog
        open={!!docsIncompleteDialog}
        onOpenChange={(o) => { if (!o) setDocsIncompleteDialog(null); }}
        applicationId={app.id}
        currentStageLabel={docsIncompleteDialog.currentStageLabel}
        missing={docsIncompleteDialog.missing}
        isAdmin={inlineIsAdmin}
        onRetry={() => {
          setDocsIncompleteDialog(null);
          void handleSave();
        }}
      />
    )}
    </>
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
