import { useState } from "react";
import { useCreateStudent, customFetch } from "@workspace/api-client-react";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PhoneInput } from "@/components/ui/phone-input";
import { Loader2, Sparkles } from "lucide-react";
import { toLatinUpper } from "@/lib/latin-utils";
import type { SubmitReadyData } from "./InboxStudentTab";
import { findMissingMandatoryTypes } from "@workspace/doc-equivalence";
import {
  buildInboxEducationPayload,
  findMissingInboxAcademicFields,
} from "./inboxEducationPayload";

interface InboxSubmitTabProps {
  conversationId: number;
  data: SubmitReadyData;
  onCreated: (studentId: number) => void;
  onBack: () => void;
}

const GRADING_SYSTEMS = [
  { value: "4", label: "/ 4" },
  { value: "5", label: "/ 5" },
  { value: "10", label: "/ 10" },
  { value: "20", label: "/ 20" },
  { value: "100", label: "/ 100" },
];

function AiTag({ field, aiFields }: { field: string; aiFields: Set<string> }) {
  if (!aiFields.has(field)) return null;
  return <Sparkles className="w-3 h-3 text-violet-500 shrink-0 inline-block ms-1" />;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest pt-2 pb-0.5 border-b mb-1">
      {children}
    </div>
  );
}

