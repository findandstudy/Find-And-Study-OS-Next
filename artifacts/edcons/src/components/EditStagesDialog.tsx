import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, Check, AlertCircle, Pencil, ArrowLeft } from "lucide-react";
import type { PipelineStage, StageAction, StageActionType } from "@/hooks/use-pipeline-stages";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { preventPipelineDialogOutsideDismiss } from "@/lib/pipelineDialogDismiss";

type ActionTypeOrNone = StageActionType | "none";
const ACTION_TYPE_OPTIONS: { value: ActionTypeOrNone; labelKey: string; defaultLabelKey: string; defaultColor: string }[] = [
  { value: "none", labelKey: "editStages.actionTypeNone", defaultLabelKey: "", defaultColor: "#3b82f6" },
  { value: "download", labelKey: "editStages.actionTypeDownload", defaultLabelKey: "editStages.actionDefaultLabelDownload", defaultColor: "#10b981" },
  { value: "missing_docs", labelKey: "editStages.actionTypeMissingDocs", defaultLabelKey: "editStages.actionDefaultLabelMissingDocs", defaultColor: "#f59e0b" },
];

function StageActionEditor({
  action,
  allStages,
  currentStageKey,
  onChange,
  onRemove,
  index,
}: {
  action: StageAction;
  allStages: PipelineStage[];
  currentStageKey: string;
  onChange: (a: StageAction) => void;
  onRemove: () => void;
  index: number;
}) {
  const { t } = useI18n();
  const typeOpt = ACTION_TYPE_OPTIONS.find((o) => o.value === action.type);
  const typeDefaultLabel = typeOpt?.defaultLabelKey ? t(typeOpt.defaultLabelKey) : "";
  const targetOptions = allStages.filter((s) => s.key && s.key !== currentStageKey);
  const showDocName = action.type === "upload" || action.type === "download";
  return (
    <div className="rounded-lg border border-border/70 bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <div
          className="w-3 h-3 rounded-full border"
          style={{ backgroundColor: action.color || typeOpt?.defaultColor || "#3b82f6" }}
        />
        <span className="text-sm font-medium flex-1">{t("editStages.buttonNumber", { n: index + 1 })}</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRemove} title={t("editStages.deleteTitle")}>
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t("editStages.actionType")}</Label>
        <Select
          value={action.type}
          onValueChange={(v) => {
            if (v === "none") { onRemove(); return; }
            const opt = ACTION_TYPE_OPTIONS.find((o) => o.value === v);
            const optDefaultLabel = opt?.defaultLabelKey ? t(opt.defaultLabelKey) : "";
            onChange({
              ...action,
              type: v as StageActionType,
              label: action.label || optDefaultLabel || null,
              color: action.color || opt?.defaultColor || null,
            });
          }}
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ACTION_TYPE_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{t(o.labelKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">{t("editStages.buttonText")}</Label>
        <div className="flex items-center gap-2">
          <Input
            value={action.label || ""}
            onChange={(e) => onChange({ ...action, label: e.target.value })}
            placeholder={typeDefaultLabel || t("editStages.buttonPlaceholder")}
            className="h-9 flex-1"
            maxLength={32}
          />
          <input
            type="color"
            value={action.color || typeOpt?.defaultColor || "#3b82f6"}
            onChange={(e) => onChange({ ...action, color: e.target.value.toLowerCase() })}
            className="h-9 w-10 rounded border cursor-pointer p-0.5"
            title={t("editStages.buttonColorTitle")}
          />
        </div>
      </div>

      {action.type === "missing_docs" && (
        <p className="text-[11px] text-muted-foreground bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-900/40 rounded-md px-2.5 py-2 leading-relaxed">
          {t("editStages.missingDocsHintPart1")}<span className="font-medium text-foreground">{t("editStages.missingDocsHintEmphasis")}</span>{t("editStages.missingDocsHintPart2")}
        </p>
      )}

      {showDocName && (
        <div className="space-y-1.5">
          <Label className="text-xs">{t("editStages.documentName")}</Label>
          <Input
            value={action.documentName || ""}
            onChange={(e) => onChange({ ...action, documentName: e.target.value })}
            placeholder={action.type === "upload" ? t("editStages.docNamePlaceholderUpload") : t("editStages.docNamePlaceholderDownload")}
            className="h-9"
            maxLength={64}
          />
          <p className="text-[11px] text-muted-foreground">
            {action.type === "upload"
              ? t("editStages.docNameHintUpload")
              : t("editStages.docNameHintDownload")}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs">{t("editStages.changeStageOnComplete")}</Label>
        <Select
          value={action.targetStageKey || "__none__"}
          onValueChange={(v) => onChange({ ...action, targetStageKey: v === "__none__" ? null : v })}
        >
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">{t("editStages.noChange")}</SelectItem>
            {targetOptions.map((s) => (
              <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

interface EditStagesDialogProps {
  open: boolean;
  onClose: () => void;
  stages: PipelineStage[];
  onSave: (stages: PipelineStage[]) => Promise<void>;
  isSaving: boolean;
  entityLabel: string;
  /**
   * Available student-pipeline stage keys/labels. When provided AND the
   * pipeline being edited is the application pipeline, each row gets an
   * extra "→ Student stage" picker that maps the application stage to a
   * student status. Selecting a value causes the backend to automatically
   * update the linked student's status when the application reaches that
   * stage. Pass `null`/`undefined` to disable the mapping UI (e.g. when
   * editing the lead or student pipeline themselves).
   */
  studentStages?: PipelineStage[];
}

const VARIANT_OPTIONS = [
  { value: "none", labelKey: "editStages.variantNone", dotClass: "bg-muted-foreground/40" },
  { value: "won", labelKey: "editStages.variantWon", dotClass: "bg-emerald-500" },
  { value: "partial_won", labelKey: "editStages.variantPartialWon", dotClass: "bg-amber-500" },
  { value: "lost", labelKey: "editStages.variantLost", dotClass: "bg-rose-500" },
  { value: "none_finance", labelKey: "editStages.variantNoneFinance", dotClass: "bg-gray-300" },
];

function FormSection({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="px-4 py-2.5 border-b bg-muted/30 rounded-t-lg">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </header>
      <div className="p-4 space-y-4">
        {children}
      </div>
    </section>
  );
}

function getVariantDot(variant: string | null | undefined) {
  const opt = VARIANT_OPTIONS.find(v => v.value === (variant || "none"));
  return opt?.dotClass || "bg-muted-foreground/40";
}

function RadioGroup({ label, value, onChange, required }: { label: string; value: boolean; onChange: (v: boolean) => void; required?: boolean }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-4">
      <Label className="text-sm font-medium flex-1">
        {label}{required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      <div className="flex items-center gap-4 shrink-0">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={label}
            checked={!value}
            onChange={() => onChange(false)}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-sm">{t("editStages.no")}</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name={label}
            checked={value}
            onChange={() => onChange(true)}
            className="w-4 h-4 accent-primary"
          />
          <span className="text-sm">{t("editStages.yes")}</span>
        </label>
      </div>
    </div>
  );
}

const UPLOAD_PERMISSION_OPTIONS = [
  { value: "none", labelKey: "editStages.uploadPermNone" },
  { value: "admin_only", labelKey: "editStages.uploadPermAdminOnly" },
  { value: "staff_only", labelKey: "editStages.uploadPermStaffOnly" },
  { value: "staff_and_agent", labelKey: "editStages.uploadPermStaffAndAgent" },
  { value: "everyone", labelKey: "editStages.uploadPermEveryone" },
];

const FINANCE_STATUS_OPTIONS = [
  { value: "auto", labelKey: "editStages.financeAuto" },
  { value: "potential", labelKey: "editStages.financePotential" },
  { value: "confirmed", labelKey: "editStages.financeConfirmed" },
  { value: "excluded", labelKey: "editStages.financeExcluded" },
];

function StageEditForm({ stage, onChange, allStages }: { stage: PipelineStage; onChange: (s: PipelineStage) => void; allStages: PipelineStage[] }) {
  const { t } = useI18n();
  const isApplicationStage = stage.entityType === "application";
  const actions: StageAction[] = Array.isArray(stage.actions) ? stage.actions : [];
  function updateActionAt(i: number, a: StageAction) {
    const next = actions.slice();
    next[i] = a;
    onChange({ ...stage, actions: next });
  }
  function removeActionAt(i: number) {
    onChange({ ...stage, actions: actions.filter((_, idx) => idx !== i) });
  }
  function addAction() {
    if (actions.length >= 2) return;
    // Default to "upload" (first non-"none" option) when adding a new slot.
    const opt = ACTION_TYPE_OPTIONS.find((o) => o.value !== "none")!;
    const newAction: StageAction = {
      type: opt.value as StageActionType,
      label: opt.defaultLabelKey ? t(opt.defaultLabelKey) : "",
      documentName: null,
      color: opt.defaultColor,
      // "Don't change" by default — admin opts in to a transition.
      targetStageKey: null,
      requiredDocTypes: [],
    };
    onChange({ ...stage, actions: [...actions, newAction] });
  }
  return (
    <div className="space-y-4">
      <FormSection title={t("editStages.sectionBasicInfo")}>
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              {t("editStages.stageName")}<span className="text-destructive ml-0.5">*</span>
            </Label>
            <Input
              value={stage.label}
              onChange={e => onChange({ ...stage, label: e.target.value })}
              placeholder={t("editStages.stageNamePlaceholder")}
              className="h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">
              {t("editStages.color")}<span className="text-destructive ml-0.5">*</span>
            </Label>
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                value={stage.color || "#3B82F6"}
                onChange={e => onChange({ ...stage, color: e.target.value })}
                className="w-9 h-9 rounded border cursor-pointer p-0.5"
              />
              <Input
                value={stage.color || "#3B82F6"}
                onChange={e => onChange({ ...stage, color: e.target.value })}
                placeholder="#3B82F6"
                className="h-9 w-24 font-mono text-xs"
              />
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">{t("editStages.financeCategory")}</Label>
          <Select
            value={stage.variant || "none"}
            onValueChange={v => onChange({ ...stage, variant: v === "none" ? null : v })}
          >
            <SelectTrigger className="w-full h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {VARIANT_OPTIONS.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  <div className="flex items-center gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full ${opt.dotClass}`} />
                    {t(opt.labelKey)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t("editStages.financeCategoryHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-medium">{t("editStages.countries")}</Label>
          <Input
            value={stage.countries || ""}
            onChange={e => onChange({ ...stage, countries: e.target.value || null })}
            placeholder={t("editStages.countriesPlaceholder")}
            className="h-9"
          />
          <p className="text-[11px] text-muted-foreground">
            {t("editStages.countriesHint")}
          </p>
        </div>
      </FormSection>

      <FormSection title={t("editStages.sectionBehaviorRules")}>
        <RadioGroup
          label={t("editStages.notesMandatory")}
          value={!!stage.isNotesMandatory}
          onChange={v => onChange({ ...stage, isNotesMandatory: v })}
          required
        />
        <RadioGroup
          label={t("editStages.canGoBack")}
          value={stage.canGoBack !== false}
          onChange={v => onChange({ ...stage, canGoBack: v })}
          required
        />
        <RadioGroup
          label={t("editStages.isCaseClose")}
          value={!!stage.isCaseClose}
          onChange={v => onChange({ ...stage, isCaseClose: v })}
          required
        />
      </FormSection>

      <FormSection title={t("editStages.sectionFileAttachments")}>
        <RadioGroup
          label={t("editStages.canAttachFile")}
          value={!!stage.canAttachFile}
          onChange={v => onChange({ ...stage, canAttachFile: v, ...(v ? {} : { isFileUploadMandatory: false }) })}
        />
        {stage.canAttachFile && (
          <div className="ml-2 border-l-2 border-primary/30 pl-4 space-y-4">
            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">
                  {t("editStages.maxFiles")}<span className="text-destructive ml-0.5">*</span>
                </Label>
                <Select
                  value={String(stage.maxFiles || 1)}
                  onValueChange={v => onChange({ ...stage, maxFiles: parseInt(v) })}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 10, 20].map(n => (
                      <SelectItem key={n} value={String(n)}>{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <RadioGroup
              label={t("editStages.fileUploadMandatory")}
              value={!!stage.isFileUploadMandatory}
              onChange={v => onChange({ ...stage, isFileUploadMandatory: v })}
              required
            />
          </div>
        )}
      </FormSection>

      {isApplicationStage && (
        <>
          <FormSection title={t("editStages.sectionApplicationSettings")}>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t("editStages.uploadPermissionLabel")}</Label>
              <Select
                value={stage.uploadPermissionLevel || "none"}
                onValueChange={v => onChange({ ...stage, uploadPermissionLevel: v })}
              >
                <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UPLOAD_PERMISSION_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t("editStages.uploadPermissionHint")}
              </p>
            </div>

            <RadioGroup
              label={t("editStages.tracksOfferExpiry")}
              value={!!stage.tracksOfferExpiry}
              onChange={v => onChange({ ...stage, tracksOfferExpiry: v, ...(v ? {} : { requiresValidUntil: false }) })}
            />
            {stage.tracksOfferExpiry && (
              <div className="ml-2 border-l-2 border-primary/30 pl-4">
                <RadioGroup
                  label={t("editStages.requiresValidUntil")}
                  value={!!stage.requiresValidUntil}
                  onChange={v => onChange({ ...stage, requiresValidUntil: v })}
                />
              </div>
            )}

            <RadioGroup
              label={t("editStages.autoCancelSiblings")}
              value={!!stage.autoCancelSiblingsOnWon}
              onChange={v => onChange({ ...stage, autoCancelSiblingsOnWon: v })}
            />

            {/* Task #187 — when every catalog-based missing-doc request on
                this stage is fulfilled, auto-advance the application to
                the selected stage. */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">
                {t("editStages.missingDocsFulfilledTarget")}
              </Label>
              <Select
                value={(() => {
                  const k = stage.missingDocsFulfilledTargetStageKey;
                  if (k) return k;
                  const id = stage.missingDocsFulfilledTargetStageId;
                  if (id) {
                    const found = allStages.find((s) => s.id === id);
                    if (found?.key) return found.key;
                  }
                  return "none";
                })()}
                onValueChange={(v) => onChange({
                  ...stage,
                  missingDocsFulfilledTargetStageKey: v === "none" ? null : v,
                })}
              >
                <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("editStages.noChangeStage")}</SelectItem>
                  {allStages
                    .filter((s) => s.entityType === "application" && s.key !== stage.key && !!s.key)
                    .map((s) => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t("editStages.missingDocsFulfilledHint")}
              </p>
            </div>
          </FormSection>

          <FormSection
            title={t("editStages.sectionFinanceAssignment")}
            description={t("editStages.financeAssignmentDesc")}
          >
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t("editStages.commissionFinanceStatus")}</Label>
              <Select
                value={stage.commissionFinanceStatus || "auto"}
                onValueChange={v => onChange({ ...stage, commissionFinanceStatus: v === "auto" ? null : v })}
              >
                <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FINANCE_STATUS_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">{t("editStages.serviceFeeFinanceStatus")}</Label>
              <Select
                value={stage.serviceFeeFinanceStatus || "auto"}
                onValueChange={v => onChange({ ...stage, serviceFeeFinanceStatus: v === "auto" ? null : v })}
              >
                <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FINANCE_STATUS_OPTIONS.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>{t(opt.labelKey)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FormSection>

          <FormSection
            title={t("editStages.sectionStageActions")}
            description={t("editStages.stageActionsDesc")}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("editStages.buttonsDefinedCount", { n: actions.length })}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5 h-8"
                onClick={addAction}
                disabled={actions.length >= 2}
              >
                <Plus className="w-3.5 h-3.5" /> {t("editStages.addButton")}
              </Button>
            </div>
            {actions.length === 0 && (
              <div className="text-center py-4 text-xs text-muted-foreground italic border border-dashed rounded-md">
                {t("editStages.noActionsYet")}
              </div>
            )}
            <div className="space-y-3">
              {actions.map((a, i) => (
                <StageActionEditor
                  key={i}
                  action={a}
                  index={i}
                  allStages={allStages}
                  currentStageKey={stage.key}
                  onChange={(u) => updateActionAt(i, u)}
                  onRemove={() => removeActionAt(i)}
                />
              ))}
            </div>
          </FormSection>
        </>
      )}
    </div>
  );
}

export function EditStagesDialog({ open, onClose, stages, onSave, isSaving, entityLabel, studentStages }: EditStagesDialogProps) {
  const showStudentMapping = !!studentStages && (stages[0]?.entityType === "application");
  const [localStages, setLocalStages] = useState<PipelineStage[]>([]);
  const [error, setError] = useState("");
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const { toast } = useToast();
  const { t } = useI18n();

  useEffect(() => {
    if (open) {
      setLocalStages(stages.map(s => ({ ...s })));
      setError("");
      setEditIndex(null);
    }
  }, [open]);

  function addStage() {
    const order = localStages.length;
    const key = `stage_${Date.now()}`;
    setLocalStages([...localStages, {
      entityType: stages[0]?.entityType || "lead",
      key,
      label: "",
      sortOrder: order,
      variant: null,
      color: "#3B82F6",
      isNotesMandatory: false,
      canAttachFile: false,
      maxFiles: 1,
      isFileUploadMandatory: false,
      canGoBack: true,
      isCaseClose: false,
      countries: null,
      uploadPermissionLevel: "none",
      tracksOfferExpiry: false,
      requiresValidUntil: false,
      commissionFinanceStatus: null,
      serviceFeeFinanceStatus: null,
      autoCancelSiblingsOnWon: false,
    }]);
    setEditIndex(localStages.length);
  }

  function removeStage(index: number) {
    if (localStages.length <= 1) {
      setError(t("editStages.atLeastOneStage"));
      return;
    }
    setLocalStages(localStages.filter((_, i) => i !== index));
    if (editIndex === index) setEditIndex(null);
    else if (editIndex !== null && editIndex > index) setEditIndex(editIndex - 1);
  }

  function updateStageAtIndex(index: number, updated: PipelineStage) {
    setLocalStages(prev => prev.map((s, i) => i === index ? updated : s));
    setError("");
  }

  function moveStage(index: number, direction: "up" | "down") {
    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= localStages.length) return;
    const arr = [...localStages];
    [arr[index], arr[newIndex]] = [arr[newIndex], arr[index]];
    setLocalStages(arr);
    if (editIndex === index) setEditIndex(newIndex);
    else if (editIndex === newIndex) setEditIndex(index);
  }

  async function handleSave() {
    const emptyLabels = localStages.filter(s => !s.label.trim());
    if (emptyLabels.length > 0) {
      setError(t("editStages.allStagesNeedLabel"));
      return;
    }
    const emptyKeys = localStages.filter(s => !s.key.trim());
    if (emptyKeys.length > 0) {
      setError(t("editStages.allStagesNeedKey"));
      return;
    }
    const keys = localStages.map(s => s.key);
    if (new Set(keys).size !== keys.length) {
      setError(t("editStages.duplicateKeys"));
      return;
    }
    try {
      await onSave(localStages.map((s, i) => ({ ...s, sortOrder: i })));
      toast({ title: t("editStages.savedSuccess") });
      onClose();
    } catch {
      toast({ title: t("editStages.errorTitle"), description: t("editStages.saveFailedDesc"), variant: "destructive" });
    }
  }

  const editingStage = editIndex !== null ? localStages[editIndex] : null;

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent
        className="sm:max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0"
        onInteractOutside={preventPipelineDialogOutsideDismiss}
      >
        <DialogHeader className="px-6 pt-5 pb-4 border-b shrink-0">
          <DialogTitle className="text-base">
            {editingStage ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditIndex(null)}
                  className="p-1 rounded hover:bg-muted"
                  title={t("editStages.backToListTitle")}
                >
                  <ArrowLeft className="w-4 h-4" />
                </button>
                <span className="font-semibold">{t("editStages.editStageColon")}</span>
                <span className="text-muted-foreground font-normal truncate">
                  {editingStage.label || t("editStages.newStage")}
                </span>
              </div>
            ) : (
              t("editStages.pipelineStagesTitle", { entityLabel })
            )}
          </DialogTitle>
        </DialogHeader>

        {editingStage && editIndex !== null ? (
          <div className="flex-1 overflow-y-auto px-6 py-5">
            <StageEditForm
              stage={editingStage}
              onChange={updated => updateStageAtIndex(editIndex, updated)}
              allStages={localStages}
            />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto space-y-2 px-6 py-4">
            {localStages.map((stage, idx) => (
              <div key={idx} className="flex items-center gap-2 group">
                <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={() => moveStage(idx, "up")}
                    disabled={idx === 0}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-20"
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 5l4-4 4 4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
                  </button>
                  <button
                    type="button"
                    onClick={() => moveStage(idx, "down")}
                    disabled={idx === localStages.length - 1}
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground disabled:opacity-20"
                  >
                    <svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
                  </button>
                </div>
                <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${getVariantDot(stage.variant)}`} />
                <Input
                  value={stage.label}
                  onChange={e => updateStageAtIndex(idx, { ...stage, label: e.target.value })}
                  className="h-8 text-sm flex-1"
                  placeholder={t("editStages.stageNameListPlaceholder")}
                />
                <Input
                  value={stage.key}
                  onChange={e => {
                    const newKey = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_");
                    updateStageAtIndex(idx, { ...stage, key: newKey });
                  }}
                  className="h-8 text-xs font-mono w-24 shrink-0"
                  placeholder={t("editStages.keyPlaceholder")}
                  readOnly={!!stage.id}
                  title={stage.id ? t("editStages.keyReadonlyTitle") : ""}
                />
                <Select value={stage.variant || "none"} onValueChange={v => updateStageAtIndex(idx, { ...stage, variant: v === "none" ? null : v })}>
                  <SelectTrigger className="h-8 w-24 text-xs shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VARIANT_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>
                        <div className="flex items-center gap-1.5">
                          <div className={`w-2 h-2 rounded-full ${opt.dotClass}`} />
                          <span className="text-xs">{t(opt.labelKey)}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {showStudentMapping && (
                  <Select
                    value={stage.mappedStudentStageKey || "__none__"}
                    onValueChange={v => updateStageAtIndex(idx, { ...stage, mappedStudentStageKey: v === "__none__" ? null : v })}
                  >
                    <SelectTrigger
                      className="h-8 w-32 text-xs shrink-0"
                      title={t("editStages.studentMappingTitle")}
                    >
                      <SelectValue placeholder={t("editStages.studentMappingPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">
                        <span className="text-xs text-muted-foreground">{t("editStages.noMappingOption")}</span>
                      </SelectItem>
                      {(studentStages || []).map(ss => (
                        <SelectItem key={ss.key} value={ss.key}>
                          <span className="text-xs">→ {ss.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
                <button
                  type="button"
                  onClick={() => setEditIndex(idx)}
                  className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                  title={t("editStages.editStageDetailsTitle")}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeStage(idx)}
                  className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="px-6 pb-5 pt-4 border-t shrink-0 space-y-3 bg-muted/20">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
          <div className="flex items-center justify-between">
            {editingStage ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setEditIndex(null)} className="gap-1.5">
                  <ArrowLeft className="w-3.5 h-3.5" /> {t("editStages.backToList")}
                </Button>
                <Button onClick={() => setEditIndex(null)}>
                  <Check className="h-3.5 w-3.5 mr-1.5" /> {t("editStages.ok")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={addStage} className="gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> {t("editStages.addStage")}
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={onClose}>{t("editStages.cancel")}</Button>
                  <Button onClick={handleSave} disabled={isSaving}>
                    <Check className="h-3.5 w-3.5 mr-1.5" />{isSaving ? t("editStages.saving") : t("editStages.save")}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
