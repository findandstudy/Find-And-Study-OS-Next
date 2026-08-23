import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  ArrowRight,
  Building,
  Check,
  Loader2,
  Pencil,
  X,
  Plus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { customFetch } from "@workspace/api-client-react";
import type { InboxConversationDetailResponse } from "@workspace/api-client-react";
import { AiSummaryCard } from "./AiSummaryCard";
import { InboxStatusControl } from "./InboxStatusControl";
import { PhoneInput } from "@/components/ui/phone-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useCountrySearch } from "@/hooks/use-countries";
import { InboxStudentTab } from "./InboxStudentTab";
import type { SubmitReadyData } from "./InboxStudentTab";
import { InboxApplicationTab } from "./InboxApplicationTab";
import { InboxSubmitTab } from "./InboxSubmitTab";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface LeadDetailSidebarProps {
  detail: InboxConversationDetailResponse;
  conversationId?: number | null;
  documentLevel?: string | null;
  onDocumentLevelChange?: (level: string) => void;
  onOpenMatchDialog?: () => void;
  onSummarize: () => void;
  isSummarizing: boolean;
  onUpdated?: () => void;
  onSendApplicationDocument?: (document: {
    applicationId: number;
    documentId: number;
    fileName: string;
    mimeType?: string | null;
  }) => Promise<void>;
  applicationDocumentSendingDisabled?: boolean;
}

type LinkedType = "lead" | "student" | "agent";
type SidebarTab = "lead" | "documents" | "student" | "application";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="text-sm break-words">{value}</div>
    </div>
  );
}

function EditableField({
  label,
  value,
  fieldKey,
  editingKey,
  setEditingKey,
  onSave,
  saving,
  type = "text",
}: {
  label: string;
  value: string | null | undefined;
  fieldKey: string;
  editingKey: string | null;
  setEditingKey: (k: string | null) => void;
  onSave: (fieldKey: string, newValue: string) => Promise<void>;
  saving: boolean;
  type?: string;
}) {
  const [draft, setDraft] = useState("");
  const isEditing = editingKey === fieldKey;

  return (
    <div className="group" data-testid={`sidebar-field-${fieldKey}`}>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      {isEditing ? (
        <div className="flex items-center gap-1 mt-0.5">
          <Input
            autoFocus
            type={type}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onSave(fieldKey, draft);
              if (e.key === "Escape") setEditingKey(null);
            }}
            className="h-7 text-sm"
            data-testid={`sidebar-input-${fieldKey}`}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={saving}
            onClick={() => void onSave(fieldKey, draft)}
            data-testid={`sidebar-save-${fieldKey}`}
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Check className="w-3.5 h-3.5 text-emerald-600" />
            )}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            disabled={saving}
            onClick={() => setEditingKey(null)}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 min-w-0">
          <span className="text-sm break-words min-w-0">
            {value?.trim() ? value : "—"}
          </span>
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => {
              setDraft(value ?? "");
              setEditingKey(fieldKey);
            }}
            data-testid={`sidebar-edit-${fieldKey}`}
          >
            <Pencil className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

const EMPTY_UNM_FORM = {
  firstName: "",
  lastName: "",
  phone: "",
  email: "",
  country: "",
  interestedProgram: "",
  interestedUniversity: "",
};

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