export function InboxSubmitTab({
  conversationId,
  data,
  onCreated,
}: InboxSubmitTabProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const createStudent = useCreateStudent();
  const [form, setForm] = useState(data.form);
  const [saving, setSaving] = useState(false);

  const level = data.selectedLevel.toLowerCase();
  const isMaster = level.includes("master") || level.includes("mba");
  const isPhd = level.includes("phd") || level.includes("doctor");
  const isHigher = isMaster || isPhd;

  function field(key: keyof typeof form) {
    return (val: string) => setForm((f) => ({ ...f, [key]: val }));
  }

  function latinField(key: keyof typeof form) {
    return (val: string) => setForm((f) => ({ ...f, [key]: toLatinUpper(val) }));
  }

  async function handleCreate() {
    const missingMandatoryDocuments = findMissingMandatoryTypes(
      data.mandatoryDocumentTypes,
      new Set(data.providedDocumentTypes),
    );
    if (missingMandatoryDocuments.length > 0) {
      toast({
        title: t("inbox.studentTab.fillRequired"),
        description: missingMandatoryDocuments.join(", "),
        variant: "destructive",
      });
      return;
    }
    if (!form.firstName.trim() || !form.lastName.trim()) {
      toast({ title: t("inbox.studentTab.fillRequired"), variant: "destructive" });
      return;
    }
    const missingAcademic = findMissingInboxAcademicFields({
      selectedLevel: data.selectedLevel,
      school1: form.school1,
      school2: form.school2,
      graduationYear: form.graduationYear,
      gpa: form.gpa,
    });
    if (missingAcademic.length > 0) {
      toast({
        title: "Academic information is incomplete",
        description: `AI could not verify: ${missingAcademic.join(", ")}. Review the uploaded education documents or enter these fields manually.`,
        variant: "destructive",
      });
      return;
    }
    if (!data.leadId) {
      toast({
        title: t("inbox.studentTab.createFailed"),
        description: "A linked lead is required before student creation.",
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    try {
      // Persist chat attachments on the lead BEFORE creating the student. This
      // keeps the workflow at Lead when a mandatory file cannot be saved and
      // lets the existing lead→student match adopt the verified documents.
      const persistedBeforeCreate = new Set(data.persistedDocumentTypes);
      for (const [docType, att] of Object.entries(data.staging)) {
        try {
          await customFetch(
            `/api/inbox/conversations/${conversationId}/messages/${att.msgId}/attachments/${att.attachIdx}/save-as-document`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ownerType: "lead",
                ownerId: data.leadId,
                documentType: docType,
              }),
            },
          );
          persistedBeforeCreate.add(docType);
        } catch (docErr: any) {
          const body = docErr?.data ?? docErr?.body;
          if (docErr?.status === 409 && body?.alreadySaved) {
            persistedBeforeCreate.add(docType);
          }
        }
      }

      const missingAfterPersistence = findMissingMandatoryTypes(
        data.mandatoryDocumentTypes,
        persistedBeforeCreate,
      );
      if (missingAfterPersistence.length > 0) {
        throw new Error(
          `Mandatory documents could not be saved: ${missingAfterPersistence.join(", ")}`,
        );
      }

      const education = buildInboxEducationPayload({
        selectedLevel: data.selectedLevel,
        school1: form.school1,
        school2: form.school2,
        educationProgram: form.educationProgram,
        educationCountry: form.educationCountry,
        graduationYear: form.graduationYear,
        gpa: form.gpa,
        gradingSystem: form.gradingSystem,
        languageScore: form.languageScore,
      });

      const created = (await createStudent.mutateAsync({
        data: {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          gender: form.gender || null,
          nationality: form.nationality.trim() || null,
          dateOfBirth: form.dateOfBirth.trim() || null,
          address: form.address.trim() || null,
          addressCity: form.addressCity.trim() || null,
          postalCode: form.postalCode.trim() || null,
          motherName: form.motherName.trim() || null,
          fatherName: form.fatherName.trim() || null,
          passportNumber: form.passportNumber.trim() || null,
          passportIssueDate: form.passportIssueDate.trim() || null,
          passportExpiry: form.passportExpiry.trim() || null,
          highSchool: education.highSchool,
          universityBachelor: education.universityBachelor,
          universityMaster: education.universityMaster,
          graduationYear: education.graduationYear,
          gpa: education.gpa,
          languageScore: education.languageScore,
          educationRecords: education.educationRecords,
          notes: form.notes.trim() || null,
          interestedLevel: data.selectedLevel || null,
          sourceLeadId: data.leadId,
          status: "active",
        } as any,
      })) as any;
      const studentId: number = created.id;

      await customFetch(`/api/inbox/conversations/${conversationId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "student", entityId: studentId }),
      });

      let docsSaved = 0;
      let docsFailed = 0;
      const docErrors: string[] = [];
      for (const [docType, att] of Object.entries(data.staging)) {
        try {
          await customFetch(
            `/api/inbox/conversations/${conversationId}/messages/${att.msgId}/attachments/${att.attachIdx}/save-as-document`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ownerType: "student", ownerId: studentId, documentType: docType }),
            }
          );
          docsSaved++;
        } catch (docErr: any) {
          // 409 alreadySaved = the doc was staged on the lead and adopted onto
          // the student during matching — it IS on the profile, not a failure.
          const body = docErr?.data ?? docErr?.body;
          if (docErr?.status === 409 && body?.alreadySaved) {
            docsSaved++;
          } else {
            docsFailed++;
            const emsg = body?.error || docErr?.message;
            docErrors.push(`${docType}: ${typeof emsg === "string" ? emsg : "unknown error"}`);
          }
        }
      }

      if (docsFailed > 0) {
        toast({
          title: t("inbox.studentTab.studentCreated"),
          description: `${t("inbox.studentTab.docsSaveFailed", { count: String(docsFailed) })} — ${docErrors.join("; ")}`,
          variant: "destructive",
        });
      } else {
        toast({
          title: docsSaved > 0
            ? t("inbox.studentTab.studentCreatedWithDocs", { count: String(docsSaved) })
            : t("inbox.studentTab.studentCreated"),
        });
      }
      onCreated(studentId);
    } catch (err: any) {
      const body = err?.data ?? err?.body;
      const existingStudentId = Number(body?.studentId);
      if (
        err?.status === 409
        && Number.isInteger(existingStudentId)
        && existingStudentId > 0
      ) {
        try {
          // Another screen/process may have completed the lead conversion
          // after this form was prepared. Link the already-created canonical
          // student instead of presenting a false creation failure.
          await customFetch(`/api/inbox/conversations/${conversationId}/match`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "student", entityId: existingStudentId }),
          });
          toast({ title: t("inbox.studentTab.existingStudentLinked") });
          onCreated(existingStudentId);
          return;
        } catch (matchError: any) {
          const matchBody = matchError?.data ?? matchError?.body;
          const matchMessage = matchBody?.error || matchError?.message;
          toast({
            title: t("inbox.studentTab.createFailed"),
            description: typeof matchMessage === "string" ? matchMessage : undefined,
            variant: "destructive",
          });
          return;
        }
      }
      const msg = body?.error || err?.message;
      toast({
        title: t("inbox.studentTab.createFailed"),
        description: typeof msg === "string" ? msg : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {data.aiFields.size > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-md px-3 py-2">
            <Sparkles className="w-3 h-3 shrink-0" />
            {t("inbox.studentTab.aiExtracted", { count: String(data.aiFields.size) })}
          </div>
        )}

        {/* ── Personal ───────────────────────────────────────────── */}
        <SectionLabel>{t("inbox.studentTab.sectionPersonal")}</SectionLabel>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.firstName")}<span className="text-destructive ms-0.5">*</span>
              <AiTag field="firstName" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.firstName}
              onChange={(e) => latinField("firstName")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.lastName")}<span className="text-destructive ms-0.5">*</span>
              <AiTag field="lastName" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.lastName}
              onChange={(e) => latinField("lastName")(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.email")}
              <AiTag field="email" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" type="email" value={form.email}
              onChange={(e) => field("email")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.phone")}
              <AiTag field="phone" aiFields={data.aiFields} />
            </Label>
            <PhoneInput
              value={form.phone}
              onChange={field("phone")}
              className="h-7 text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.gender")}
              <AiTag field="gender" aiFields={data.aiFields} />
            </Label>
            <select
              className="w-full h-7 text-sm rounded-md border border-input bg-background px-2 focus:outline-none focus:ring-1 focus:ring-ring"
              value={form.gender}
              onChange={(e) => field("gender")(e.target.value)}
            >
              <option value="">{t("apply.selectGender")}</option>
              <option value="male">{t("apply.genderMale")}</option>
              <option value="female">{t("apply.genderFemale")}</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.dateOfBirth")}
              <AiTag field="dateOfBirth" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" type="date" value={form.dateOfBirth}
              onChange={(e) => field("dateOfBirth")(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.nationality")}
              <AiTag field="nationality" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" value={form.nationality}
              onChange={(e) => field("nationality")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.motherName")}
              <AiTag field="motherName" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.motherName}
              onChange={(e) => latinField("motherName")(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.fatherName")}
              <AiTag field="fatherName" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.fatherName}
              onChange={(e) => latinField("fatherName")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.address")}
              <AiTag field="address" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.address}
              placeholder={t("apply.addressPlaceholder")}
              onChange={(e) => latinField("address")(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              Residence City
              <AiTag field="addressCity" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm uppercase" value={form.addressCity}
              onChange={(e) => latinField("addressCity")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              Postal Code
              <AiTag field="postalCode" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" value={form.postalCode}
              onChange={(e) => field("postalCode")(e.target.value)} />
          </div>
        </div>

        {/* ── Passport ───────────────────────────────────────────── */}
        <SectionLabel>{t("inbox.studentTab.sectionPassport")}</SectionLabel>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.passportNumber")}
              <AiTag field="passportNumber" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" value={form.passportNumber}
              onChange={(e) => field("passportNumber")(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.passportIssueDate")}
              <AiTag field="passportIssueDate" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" type="date" value={form.passportIssueDate}
              onChange={(e) => field("passportIssueDate")(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.passportExpiryDate")}
              <AiTag field="passportExpiry" aiFields={data.aiFields} />
            </Label>
            <Input className="h-7 text-sm" type="date" value={form.passportExpiry}
              onChange={(e) => field("passportExpiry")(e.target.value)} />
          </div>
        </div>

        {/* ── Education ──────────────────────────────────────────── */}
        <SectionLabel>{t("inbox.studentTab.schoolInfo")}</SectionLabel>

        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {isHigher
                ? t("inbox.studentTab.bachelorUni")
                : t("inbox.studentTab.highSchool")}
              <AiTag field="school1" aiFields={data.aiFields} />
            </Label>
            <Input
              className="h-7 text-sm"
              placeholder={isHigher
                ? t("inbox.studentTab.bachelorUniPlaceholder")
                : t("inbox.studentTab.highSchoolPlaceholder")}
              value={form.school1}
              onChange={(e) => field("school1")(e.target.value)}
            />
          </div>

          {isPhd && (
            <div className="space-y-1">
              <Label className="text-xs flex items-center">
                {t("inbox.studentTab.masterUni")}
                <AiTag field="school2" aiFields={data.aiFields} />
              </Label>
              <Input
                className="h-7 text-sm"
                placeholder={t("inbox.studentTab.masterUniPlaceholder")}
                value={form.school2}
                onChange={(e) => field("school2")(e.target.value)}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs flex items-center">
                {t("studentDetailPage.eduFieldOfStudy")}
                <AiTag field="educationProgram" aiFields={data.aiFields} />
              </Label>
              <Input
                className="h-7 text-sm"
                value={form.educationProgram}
                onChange={(e) => field("educationProgram")(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs flex items-center">
                {t("studentDetailPage.eduCountry")}
                <AiTag field="educationCountry" aiFields={data.aiFields} />
              </Label>
              <Input
                className="h-7 text-sm"
                value={form.educationCountry}
                onChange={(e) => field("educationCountry")(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs flex items-center">
                {t("apply.graduationYear")}
                <AiTag field="graduationYear" aiFields={data.aiFields} />
              </Label>
              <Input
                className="h-7 text-sm"
                placeholder={t("apply.gradYearPlaceholder")}
                value={form.graduationYear}
                onChange={(e) => field("graduationYear")(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs flex items-center">
                {t("apply.gpa")}
                <AiTag field="gpa" aiFields={data.aiFields} />
              </Label>
              <div className="flex gap-1">
                <Input
                  className="h-7 text-sm flex-1 min-w-0"
                  placeholder={t("apply.gpaPlaceholder")}
                  value={form.gpa}
                  onChange={(e) => field("gpa")(e.target.value)}
                />
                <select
                  className="h-7 text-xs rounded-md border border-input bg-background px-1 shrink-0 focus:outline-none focus:ring-1 focus:ring-ring"
                  value={form.gradingSystem}
                  onChange={(e) => field("gradingSystem")(e.target.value)}
                >
                  {GRADING_SYSTEMS.map((g) => (
                    <option key={g.value} value={g.value}>{g.label}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs flex items-center">
              {t("apply.languageScore")}
              <AiTag field="languageScore" aiFields={data.aiFields} />
            </Label>
            <Input
              className="h-7 text-sm"
              placeholder={t("apply.languageScorePlaceholder")}
              value={form.languageScore}
              onChange={(e) => field("languageScore")(e.target.value)}
            />
          </div>
        </div>

        {/* ── Notes ──────────────────────────────────────────────── */}
        <SectionLabel>{t("apply.additionalNotes")}</SectionLabel>

        <Textarea
          className="text-sm min-h-[64px] resize-none"
          placeholder={t("apply.notesPlaceholder")}
          value={form.notes}
          onChange={(e) => field("notes")(e.target.value)}
        />
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t shrink-0">
        <Button
          size="sm"
          className="w-full"
          onClick={() => void handleCreate()}
          disabled={saving || !form.firstName.trim() || !form.lastName.trim()}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin me-1.5" />}
          {saving ? t("inbox.studentTab.creating") : t("inbox.studentTab.createBtn")}
        </Button>
      </div>
    </div>
  );
}
