import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Circle, AlertTriangle, GraduationCap } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const DOC_TYPE_LABELS: Record<string, string> = {
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

interface StudentDocChecklistProps {
  /**
   * Display-only label fallback (e.g. "Bachelor"). The legacy
   * degree-level requirement system has been retired — the checklist
   * now reads exclusively from the program. The `level` prop is kept
   * only to render a friendlier heading when no program is attached.
   */
  level?: string | null | undefined;
  documents: any[];
  compact?: boolean;
  programId?: number | null;
  programRequirements?: { documentType: string; mandatory: boolean; sortOrder?: number }[] | null;
}

export function StudentDocChecklist({ documents, compact = false, programId, programRequirements }: StudentDocChecklistProps) {
  const { t } = useI18n();
  const docLabel = (type: string) => {
    const key = `programDocTypes.${type}`;
    const translated = t(key);
    return translated === key ? (DOC_TYPE_LABELS[type] || type) : translated;
  };
  type ProgramDocReq = { documentType: string; mandatory: boolean; sortOrder?: number };

  const { data: fetchedProgramReqs, isFetched: programReqsFetched } = useQuery<ProgramDocReq[]>({
    queryKey: ["program-document-requirements", programId],
    queryFn: async (): Promise<ProgramDocReq[]> => {
      if (!programId) return [];
      try {
        const res = await customFetch(`${BASE_URL}/api/programs/${programId}/document-requirements`) as unknown;
        if (!Array.isArray(res)) return [];
        return res
          .filter((r): r is { documentType: unknown; mandatory: unknown; sortOrder?: unknown } =>
            !!r && typeof r === "object" && typeof (r as any).documentType === "string")
          .map(r => ({
            documentType: r.documentType as string,
            mandatory: !!r.mandatory,
            sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : undefined,
          }));
      } catch {
        return [];
      }
    },
    enabled: !!programId && !Array.isArray(programRequirements),
    staleTime: 60_000,
  });

  const programReqsResolved = !programId
    ? Array.isArray(programRequirements)
    : Array.isArray(programRequirements) || programReqsFetched;

  const effectiveProgramReqs: ProgramDocReq[] | null = useMemo(() => {
    if (Array.isArray(programRequirements)) return programRequirements;
    if (programId && Array.isArray(fetchedProgramReqs)) return fetchedProgramReqs;
    return null;
  }, [programRequirements, fetchedProgramReqs, programId]);

  const requiredDocs = useMemo(() => {
    if (!effectiveProgramReqs) return [];
    return [...effectiveProgramReqs]
      .map((r, idx) => ({
        id: `prog-${r.documentType}`,
        documentType: r.documentType,
        mandatory: !!r.mandatory,
        sortOrder: typeof r.sortOrder === "number" ? r.sortOrder : idx,
      }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [effectiveProgramReqs]);

  const uploadedTypes = useMemo(() => {
    const set = new Set<string>();
    documents.forEach((d: any) => {
      if (d.type) set.add(d.type.toLowerCase());
    });
    return set;
  }, [documents]);

  const mandatoryDocs = requiredDocs.filter((r: any) => r.mandatory);
  const optionalDocs = requiredDocs.filter((r: any) => !r.mandatory);
  const mandatoryUploaded = mandatoryDocs.filter((r: any) => uploadedTypes.has(r.documentType)).length;
  const mandatoryMissing = mandatoryDocs.filter((r: any) => !uploadedTypes.has(r.documentType));
  const allEnabled = requiredDocs.length;
  const allUploaded = requiredDocs.filter((r: any) => uploadedTypes.has(r.documentType)).length;

  const hasProgramContext = !!programId || Array.isArray(programRequirements);

  if (!hasProgramContext) {
    return (
      <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
        <p className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          {t("docChecklist.selectProgramFirst")}
        </p>
      </div>
    );
  }

  if (!programReqsResolved) {
    return (
      <div className="p-3 rounded-xl bg-muted/50 border text-xs text-muted-foreground">
        {t("docChecklist.loading")}
      </div>
    );
  }

  if (!requiredDocs.length) {
    return (
      <div className="p-3 rounded-xl bg-muted/50 border text-xs text-muted-foreground">
        {t("common.programNoDocReq")}
      </div>
    );
  }

  return (
    <div className={`rounded-xl border ${mandatoryMissing.length > 0 ? "border-red-200 dark:border-red-800 bg-red-50/30 dark:bg-red-950/10" : "border-green-200 dark:border-green-800 bg-green-50/30 dark:bg-green-950/10"}`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-inherit">
        <div className="flex items-center gap-2">
          <GraduationCap className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">
            {t("docChecklist.title")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            mandatoryMissing.length === 0
              ? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
              : "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300"
          }`}>
            {t("docChecklist.uploadedCount", { n: allUploaded, total: allEnabled })}
          </span>
          {mandatoryMissing.length === 0 && (
            <CheckCircle2 className="w-4 h-4 text-green-600" />
          )}
        </div>
      </div>

      {mandatoryMissing.length > 0 && (
        <div className="px-4 py-2 bg-red-50 dark:bg-red-950/30 border-b border-red-200 dark:border-red-800">
          <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1.5 font-medium">
            <XCircle className="w-3.5 h-3.5 shrink-0" />
            {t("docChecklist.missingMandatory", { list: mandatoryMissing.map((r: any) => docLabel(r.documentType)).join(", ") })}
          </p>
        </div>
      )}

      <div className="px-4 py-3 space-y-3">
        {mandatoryDocs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {t("docChecklist.mandatory", { n: mandatoryUploaded, total: mandatoryDocs.length })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {mandatoryDocs.map((r: any) => {
                const uploaded = uploadedTypes.has(r.documentType);
                return (
                  <div
                    key={r.id}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full border font-medium ${
                      uploaded
                        ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/50 dark:text-green-300 dark:border-green-700"
                        : "bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-700"
                    }`}
                  >
                    {uploaded
                      ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                      : <XCircle className="w-3 h-3 shrink-0" />
                    }
                    {docLabel(r.documentType)}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!compact && optionalDocs.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {t("docChecklist.optional", { n: optionalDocs.filter((r: any) => uploadedTypes.has(r.documentType)).length, total: optionalDocs.length })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {optionalDocs.map((r: any) => {
                const uploaded = uploadedTypes.has(r.documentType);
                return (
                  <div
                    key={r.id}
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full border ${
                      uploaded
                        ? "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700"
                        : "bg-muted/50 text-muted-foreground border-border"
                    }`}
                  >
                    {uploaded
                      ? <CheckCircle2 className="w-3 h-3 shrink-0" />
                      : <Circle className="w-3 h-3 shrink-0" />
                    }
                    {docLabel(r.documentType)}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