export function LeadDetailSidebar({
  detail,
  conversationId,
  documentLevel,
  onDocumentLevelChange,
  onOpenMatchDialog,
  onSummarize,
  isSummarizing,
  onUpdated,
  onSendApplicationDocument,
  applicationDocumentSendingDisabled,
}: LeadDetailSidebarProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [activeTab, setActiveTab] = useState<SidebarTab>("lead");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [unmF, setUnmF] = useState(EMPTY_UNM_FORM);
  const [unmSubmitting, setUnmSubmitting] = useState(false);
  const [submitData, setSubmitData] = useState<SubmitReadyData | null>(null);
  const [pendingStudentId, setPendingStudentId] = useState<number | null>(null);
  // Program selected in the APPLICATION tab — shared with the DOCUMENTS tab so
  // the requirements list reflects the merged program+degree set.
  const [selectedProgram, setSelectedProgram] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Reset shared program selection when switching conversations
  useEffect(() => {
    setSelectedProgram(null);
  }, [conversationId]);

  // Once the backend resolves a converted lead to its canonical student, any
  // previously prepared create-student draft is stale and must not take
  // precedence over the existing student profile.
  useEffect(() => {
    if (detail.student) {
      setSubmitData(null);
      setPendingStudentId(null);
    }
  }, [detail.student]);

  const { data: countries = [] } = useCountrySearch("");
  const countryOptions = countries.map((c) => ({
    value: c.name,
    label: c.name,
  }));

  // Student wins over lead: if a person has been converted (lead → student),
  // the student record is the canonical identity. Lead is kept for history only.
  const linkedType: LinkedType | null = detail.student
    ? "student"
    : detail.lead
      ? "lead"
      : detail.agent
        ? "agent"
        : null;

  useEffect(() => {
    if (linkedType !== null) return;
    const ext = (detail as any).externalContact;
    const conv = (detail as any).conversation;
    const displayName = (ext?.displayName || conv?.title || "").trim();
    const nameParts = displayName.split(/\s+/);

    let autoEmail = ext?.email || "";
    if (!autoEmail && Array.isArray((detail as any).messages)) {
      for (const m of (detail as any).messages) {
        const match = (m as any).content?.match(EMAIL_RE);
        if (match) {
          autoEmail = match[0];
          break;
        }
      }
    }

    setUnmF({
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" "),
      phone: ext?.phone || "",
      email: autoEmail,
      country: "",
      interestedProgram: "",
      interestedUniversity: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const TABS: SidebarTab[] = ["lead", "documents", "student", "application"];

  const tabBar = (
    <div className="flex shrink-0 border-b">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => setActiveTab(tab)}
          className={`flex-auto whitespace-nowrap px-1 py-2 text-[10px] font-semibold uppercase tracking-normal transition-colors border-b-2 -mb-px ${
            activeTab === tab
              ? "border-primary text-primary bg-background"
              : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/40"
          }`}
        >
          {t(`inbox.sidebar.tabs.${tab}`)}
        </button>
      ))}
    </div>
  );

  const placeholder = (
    <div className="flex-1 flex items-center justify-center p-8 text-center">
      <p className="text-sm text-muted-foreground">
        {t("inbox.sidebar.tabs.comingSoon")}
      </p>
    </div>
  );

  if (activeTab === "documents") {
    return (
      <div
        className="flex flex-col h-full overflow-hidden"
        data-testid="lead-detail-sidebar"
      >
        {tabBar}
        {conversationId ? (
          <InboxStudentTab
            detail={detail}
            conversationId={conversationId}
            programId={selectedProgram?.id ?? null}
            programName={selectedProgram?.name ?? null}
            initialLevel={
              documentLevel ??
              detail.student?.interestedLevel ??
              detail.lead?.interestedLevel ??
              null
            }
            onLevelChange={onDocumentLevelChange}
            onUpdated={onUpdated}
            onReadyToSubmit={(data) => {
              setSubmitData(data);
              setActiveTab("student");
            }}
          />
        ) : (
          placeholder
        )}
      </div>
    );
  }

  if (activeTab === "student") {
    const studentForTab = detail.student;
    if (conversationId && submitData && !studentForTab) {
      // New-student creation draft is ready — show the submit form.
      return (
        <div
          className="flex flex-col h-full overflow-hidden"
          data-testid="lead-detail-sidebar"
        >
          {tabBar}
          <InboxSubmitTab
            conversationId={conversationId}
            data={submitData}
            onCreated={(sid) => {
              setSubmitData(null);
              setPendingStudentId(sid);
              setActiveTab("application");
              onUpdated?.();
            }}
            onBack={() => setActiveTab("documents")}
          />
        </div>
      );
    }
    if (studentForTab) {
      // Person is already a student — show their existing profile card.
      return (
        <div
          className="flex flex-col h-full overflow-hidden"
          data-testid="lead-detail-sidebar"
        >
          {tabBar}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <div className="mb-2">
                <h3 className="font-semibold text-base leading-tight break-words">
                  {studentForTab.firstName} {studentForTab.lastName}
                </h3>
              </div>
              <Badge variant="secondary" className="text-[10px]">
                {t("inbox.sidebar.typeStudent")}
              </Badge>
            </div>
            <div className="border-t pt-3">
              <InboxStatusControl
                entityType="student"
                entityId={studentForTab.id}
                status={studentForTab.status}
                label={`${t("inbox.sidebar.tabs.student")} · ${t("common.status")}`}
                onUpdated={onUpdated}
              />
            </div>
            <div className="space-y-2.5 border-t pt-3">
              {studentForTab.email && (
                <Field
                  label={t("inbox.sidebar.email")}
                  value={studentForTab.email}
                />
              )}
              {studentForTab.phone && (
                <Field
                  label={t("inbox.sidebar.phone")}
                  value={studentForTab.phone}
                />
              )}
              {studentForTab.interestedLevel && (
                <Field
                  label={t("inbox.sidebar.interestedLevel")}
                  value={studentForTab.interestedLevel}
                />
              )}
              {studentForTab.originDisplayName && (
                <Field
                  label={t("inbox.sidebar.origin")}
                  value={studentForTab.originDisplayName}
                />
              )}
            </div>
            <div className="pt-3 border-t">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => navigate(`/staff/students/${studentForTab.id}`)}
              >
                {t("inbox.sidebar.viewFullDetail")}
                <ArrowRight className="w-3.5 h-3.5 ms-1.5 rtl:rotate-180" />
              </Button>
            </div>
          </div>
        </div>
      );
    }
    // No student yet and no draft — prompt to analyse documents first.
    return (
      <div
        className="flex flex-col h-full overflow-hidden"
        data-testid="lead-detail-sidebar"
      >
        {tabBar}
        <div className="flex-1 flex items-center justify-center p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("inbox.studentTab.submitEmpty")}
          </p>
        </div>
      </div>
    );
  }

  if (activeTab === "application") {
    return (
      <div
        className="flex flex-col h-full overflow-hidden"
        data-testid="lead-detail-sidebar"
      >
        {tabBar}
        {conversationId ? (
          <InboxApplicationTab
            detail={detail}
            conversationId={conversationId}
            overrideStudentId={pendingStudentId ?? undefined}
            onUpdated={onUpdated}
            onProgramSelected={setSelectedProgram}
            onSendDocument={onSendApplicationDocument}
            documentSendingDisabled={applicationDocumentSendingDisabled}
          />
        ) : (
          placeholder
        )}
      </div>
    );
  }

  if (activeTab !== "lead") {
    return (
      <div
        className="flex flex-col h-full overflow-hidden"
        data-testid="lead-detail-sidebar"
      >
        {tabBar}
        {placeholder}
      </div>
    );
  }

  // ── LEAD TAB ──────────────────────────────────────────────────────────────

  if (!linkedType) {
    const firstName = unmF.firstName.trim();
    const lastName = unmF.lastName.trim();
    const fullNameForApi = [firstName, lastName].filter(Boolean).join(" ");
    const fieldCls =
      "w-full h-8 text-sm rounded-md border border-input bg-background px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring";
    const labelCls =
      "text-[11px] text-muted-foreground uppercase tracking-wide mb-0.5";

    async function handleAddAsLead() {
      if (!firstName) {
        toast({
          title: t("inbox.sidebar.unlinked.nameRequired"),
          variant: "destructive",
        });
        return;
      }
      if (!conversationId) return;
      setUnmSubmitting(true);
      try {
        const res: any = await customFetch(
          `/api/inbox/conversations/${conversationId}/create-lead`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fullName: fullNameForApi || firstName,
              email: unmF.email.trim() || null,
              phone: unmF.phone.trim() || null,
            }),
          },
        );
        // Bug A fix: endpoint returns { ok, leadId } not { id }
        const leadId = res?.leadId ?? res?.id;
        if (leadId) {
          const patch: Record<string, unknown> = {};
          if (unmF.country.trim())
            patch.interestedCountry = unmF.country.trim();
          if (unmF.interestedProgram.trim())
            patch.interestedProgram = unmF.interestedProgram.trim();
          if (unmF.interestedUniversity.trim())
            patch.interestedUniversity = unmF.interestedUniversity.trim();
          const convAssignedToId = (detail as any).conversation?.assignedToId;
          if (convAssignedToId) patch.assignedToId = convAssignedToId;
          if (Object.keys(patch).length > 0) {
            await customFetch(`/api/leads/${leadId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(patch),
            }).catch(() => {});
          }
        }
        toast({ title: t("inbox.sidebar.unlinked.added") });
        onUpdated?.();
      } catch (err: any) {
        const msg = err?.data?.error || err?.body?.error || err?.message;
        toast({
          title: t("inbox.sidebar.unlinked.addFailed"),
          description: typeof msg === "string" ? msg : undefined,
          variant: "destructive",
        });
      } finally {
        setUnmSubmitting(false);
      }
    }

    return (
      <div
        className="flex flex-col h-full overflow-hidden"
        data-testid="lead-detail-sidebar-unmatched"
      >
        {tabBar}
        <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide pb-1 border-b">
            {t("inbox.sidebar.unlinked.title")}
          </div>

          <div className="space-y-2">
            {/* First Name + Last Name */}
            <div className="grid grid-cols-2 gap-1.5">
              <div>
                <div className={labelCls}>
                  {t("inbox.sidebar.unlinked.firstName")} *
                </div>
                <input
                  className={fieldCls}
                  value={unmF.firstName}
                  onChange={(e) =>
                    setUnmF((f) => ({ ...f, firstName: e.target.value }))
                  }
                  placeholder={t("inbox.sidebar.unlinked.firstName")}
                />
              </div>
              <div>
                <div className={labelCls}>
                  {t("inbox.sidebar.unlinked.lastName")}
                </div>
                <input
                  className={fieldCls}
                  value={unmF.lastName}
                  onChange={(e) =>
                    setUnmF((f) => ({ ...f, lastName: e.target.value }))
                  }
                  placeholder={t("inbox.sidebar.unlinked.lastName")}
                />
              </div>
            </div>

            {/* Phone with dial-code picker */}
            <div>
              <div className={labelCls}>
                {t("inbox.sidebar.unlinked.waNumber")}
              </div>
              <PhoneInput
                value={unmF.phone}
                onChange={(v) => setUnmF((f) => ({ ...f, phone: v }))}
              />
            </div>

            {/* Email */}
            <div>
              <div className={labelCls}>
                {t("inbox.sidebar.unlinked.email")}
              </div>
              <input
                type="email"
                className={fieldCls}
                value={unmF.email}
                onChange={(e) =>
                  setUnmF((f) => ({ ...f, email: e.target.value }))
                }
                placeholder={t("inbox.sidebar.unlinked.email")}
              />
            </div>

            {/* Interested Country — searchable dropdown */}
            <div>
              <div className={labelCls}>
                {t("inbox.sidebar.unlinked.country")}
              </div>
              <SearchableSelect
                value={unmF.country}
                onChange={(v) => setUnmF((f) => ({ ...f, country: v }))}
                options={countryOptions}
                placeholder={t("inbox.sidebar.unlinked.country")}
                clearable
                minDropdownWidth={200}
              />
            </div>

            {/* Interested Program */}
            <div>
              <div className={labelCls}>
                {t("inbox.sidebar.unlinked.interestedProgram")}
              </div>
              <input
                className={fieldCls}
                value={unmF.interestedProgram}
                onChange={(e) =>
                  setUnmF((f) => ({ ...f, interestedProgram: e.target.value }))
                }
                placeholder={t("inbox.sidebar.unlinked.interestedProgram")}
              />
            </div>

            {/* Interested University */}
            <div>
              <div className={labelCls}>
                {t("inbox.sidebar.unlinked.interestedUniversity")}
              </div>
              <input
                className={fieldCls}
                value={unmF.interestedUniversity}
                onChange={(e) =>
                  setUnmF((f) => ({
                    ...f,
                    interestedUniversity: e.target.value,
                  }))
                }
                placeholder={t("inbox.sidebar.unlinked.interestedUniversity")}
              />
            </div>
          </div>

          {/* Action button */}
          <div className="pt-2 border-t">
            <Button
              size="sm"
              onClick={() => void handleAddAsLead()}
              disabled={unmSubmitting || !firstName}
              className="w-full h-8 text-xs gap-1"
              data-testid="sidebar-add-lead-button"
            >
              {unmSubmitting ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Plus className="w-3 h-3" />
              )}
              {unmSubmitting
                ? t("inbox.sidebar.unlinked.submitting")
                : t("inbox.sidebar.unlinked.createLead")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── LEAD TAB — Matched entity view ────────────────────────────────────────

  const lead = detail.lead;
  const student = detail.student;
  const agent = detail.agent;
  const entity = lead ?? student ?? agent;
  if (!entity) return null;

  const editable = linkedType === "lead" || linkedType === "student";
  const patchUrl =
    linkedType === "lead" && lead
      ? `/api/leads/${lead.id}`
      : linkedType === "student" && student
        ? `/api/students/${student.id}`
        : null;

  async function saveField(fieldKey: string, newValue: string) {
    if (!patchUrl) return;
    setSaving(true);
    try {
      await customFetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [fieldKey]: newValue.trim() === "" ? null : newValue.trim(),
        }),
      });
      setEditingKey(null);
      toast({ title: t("inbox.sidebar.updateSaved") });
      onUpdated?.();
    } catch (err: any) {
      const msg = err?.data?.error || err?.body?.error || err?.message;
      toast({
        title: t("inbox.sidebar.updateFailed"),
        description: typeof msg === "string" ? msg : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  const typeLabel =
    linkedType === "lead"
      ? t("inbox.sidebar.typeLead")
      : linkedType === "student"
        ? t("inbox.sidebar.typeStudent")
        : t("inbox.sidebar.typeAgent");

  const onViewFullDetail = () => {
    if (linkedType === "lead" && lead) navigate(`/staff/leads/${lead.id}`);
    else if (linkedType === "student" && student)
      navigate(`/staff/students/${student.id}`);
    else if (linkedType === "agent" && agent)
      navigate(`/staff/agents/${agent.id}`);
  };

  const editProps = { editingKey, setEditingKey, onSave: saveField, saving };

  return (
    <div
      className="flex flex-col h-full overflow-hidden"
      data-testid="lead-detail-sidebar"
    >
      {tabBar}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Header */}
        <div>
          <div className="mb-2">
            <h3 className="font-semibold text-base leading-tight break-words">
              {entity.firstName} {entity.lastName}
            </h3>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {typeLabel}
          </Badge>
        </div>

        {(lead || student) && (
          <div className="grid grid-cols-1 gap-2.5 border-t pt-3">
            {lead && (
              <InboxStatusControl
                entityType="lead"
                entityId={lead.id}
                status={lead.status}
                label={`${t("inbox.sidebar.tabs.lead")} · ${t("common.status")}`}
                onUpdated={onUpdated}
              />
            )}
            {student && (
              <InboxStatusControl
                entityType="student"
                entityId={student.id}
                status={student.status}
                label={`${t("inbox.sidebar.tabs.student")} · ${t("common.status")}`}
                onUpdated={onUpdated}
              />
            )}
          </div>
        )}

        {/* AI Summary */}
        <AiSummaryCard
          summary={detail.aiSummary ?? null}
          hasLink={true}
          hasMessages={(detail.messages?.length ?? 0) > 0}
          isSummarizing={isSummarizing}
          onSummarize={onSummarize}
        />

        {/* Contact / identity info */}
        {editable ? (
          <div className="space-y-2.5 border-t pt-3">
            <EditableField
              label={t("inbox.sidebar.firstName")}
              value={entity.firstName}
              fieldKey="firstName"
              {...editProps}
            />
            <EditableField
              label={t("inbox.sidebar.lastName")}
              value={entity.lastName}
              fieldKey="lastName"
              {...editProps}
            />
            <EditableField
              label={t("inbox.sidebar.email")}
              value={entity.email}
              fieldKey="email"
              type="email"
              {...editProps}
            />
            <EditableField
              label={t("inbox.sidebar.phone")}
              value={entity.phone}
              fieldKey="phone"
              {...editProps}
            />
          </div>
        ) : (
          (entity.email || entity.phone) && (
            <div className="space-y-2 text-sm border-t pt-3">
              {entity.email && (
                <Field label={t("inbox.sidebar.email")} value={entity.email} />
              )}
              {entity.phone && (
                <Field
                  label={t("inbox.sidebar.phone")}
                  value={entity.phone ?? ""}
                />
              )}
            </div>
          )
        )}

        {/* Lead-specific */}
        {linkedType === "lead" && lead && (
          <div className="space-y-3 border-t pt-3">
            {lead.interestedProgram && (
              <Field
                label={t("inbox.sidebar.interestedProgram")}
                value={lead.interestedProgram}
              />
            )}
            {lead.interestedUniversity && (
              <Field
                label={t("inbox.sidebar.interestedUniversity")}
                value={lead.interestedUniversity}
              />
            )}
            {lead.interestedCountry && (
              <Field
                label={t("inbox.sidebar.interestedCountry")}
                value={lead.interestedCountry}
              />
            )}
            {lead.originDisplayName && (
              <Field
                label={t("inbox.sidebar.origin")}
                value={lead.originDisplayName}
              />
            )}
          </div>
        )}

        {/* Student-specific */}
        {linkedType === "student" && student && (
          <div className="space-y-3 border-t pt-3">
            {lead?.interestedProgram && (
              <Field
                label={t("inbox.sidebar.interestedProgram")}
                value={lead.interestedProgram}
              />
            )}
            {lead?.interestedUniversity && (
              <Field
                label={t("inbox.sidebar.interestedUniversity")}
                value={lead.interestedUniversity}
              />
            )}
            {lead?.interestedCountry && (
              <Field
                label={t("inbox.sidebar.interestedCountry")}
                value={lead.interestedCountry}
              />
            )}
            {student.interestedLevel && (
              <Field
                label={t("inbox.sidebar.interestedLevel")}
                value={student.interestedLevel}
              />
            )}
            {student.originDisplayName && (
              <Field
                label={t("inbox.sidebar.origin")}
                value={student.originDisplayName}
              />
            )}
          </div>
        )}

        {/* Agent-specific */}
        {linkedType === "agent" && agent && (
          <div className="space-y-3 border-t pt-3">
            {agent.companyName && (
              <div className="flex items-start gap-2 text-sm">
                <Building className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                <span className="break-words">{agent.companyName}</span>
              </div>
            )}
            {agent.entityType && (
              <Field
                label={t("inbox.sidebar.entityType")}
                value={agent.entityType}
              />
            )}
          </div>
        )}

        {/* CTA */}
        <div className="pt-3 border-t">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onViewFullDetail}
            data-testid="sidebar-view-full-detail"
          >
            {t("inbox.sidebar.viewFullDetail")}
            <ArrowRight className="w-3.5 h-3.5 ms-1.5 rtl:rotate-180" />
          </Button>
        </div>
      </div>
    </div>
  );
}
