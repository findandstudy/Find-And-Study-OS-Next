import { useState, useCallback } from "react";
import { useCreateStudent, customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { isNonLatinNameError } from "@/lib/latinNameError";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GraduationCap,
  ScrollText,
  Shield,
  Camera,
  Loader2,
  Sparkles,
  Bot,
} from "lucide-react";
import type { InboxConversationDetailResponse } from "@workspace/api-client-react";
import type { AddDocTarget } from "./AddAsDocumentModal";
import { resolveInboxStudentContactPrefill } from "./studentDraftContact";

type DocType = "diploma" | "transcript" | "passport" | "photograph";
type Step = "select" | "analyzing" | "form";

const DOC_TYPE_ICONS: Record<DocType, typeof GraduationCap> = {
  diploma: GraduationCap,
  transcript: ScrollText,
  passport: Shield,
  photograph: Camera,
};

const EMPTY_FORM = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  motherName: "",
  fatherName: "",
  nationality: "",
  dateOfBirth: "",
  passportNumber: "",
  passportExpiry: "",
  highSchool: "",
  gpa: "",
};

interface Props {
  convId: number;
  target: AddDocTarget;
  detail: InboxConversationDetailResponse;
  onClose: () => void;
  onCreated: (studentId: number) => void;
}

export function CreateStudentAndAddDocumentModal({
  convId,
  target,
  detail,
  onClose,
  onCreated,
}: Props) {
  const { t } = useI18n();
  const { toast } = useToast();
  const createStudent = useCreateStudent();

  const [step, setStep] = useState<Step>("select");
  const [docType, setDocType] = useState<DocType | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [aiExtracted, setAiExtracted] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const fieldChange = useCallback(
    (name: keyof typeof EMPTY_FORM) =>
      (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((f) => ({ ...f, [name]: e.target.value })),
    [],
  );

  async function handleSelectType(type: DocType) {
    setDocType(type);
    setStep("analyzing");

    const ext = (detail as any).externalContact ?? null;
    const conv = (detail as any).conversation ?? null;
    const displayName: string = (ext?.displayName || conv?.title || "").trim();
    const parts = displayName.split(/\s+/).filter(Boolean);
    const existingContact = resolveInboxStudentContactPrefill(detail);

    const initial: typeof EMPTY_FORM = {
      ...EMPTY_FORM,
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" ") || "",
      email: existingContact.email,
      phone: existingContact.phone,
    };
    const extracted = new Set<string>();

    try {
      const res = await customFetch(
        `/api/inbox/conversations/${convId}/messages/${target.msgId}/attachments/${target.attachIdx}/extract-for-student`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ docType: type }),
        },
      );
      const { extracted: data }: { extracted: Record<string, any> } = res as any;
      if (data && typeof data === "object") {
        const MAPPING: Array<[keyof typeof EMPTY_FORM, string]> = [
          ["firstName", "firstName"],
          ["lastName", "lastName"],
          ["nationality", "nationality"],
          ["dateOfBirth", "dateOfBirth"],
          ["passportNumber", "passportNumber"],
          ["passportExpiry", "passportExpiry"],
          ["motherName", "motherName"],
          ["fatherName", "fatherName"],
          ["highSchool", "highSchool"],
        ];
        for (const [fk, ek] of MAPPING) {
          const val = data[ek];
          if (val !== null && val !== undefined && val !== "") {
            (initial as any)[fk] = String(val);
            extracted.add(fk);
          }
        }
        if (data.gpa !== null && data.gpa !== undefined && data.gpa !== "") {
          const gpaStr = String(data.gpa).trim();
          const match = gpaStr.match(/^([\d.]+)\s*\/\s*(\d+)$/);
          initial.gpa = match ? match[1] : gpaStr;
          extracted.add("gpa");
        }
        if (data.graduationYear != null) {
          initial.highSchool = initial.highSchool || "";
          extracted.add("graduationYear");
        }
        const resolvedContact = resolveInboxStudentContactPrefill(detail, data);
        initial.email = resolvedContact.email;
        initial.phone = resolvedContact.phone;
        if (!existingContact.email && resolvedContact.email) extracted.add("email");
        if (!existingContact.phone && resolvedContact.phone) extracted.add("phone");
      }
    } catch {
      /* AI failed — contact prefill still applied */
    }

    setForm(initial);
    setAiExtracted(extracted);
    setStep("form");
  }

  async function handleSubmit() {
    const missing: string[] = [];
    if (!form.firstName.trim()) missing.push(t("apply.firstName"));
    if (!form.lastName.trim()) missing.push(t("apply.lastName"));
    if (!form.motherName.trim()) missing.push(t("apply.motherName"));
    if (!form.fatherName.trim()) missing.push(t("apply.fatherName"));
    if (missing.length > 0) {
      toast({
        title: t("inbox.createStudentAndAddDoc.fillRequired"),
        description: missing.join(", "),
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const createdStudent: any = await createStudent.mutateAsync({
        data: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          nationality: form.nationality.trim() || null,
          dateOfBirth: form.dateOfBirth.trim() || null,
          passportNumber: form.passportNumber.trim() || null,
          passportExpiry: form.passportExpiry.trim() || null,
          motherName: form.motherName.trim() || null,
          fatherName: form.fatherName.trim() || null,
          highSchool: form.highSchool.trim() || null,
          gpa: form.gpa.trim() || null,
          status: "active",
        } as any,
      });
      const studentId: number = createdStudent.id;

      await customFetch(`/api/inbox/conversations/${convId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "student", entityId: studentId }),
      });

      let docSaved = true;
      try {
        await customFetch(
          `/api/inbox/conversations/${convId}/messages/${target.msgId}/attachments/${target.attachIdx}/save-as-document`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              documentType: docType,
              ownerType: "student",
              ownerId: studentId,
              setAsPhoto: docType === "photograph",
            }),
          },
        );
      } catch {
        docSaved = false;
      }

      toast({
        title: docSaved
          ? t("inbox.createStudentAndAddDoc.success")
          : t("inbox.createStudentAndAddDoc.successDocFailed"),
      });
      onCreated(studentId);
    } catch (err: any) {
      const isLatin = isNonLatinNameError(err);
      const msg = isLatin
        ? t("common.latinOnlyName")
        : (err?.data?.error || err?.body?.error || err?.message);
      toast({
        title: t("inbox.createStudentAndAddDoc.failed"),
        description: typeof msg === "string" ? msg : undefined,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  function AiTag({ field }: { field: string }) {
    if (!aiExtracted.has(field)) return null;
    return <Sparkles className="w-3 h-3 text-violet-500 shrink-0" />;
  }

  const showPassport =
    docType === "passport" ||
    aiExtracted.has("passportNumber") ||
    aiExtracted.has("passportExpiry");

  const showEducation =
    docType === "diploma" ||
    docType === "transcript" ||
    aiExtracted.has("highSchool") ||
    aiExtracted.has("gpa");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting && step !== "analyzing") onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-2xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden"
        onInteractOutside={(e) => {
          if (step === "analyzing") e.preventDefault();
        }}
        onEscapeKeyDown={(e) => {
          if (step === "analyzing" || submitting) e.preventDefault();
        }}
      >
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/50 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Bot className="w-4 h-4 shrink-0" />
            {t("inbox.createStudentAndAddDoc.title")}
          </DialogTitle>
          <p className="text-sm text-muted-foreground">
            {t("inbox.createStudentAndAddDoc.notLinked")}
          </p>
        </DialogHeader>

        {step === "select" && (
          <div className="px-6 py-5 space-y-4 overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              {t("inbox.createStudentAndAddDoc.aiWillAnalyze")}
            </p>
            <p className="text-sm font-medium">
              {t("inbox.createStudentAndAddDoc.selectType")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(
                ["diploma", "transcript", "passport", "photograph"] as DocType[]
              ).map((type) => {
                const Icon = DOC_TYPE_ICONS[type];
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => handleSelectType(type)}
                    className="flex flex-col items-center gap-2.5 rounded-lg border border-border p-5 hover:border-primary hover:bg-primary/5 transition-colors text-center cursor-pointer"
                  >
                    <Icon className="w-6 h-6 text-muted-foreground" />
                    <span className="text-sm font-medium">
                      {t(`inbox.addAsDoc.${type}`)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {step === "analyzing" && (
          <div className="flex flex-col items-center justify-center py-16 gap-4 px-6">
            <div className="relative">
              <Loader2 className="w-10 h-10 animate-spin text-primary" />
              <Sparkles className="w-4 h-4 text-violet-500 absolute -top-1 -right-1" />
            </div>
            <p className="text-sm font-medium">
              {t("inbox.createStudentAndAddDoc.analyzing")}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              {t("inbox.createStudentAndAddDoc.analyzingDesc")}
            </p>
          </div>
        )}

        {step === "form" && (
          <>
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              {aiExtracted.size > 0 && (
                <div className="flex items-center gap-1.5 text-xs text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800/40 rounded-md px-3 py-2">
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  {t("inbox.createStudentAndAddDoc.aiExtractedInfo", {
                    count: String(aiExtracted.size),
                  })}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.firstName")}
                    <span className="text-destructive">*</span>
                    <AiTag field="firstName" />
                  </Label>
                  <Input
                    value={form.firstName}
                    onChange={fieldChange("firstName")}
                    placeholder={t("apply.firstNamePlaceholder")}
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.lastName")}
                    <span className="text-destructive">*</span>
                    <AiTag field="lastName" />
                  </Label>
                  <Input
                    value={form.lastName}
                    onChange={fieldChange("lastName")}
                    placeholder={t("apply.lastNamePlaceholder")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.email")}
                    <AiTag field="email" />
                  </Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={fieldChange("email")}
                    placeholder={t("apply.emailPlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.phone")}
                    <AiTag field="phone" />
                  </Label>
                  <Input
                    value={form.phone}
                    onChange={fieldChange("phone")}
                    placeholder="+1 555 000 0000"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.motherName")}
                    <span className="text-destructive">*</span>
                    <AiTag field="motherName" />
                  </Label>
                  <Input
                    value={form.motherName}
                    onChange={fieldChange("motherName")}
                    placeholder={t("apply.motherNamePlaceholder")}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.fatherName")}
                    <span className="text-destructive">*</span>
                    <AiTag field="fatherName" />
                  </Label>
                  <Input
                    value={form.fatherName}
                    onChange={fieldChange("fatherName")}
                    placeholder={t("apply.fatherNamePlaceholder")}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.nationality")}
                    <AiTag field="nationality" />
                  </Label>
                  <Input
                    value={form.nationality}
                    onChange={fieldChange("nationality")}
                    placeholder={t("apply.selectNationality")}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="flex items-center gap-1">
                    {t("apply.dateOfBirth")}
                    <AiTag field="dateOfBirth" />
                  </Label>
                  <Input
                    type="date"
                    value={form.dateOfBirth}
                    onChange={fieldChange("dateOfBirth")}
                  />
                </div>
              </div>

              {showPassport && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      {t("apply.passportNumber")}
                      <AiTag field="passportNumber" />
                    </Label>
                    <Input
                      value={form.passportNumber}
                      onChange={fieldChange("passportNumber")}
                      placeholder={t("apply.passportPlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      {t("apply.passportExpiryDate")}
                      <AiTag field="passportExpiry" />
                    </Label>
                    <Input
                      type="date"
                      value={form.passportExpiry}
                      onChange={fieldChange("passportExpiry")}
                    />
                  </div>
                </div>
              )}

              {showEducation && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      {t("apply.highSchool")}
                      <AiTag field="highSchool" />
                    </Label>
                    <Input
                      value={form.highSchool}
                      onChange={fieldChange("highSchool")}
                      placeholder={t("apply.highSchoolPlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="flex items-center gap-1">
                      {t("apply.gpa")}
                      <AiTag field="gpa" />
                    </Label>
                    <Input
                      value={form.gpa}
                      onChange={fieldChange("gpa")}
                      placeholder={t("apply.gpaPlaceholder")}
                    />
                  </div>
                </div>
              )}
            </div>

            <DialogFooter className="px-6 py-4 border-t border-border/50 shrink-0">
              <Button
                variant="outline"
                onClick={onClose}
                disabled={submitting}
              >
                {t("inbox.createStudentAndAddDoc.cancel")}
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={
                  submitting ||
                  !form.firstName.trim() ||
                  !form.lastName.trim() ||
                  !form.motherName.trim() ||
                  !form.fatherName.trim()
                }
              >
                {submitting && (
                  <Loader2 className="w-4 h-4 animate-spin me-1.5" />
                )}
                {submitting
                  ? t("inbox.createStudentAndAddDoc.submitting")
                  : t("inbox.createStudentAndAddDoc.submit")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
