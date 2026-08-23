import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useCreateStudent } from "@workspace/api-client-react";
import { createDocumentRecord, uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { useSeason } from "@/contexts/SeasonContext";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneField, isPhoneFieldValid, toPhoneFieldValue } from "@/components/ui/phone-field";
import { Progress } from "@/components/ui/progress";
import {
  FileUp, Sparkles, ChevronLeft, User, GraduationCap, X, CheckCircle2,
  AlertCircle, Loader2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useI18n } from "@/hooks/use-i18n";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { cn } from "@/lib/utils";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { APPLICATION_DOCUMENT_HELP_TEXT, validateApplicationDocumentFileObj, sanitizeFileName } from "@/lib/fileUploadValidation";
import { MAX_DOCUMENT_PARTS, isSingleImageDocumentType, mergeDocumentParts } from "@/lib/documentPartMerge";
import { resolveCountryInput, validateStudentIntakeForm } from "@/lib/studentIntakeValidation";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

const GRADING_SYSTEMS = [
  { value: "4", label: "Out of 4", placeholder: "e.g. 3.8", max: 4 },
  { value: "5", label: "Out of 5", placeholder: "e.g. 4.5", max: 5 },
  { value: "10", label: "Out of 10", placeholder: "e.g. 8.5", max: 10 },
  { value: "12", label: "Out of 12", placeholder: "e.g. 10", max: 12 },
  { value: "20", label: "Out of 20", placeholder: "e.g. 16.5", max: 20 },
  { value: "100", label: "Out of 100", placeholder: "e.g. 85", max: 100 },
];

type LevelDoc = { key: string; label: string; icon: string; accept: string; required: boolean; note?: string };
type AppLevel = string;

const LEVEL_BADGE_COLORS = [
  "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
  "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60",
  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
  "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-700/60",
  "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60",
  "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/60",
];

function levelBadgeColor(index: number): string {
  return LEVEL_BADGE_COLORS[index % LEVEL_BADGE_COLORS.length];
}

function defaultStudyLevel(levels: Array<{ key: string; label: string }>): string {
  if (levels.length === 0) return "";
  return levels.find((level) => `${level.key} ${level.label}`.toLowerCase().includes("bachelor"))?.key
    ?? levels[0].key;
}

function isMasterOrHigher(level: string): boolean {
  const value = level.toLowerCase();
  return value.includes("master") || value.includes("ph") || value.includes("doctor");
}

function isDoctorate(level: string): boolean {
  const value = level.toLowerCase();
  return value.includes("ph") || value.includes("doctor");
}

const DOC_TYPE_META: Record<string, { label: string; icon: string; accept: string }> = {
  high_school_diploma_translation:    { label: "HS Diploma",           icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  class_10th_ssc_marks_sheet:         { label: "10th Marks Sheet",     icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  class_12th_hsc_certificate:         { label: "12th Certificate",     icon: "📜", accept: ".pdf,.jpg,.jpeg,.png" },
  class_12th_hsc_marks_sheet:         { label: "12th Marks Sheet",     icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_certificate:                { label: "Diploma Certificate",  icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_transcript:                 { label: "Diploma Transcript",   icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_certificate:              { label: "Bachelor's Cert.",     icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_transcript:               { label: "Bachelor's Transcript",icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_provisional_certificate:  { label: "Provisional Cert.",    icon: "📜", accept: ".pdf,.jpg,.jpeg,.png" },
  bachelors_transcript_all_semesters: { label: "All Sem. Transcript",  icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_certificate:                { label: "Master's Cert.",       icon: "🎓", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_transcript:                 { label: "Master's Transcript",  icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_provisional_certificate:    { label: "Master's Provisional", icon: "📜", accept: ".pdf,.jpg,.jpeg,.png" },
  masters_transcript_all_semesters:   { label: "All Sem. Transcript",  icon: "📋", accept: ".pdf,.jpg,.jpeg,.png" },
  passport:                           { label: "Passport",             icon: "🛂", accept: ".pdf,.jpg,.jpeg,.png" },
  cv:                                 { label: "CV / Resume",          icon: "📄", accept: ".pdf,.jpg,.jpeg,.png" },
  lor:                                { label: "LOR",                  icon: "✉️", accept: ".pdf,.jpg,.jpeg,.png" },
  sop:                                { label: "SOP",                  icon: "✍️", accept: ".pdf,.jpg,.jpeg,.png" },
  essay:                              { label: "Essay",                icon: "📝", accept: ".pdf,.jpg,.jpeg,.png" },
  experience_letters:                 { label: "Experience Letters",   icon: "💼", accept: ".pdf,.jpg,.jpeg,.png" },
  other_certificates_documents:       { label: "Other Documents",      icon: "📁", accept: ".pdf,.jpg,.jpeg,.png" },
  ielts_pte_gre_gmat_toefl_duolingo:  { label: "Language Test",        icon: "🌐", accept: ".pdf,.jpg,.jpeg,.png" },
  photo:                              { label: "Photograph",           icon: "📷", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_recognition:                { label: "Diploma Recognition",  icon: "📜", accept: ".pdf,.jpg,.jpeg,.png" },
};

type UploadedDoc = { key: string; label: string; file: File; mediaType: string; isImage: boolean; partCount?: number };

type ExtractedData = {
  firstName?: string | null; lastName?: string | null; dateOfBirth?: string | null;
  nationality?: string | null; passportNumber?: string | null; passportIssueDate?: string | null;
  passportExpiry?: string | null; motherName?: string | null; fatherName?: string | null;
  email?: string | null; phone?: string | null; address?: string | null;
  highSchool?: string | null; graduationYear?: number | null; gpa?: string | null;
  languageScore?: string | null; confidence?: string; extractedNotes?: string | null;
};


function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const r = reader.result as string; resolve(r.split(",")[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function compressImage(file: File, maxWidth = 1600, quality = 0.78): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("compress failed")); return; }
          resolve(new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" }));
        }, "image/jpeg", quality);
      };
      img.onerror = reject;
      img.src = e.target?.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function prepareDocumentFile(file: File): Promise<{ file: File; mediaType: string; isImage: boolean }> {
  const isImage = file.type.startsWith("image/");
  if (isImage) { const compressed = await compressImage(file); return { file: compressed, mediaType: "image/jpeg", isImage: true }; }
  return { file, mediaType: file.type || "application/pdf", isImage: false };
}

function DropZone({ docType, uploaded, onUpload, onRemove }: {
  docType: LevelDoc; uploaded?: UploadedDoc; onUpload: (doc: UploadedDoc) => void; onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { toast } = useToast();
  const { t } = useI18n();
  const [merging, setMerging] = useState(false);

  async function handleFiles(files: File[]) {
    if (files.length === 0) return;
    const currentPartCount = uploaded?.partCount || (uploaded ? 1 : 0);
    if (isSingleImageDocumentType(docType.key) && (uploaded || files.length > 1)) {
      toast({ title: "Photograph accepts one file", description: "Remove the current photograph before choosing another PDF or image.", variant: "destructive" });
      return;
    }
    if (currentPartCount + files.length > MAX_DOCUMENT_PARTS) {
      toast({ title: "Too many document parts", description: `You can combine up to ${MAX_DOCUMENT_PARTS} parts in one document box.`, variant: "destructive" });
      return;
    }
    const safeFiles: File[] = [];
    for (const file of files) {
      const validation = validateApplicationDocumentFileObj(file);
      if (!validation.valid) { toast({ title: t("apply.fileError"), description: validation.message, variant: "destructive" }); return; }
      safeFiles.push(new File([file], sanitizeFileName(file.name), { type: file.type }));
    }
    setMerging(true);
    try {
      const prepared = await Promise.all(safeFiles.map(prepareDocumentFile));
      if (!uploaded && prepared.length === 1) {
        onUpload({ key: docType.key, label: docType.label, ...prepared[0], partCount: 1 });
        return;
      }
      const merged = await mergeDocumentParts({
        documentType: docType.key,
        label: docType.label,
        parts: [
          ...(uploaded ? [{ file: uploaded.file, mediaType: uploaded.mediaType }] : []),
          ...prepared.map((item) => ({ file: item.file, mediaType: item.mediaType })),
        ],
      });
      onUpload({ key: docType.key, label: docType.label, file: merged.file, mediaType: merged.mediaType, isImage: false, partCount: currentPartCount + files.length });
    } catch (error) {
      toast({ title: "Documents could not be combined", description: error instanceof Error ? error.message : "Please try again.", variant: "destructive" });
    } finally {
      setMerging(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false);
    void handleFiles(Array.from(e.dataTransfer.files));
  }

  const requiredBadge = docType.required
    ? <span className="text-[10px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full font-semibold border border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60">Required</span>
    : <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-medium border border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50">Optional</span>;

  if (uploaded) {
    return (
      <div className="relative flex flex-col items-center gap-1.5 p-3 border-2 border-green-300 bg-green-50 rounded-2xl text-center min-h-[120px] justify-center">
        <button type="button" onClick={onRemove}
          className="absolute top-2 right-2 w-5 h-5 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-full flex items-center justify-center">
          <X className="w-3 h-3" />
        </button>
        <CheckCircle2 className="w-6 h-6 text-green-500" />
        <div>
          <p className="text-xs font-semibold text-foreground truncate max-w-[90px]">{uploaded.file.name}</p>
          <p className="text-xs text-muted-foreground">{Math.round(uploaded.file.size / 1024)}KB</p>
          {(uploaded.partCount || 1) > 1 && <p className="text-[10px] font-medium text-green-700">{uploaded.partCount} parts combined</p>}
        </div>
        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{docType.label}</span>
        {!isSingleImageDocumentType(docType.key) && (
          <button type="button" disabled={merging} onClick={() => inputRef.current?.click()} className="text-[10px] font-semibold text-primary hover:underline disabled:opacity-50">
            {merging ? "Combining..." : "+ Add another part"}
          </button>
        )}
        <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
          onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-1.5 p-3 border-2 border-dashed rounded-2xl text-center cursor-pointer min-h-[120px] justify-center transition-all",
        dragging ? "border-primary bg-primary/10"
          : docType.required ? "border-rose-200 hover:border-rose-400 hover:bg-rose-50/50" : "border-border hover:border-primary/50 hover:bg-secondary/50"
      )}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <span className="text-2xl">{docType.icon}</span>
      <p className="text-xs font-semibold text-foreground leading-tight">{docType.label}</p>
      {docType.note && <p className="text-[10px] text-muted-foreground leading-tight">{docType.note}</p>}
      <div className="mt-0.5">{requiredBadge}</div>
      <input ref={inputRef} type="file" multiple={!isSingleImageDocumentType(docType.key)} accept={docType.accept} className="hidden"
        onChange={(e) => { void handleFiles(Array.from(e.target.files || [])); e.target.value = ""; }} />
    </div>
  );
}

function AiBadge() {
  return <span className="ml-1.5 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium dark:bg-emerald-900/40 dark:text-emerald-300">AI ✓</span>;
}

function FormField({ label, value, onChange, placeholder, type = "text", aiExtracted, required, latinUppercase }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
  aiExtracted?: boolean; required?: boolean; latinUppercase?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value;
    if (latinUppercase) v = v.toUpperCase().replace(/[^A-ZÀ-ÖØ-Þ\s'-]/g, "");
    onChange(v);
  };
  return (
    <div className="space-y-1.5">
      <Label className="font-semibold text-sm flex items-center">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
        {aiExtracted && <AiBadge />}
      </Label>
      <Input type={type} value={value} onChange={handleChange} placeholder={placeholder}
        className={cn("rounded-xl", latinUppercase && "uppercase", aiExtracted && "border-emerald-300 bg-emerald-50/40 focus-visible:ring-emerald-400")} />
    </div>
  );
}

type Step = "upload" | "analyzing" | "review";

function NationalityCombobox({ value, onChange, countries, aiExtracted }: {
  value: string; onChange: (v: string) => void;
  countries: Array<{ id: number; name: string; code?: string }>; aiExtracted?: boolean;
}) {
  const [searchVal, setSearchVal] = useState("");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Server-side (AJAX) debounced search over the country catalog.
  const { data: filtered = [] } = useCountrySearch(searchVal);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onChange(resolveCountryInput(searchVal, value));
        setOpen(false);
        setSearchVal("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onChange, open, searchVal, value]);

  return (
    <div className="relative" ref={containerRef}>
      <Input value={open ? searchVal : value}
        onChange={e => { setSearchVal(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => { setSearchVal(""); setOpen(true); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && open) {
            event.preventDefault();
            onChange(resolveCountryInput(searchVal, value));
            setOpen(false);
            setSearchVal("");
          }
          if (event.key === "Escape") { setOpen(false); setSearchVal(""); }
        }}
        placeholder={value || "Select or type..."} className="h-9 text-sm" autoComplete="off" />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? "No match — custom value OK" : "No countries loaded"}</div>}
          {filtered.map(c => (
            <button key={c.id} type="button"
              className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              <CountryFlag code={c.code || ""} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const EMPTY_FORM = {
  firstName: "", lastName: "", email: "", phone: "",
  nationality: "", dateOfBirth: "", gender: "",
  passportNumber: "", passportIssueDate: "", passportExpiry: "",
  motherName: "", fatherName: "", address: "",
  highSchool: "", graduationYear: "", gpa: "", gradingSystem: "4",
  universityBachelor: "", universityMaster: "",
  languageScore: "", notes: "", interestedLevel: "",
};

export function AddStudentModal({ open, onClose, onSuccess, defaultStatus }: {
  open: boolean; onClose: () => void; onSuccess: () => void; defaultStatus?: string;
}) {
  const { toast } = useToast();
  const createStudent = useCreateStudent();
  const { season: _season } = useSeason();
  const {
    levels: studyLevels,
    isLoading: studyLevelsLoading,
    isError: studyLevelsError,
    hasCatalogData: hasCanonicalStudyLevels,
  } = useStudyLevels();
  const canonicalStudyLevels = hasCanonicalStudyLevels ? studyLevels : [];

  const { data: countriesResp } = useQuery({
    queryKey: ["all-countries-nationality"],
    queryFn: () => fetch(`${BASE_URL}/api/countries?limit=500`, { credentials: "include" }).then(r => r.json()),
  });
  const allCountries: Array<{ id: number; name: string; code?: string; flagEmoji?: string | null }> = countriesResp?.data ?? [];

  const [step, setStep] = useState<Step>("upload");
  const [docs, setDocs] = useState<Record<string, UploadedDoc>>({});
  const [extractedFields, setExtractedFields] = useState<Set<string>>(new Set());
  const [form, setForm] = useState(EMPTY_FORM);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [applicationLevel, setApplicationLevel] = useState<AppLevel>("");

  useEffect(() => {
    if (canonicalStudyLevels.length === 0) return;
    const selectedLevelExists = canonicalStudyLevels.some((level) => level.key === applicationLevel);
    if (!applicationLevel || !selectedLevelExists) {
      const level = defaultStudyLevel(canonicalStudyLevels);
      setApplicationLevel(level);
      setForm((current) => ({ ...current, interestedLevel: level }));
    }
  }, [applicationLevel, canonicalStudyLevels]);

  const degreeDocumentRequirements = useQuery<{ documentType: string; mandatory: boolean; sortOrder: number }[]>({
    queryKey: ["degree-doc-reqs", applicationLevel],
    queryFn: async () => {
      const response = await fetch(`${BASE_URL}/api/degrees/by-value/${encodeURIComponent(applicationLevel)}/document-requirements`, { credentials: "include" });
      if (!response.ok) throw new Error(`Document requirements could not be loaded (${response.status})`);
      const payload = await response.json();
      if (!Array.isArray(payload)) throw new Error("Document requirements response is invalid");
      return payload;
    },
    enabled: !!applicationLevel,
    staleTime: 30_000,
  });

  const currentDocs = useMemo<LevelDoc[]>(() => {
    if (!degreeDocumentRequirements.data) return [];
    return [...degreeDocumentRequirements.data]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((requirement) => {
        const meta = DOC_TYPE_META[requirement.documentType] ?? {
          label: requirement.documentType,
          icon: "📄",
          accept: ".pdf,.jpg,.jpeg,.png",
        };
        return {
          key: requirement.documentType,
          label: meta.label,
          icon: meta.icon,
          accept: meta.accept,
          required: requirement.mandatory,
        };
      });
  }, [degreeDocumentRequirements.data]);

  const documentPolicyReady = !!applicationLevel
    && degreeDocumentRequirements.isSuccess
    && currentDocs.length > 0;

  function handleClose() {
    const level = defaultStudyLevel(canonicalStudyLevels);
    setStep("upload"); setDocs({}); setExtractedFields(new Set());
    setForm({ ...EMPTY_FORM, interestedLevel: level }); setAnalysisError(null); setApplicationLevel(level);
    onClose();
  }

  function field(name: keyof typeof EMPTY_FORM) {
    return (value: string) => setForm((f) => ({ ...f, [name]: value }));
  }

  function selectApplicationLevel(level: string) {
    setApplicationLevel(level);
    setForm((current) => ({ ...current, interestedLevel: level }));
  }

  function selectInterestedLevel(level: string) {
    setForm((current) => ({ ...current, interestedLevel: level }));
    setApplicationLevel(level);
  }

  async function analyzeDocuments() {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) { toast({ title: "Upload at least one document", variant: "destructive" }); return; }
    setStep("analyzing"); setAnalysisError(null);
    try {
      const docPayload = await Promise.all(uploadedDocs.map(async (d) => ({
        type: d.isImage ? "image" : "pdf", data: await fileToBase64(d.file), mediaType: d.mediaType, label: d.label,
      })));
      const res = await fetch(`${BASE_URL}/api/ai/extract-document`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ documents: docPayload, scope: "agent", appliedLevel: form.interestedLevel }),
      });
      if (!res.ok) {
        if (res.status === 413) throw new Error("Documents are too large even after compression. Please use smaller files (max ~10MB total).");
        const err = await res.json().catch(() => ({ error: "AI extraction failed" }));
        throw new Error(err.error || "AI extraction failed");
      }
      const { extracted, warnings: serverWarnings }: { extracted: ExtractedData; warnings?: string[] } = await res.json();
      if ((extracted as any).passportExpired === true) {
        setAnalysisError(`Passport has expired (${extracted.passportExpiry}). Expired passports cannot be used for applications. Please upload a valid passport.`);
        setStep("review"); return;
      }
      if (serverWarnings?.length) setAnalysisError(serverWarnings.join(" "));
      const newForm = { ...form };
      const newExtracted = new Set<string>();
      const mapping: [keyof typeof EMPTY_FORM, keyof ExtractedData][] = [
        ["firstName", "firstName"], ["lastName", "lastName"], ["email", "email"], ["phone", "phone"],
        ["nationality", "nationality"], ["dateOfBirth", "dateOfBirth"], ["passportNumber", "passportNumber"],
        ["passportIssueDate", "passportIssueDate"], ["passportExpiry", "passportExpiry"],
        ["motherName", "motherName"], ["fatherName", "fatherName"], ["address", "address"],
        ["highSchool", "highSchool"], ["gpa", "gpa"], ["languageScore", "languageScore"],
      ];
      for (const [fk, ek] of mapping) {
        const val = extracted[ek];
        if (val !== null && val !== undefined && val !== "") {
          if (fk === "phone") {
            const phoneStr = String(val).replace(/\s+/g, " ").trim();
            newForm.phone = toPhoneFieldValue(phoneStr);
            newExtracted.add("phone");
          } else if (fk === "nationality") {
            const natVal = String(val).trim(); const lower = natVal.toLowerCase();
            const exactMatch = allCountries.find(c => c.name.toLowerCase() === lower);
            if (exactMatch) { newForm.nationality = exactMatch.name; }
            else {
              const DEMONYM_MAP: Record<string, string> = {
                "afghan": "Afghanistan", "turkish": "Turkey", "iranian": "Iran", "pakistani": "Pakistan",
                "indian": "India", "iraqi": "Iraq", "syrian": "Syria", "jordanian": "Jordan",
                "lebanese": "Lebanon", "palestinian": "Palestine", "egyptian": "Egypt", "moroccan": "Morocco",
                "algerian": "Algeria", "tunisian": "Tunisia", "libyan": "Libya", "sudanese": "Sudan",
                "somali": "Somalia", "nigerian": "Nigeria", "ethiopian": "Ethiopia", "kenyan": "Kenya",
                "ghanaian": "Ghana", "british": "United Kingdom", "american": "United States", "canadian": "Canada",
                "french": "France", "german": "Germany", "dutch": "Netherlands", "swedish": "Sweden",
                "italian": "Italy", "spanish": "Spain", "polish": "Poland", "hungarian": "Hungary",
                "czech": "Czech Republic", "romanian": "Romania", "ukrainian": "Ukraine", "russian": "Russia",
                "australian": "Australia", "chinese": "China", "japanese": "Japan", "korean": "South Korea",
                "malaysian": "Malaysia", "singaporean": "Singapore", "bangladeshi": "Bangladesh",
                "azerbaijani": "Azerbaijan", "kazakh": "Kazakhstan", "uzbek": "Uzbekistan",
                "kyrgyz": "Kyrgyzstan", "tajik": "Tajikistan", "turkmen": "Turkmenistan",
                "saudi": "Saudi Arabia", "emirati": "UAE", "qatari": "Qatar", "kuwaiti": "Kuwait", "yemeni": "Yemen",
                "afg": "Afghanistan", "tur": "Turkey", "irn": "Iran", "pak": "Pakistan", "ind": "India", "irq": "Iraq", "syr": "Syria",
              };
              const mapped = DEMONYM_MAP[lower];
              if (mapped) { const cm = allCountries.find(c => c.name.toLowerCase() === mapped.toLowerCase()); newForm.nationality = cm ? cm.name : mapped; }
              else { const cm = allCountries.find(c => c.code?.toLowerCase() === lower); newForm.nationality = cm ? cm.name : natVal; }
            }
            newExtracted.add("nationality");
          } else if (fk === "gpa") {
            const gpaStr = String(val).trim();
            const isPct = (extracted as any).gpaScale === 100 || (extracted as any).gpaScale === "100";
            if (isPct || /^\d+(\.\d+)?$/.test(gpaStr)) { newForm.gpa = gpaStr; newForm.gradingSystem = "100"; }
            else {
              const gpaMatch = gpaStr.match(/^([\d.]+)\s*\/\s*(\d+)$/);
              if (gpaMatch) { newForm.gpa = gpaMatch[1]; const ms = GRADING_SYSTEMS.find(g => g.value === gpaMatch[2]); if (ms) newForm.gradingSystem = ms.value; }
              else { newForm.gpa = gpaStr; }
            }
            newExtracted.add("gpa");
          } else { (newForm as any)[fk] = String(val); newExtracted.add(fk); }
        }
      }
      if (extracted.graduationYear != null) { newForm.graduationYear = String(extracted.graduationYear); newExtracted.add("graduationYear"); }
      setForm(newForm); setExtractedFields(newExtracted); setStep("review");
    } catch (err: any) { setAnalysisError(err.message || "AI extraction failed"); setStep("review"); }
  }

  async function saveDocumentsForStudent(studentId: number, firstName: string, lastName: string) {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) return { uploaded: [] as string[], failed: [] as string[] };
    const docTypeLabel: Record<string, string> = { passport: "Passport", diploma: "Diploma", transcript: "Transcript", photo: "Photo", other: "Other" };
    const results = await Promise.all(uploadedDocs.map(async (d) => {
      const label = docTypeLabel[d.label?.toLowerCase()] ?? d.label ?? "Document";
      try {
        const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(d.file);
        await createDocumentRecord({
          name: `${firstName}-${lastName}-${label}`, type: d.key, status: "pending", studentId, fileKey, mimeType, sizeBytes, originalFileName: d.file?.name ?? null,
        });
        return { label, uploaded: true };
      } catch (err) { console.error(`[AGENT_STUDENTS] upload failed for ${label}:`, err); return { label, uploaded: false }; }
    }));
    return {
      uploaded: results.filter((result) => result.uploaded).map((result) => result.label),
      failed: results.filter((result) => !result.uploaded).map((result) => result.label),
    };
  }

  function handleSubmit() {
    const missing: string[] = [];
    if (!form.firstName.trim()) missing.push("First Name"); if (!form.lastName.trim()) missing.push("Last Name");
    if (!form.email.trim()) missing.push("Email"); if (!form.phone.trim()) missing.push("Phone");
    if (!form.dateOfBirth.trim()) missing.push("Date of Birth"); if (!form.gender.trim()) missing.push("Gender");
    if (!form.nationality.trim()) missing.push("Nationality"); if (!form.motherName.trim()) missing.push("Mother's Name");
    if (!form.fatherName.trim()) missing.push("Father's Name"); if (!form.passportNumber.trim()) missing.push("Passport Number");
    if (!form.passportIssueDate.trim()) missing.push("Issue Date"); if (!form.passportExpiry.trim()) missing.push("Expiry Date");
    if (!form.interestedLevel.trim()) missing.push("Interested Level");
    if (missing.length > 0) { toast({ title: "Required fields missing", description: missing.join(", "), variant: "destructive" }); return; }
    if (!isPhoneFieldValid(form.phone, true)) { toast({ title: "Invalid phone number", description: "Enter a valid phone number for the selected country.", variant: "destructive" }); return; }
    const validationErrors = validateStudentIntakeForm(form);
    if (validationErrors.length > 0) { toast({ title: "Check student details", description: validationErrors.join(" "), variant: "destructive" }); return; }
    if (!documentPolicyReady) {
      toast({ title: "Document requirements unavailable", description: "The selected level's document policy could not be verified. Please reload and try again.", variant: "destructive" });
      return;
    }
    if (Object.keys(docs).length === 0) {
      toast({ title: "No documents uploaded", description: "A student profile requires documents. Create this person as a lead until their documents are available.", variant: "destructive" });
      return;
    }
    const missingDocs = currentDocs.filter(dt => dt.required && !docs[dt.key]).map(dt => dt.label);
    if (missingDocs.length > 0) { toast({ title: "Required documents missing", description: missingDocs.join(", "), variant: "destructive" }); return; }
    const fullPhone = form.phone || null;
    createStudent.mutate(
      { data: { firstName: form.firstName, lastName: form.lastName, email: form.email || null, phone: fullPhone, nationality: form.nationality || null, dateOfBirth: form.dateOfBirth || null, gender: form.gender || null, passportNumber: form.passportNumber || null, passportIssueDate: form.passportIssueDate || null, passportExpiry: form.passportExpiry || null, motherName: form.motherName || null, fatherName: form.fatherName || null, address: form.address || null, highSchool: form.highSchool || null, graduationYear: form.graduationYear ? parseInt(form.graduationYear, 10) : null, gpa: form.gpa ? `${form.gpa} / ${form.gradingSystem}` : null, languageScore: form.languageScore || null, notes: form.notes || null, interestedLevel: form.interestedLevel || null, status: defaultStatus || "active" } },
      {
        onSuccess: async (createdStudent: any) => {
          const docCount = Object.keys(docs).length;
          if (docCount > 0) {
            const result = await saveDocumentsForStudent(createdStudent.id, form.firstName, form.lastName);
            if (result.failed.length > 0) {
              toast({ title: "Student created, but document upload is incomplete", description: `${result.uploaded.length}/${docCount} documents added. Failed: ${result.failed.join(", ")}. Please upload them again from the student profile.`, variant: "destructive" });
            } else {
              toast({ title: "Student created", description: `${result.uploaded.length} document${result.uploaded.length !== 1 ? "s" : ""} added to profile.` });
            }
          }
          else { toast({ title: "Student created successfully" }); }
          handleClose(); onSuccess();
        },
        onError: (err: any) => { toast({ title: "Failed to create student", description: err?.message, variant: "destructive" }); },
      }
    );
  }

  const uploadedCount = Object.keys(docs).length;
  const missingRequiredDocLabels = currentDocs.filter((doc) => doc.required && !docs[doc.key]).map((doc) => doc.label);
  const canProceedToForm = documentPolicyReady && uploadedCount > 0 && missingRequiredDocLabels.length === 0;
  const stepProgress = step === "upload" ? 33 : step === "analyzing" ? 66 : 100;
  const ef = extractedFields;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && step !== "analyzing") handleClose(); }}>
      <DialogContent
        className="sm:max-w-2xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden"
        onInteractOutside={(e) => { if (step === "analyzing") e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (step === "analyzing") e.preventDefault(); }}
      >
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/50 shrink-0">
          <DialogTitle className="text-xl font-display">Add New Student</DialogTitle>
          <div className="mt-3 space-y-2">
            <Progress value={stepProgress} className="h-1.5" />
            <div className="flex items-center gap-6 text-xs font-medium">
              {[{ id: "upload", label: "1. Upload Documents" }, { id: "analyzing", label: "2. AI Analysis" }, { id: "review", label: "3. Review & Save" }].map((s) => (
                <span key={s.id} className={cn(step === s.id ? "text-primary" : "text-muted-foreground")}>{s.label}</span>
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 py-5">
          {step === "upload" && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Application Level</p>
                {studyLevelsLoading && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading study levels…
                  </div>
                )}
                {(studyLevelsError || (!studyLevelsLoading && !hasCanonicalStudyLevels)) && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Study levels could not be loaded from the catalog. Student creation is disabled.
                  </div>
                )}
                <div className={cn("grid gap-2", canonicalStudyLevels.length <= 4 ? "grid-cols-4" : "grid-cols-3")}>
                  {canonicalStudyLevels.map((lv, index) => (
                    <button key={lv.key} type="button" onClick={() => selectApplicationLevel(lv.key)}
                      className={cn("rounded-xl border-2 px-3 py-2.5 text-center transition-all", applicationLevel === lv.key ? "border-primary bg-primary/5 shadow-sm" : "border-border hover:border-primary/40 hover:bg-secondary/40")}>
                      <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded-md border", levelBadgeColor(index))}>{lv.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-100 rounded-2xl p-3 flex items-start gap-3">
                <Sparkles className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">AI Auto-Fill</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Upload documents — AI will read and fill the form. <span className="font-medium text-rose-600">Required</span> documents take priority.</p>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-foreground">Required Documents</p>
                  <p className="text-xs text-muted-foreground">{uploadedCount}/{currentDocs.length} uploaded</p>
                </div>
                {degreeDocumentRequirements.isPending && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading document requirements…
                  </div>
                )}
                {degreeDocumentRequirements.isError && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> Document requirements could not be loaded. Student creation is disabled until this policy is available.
                  </div>
                )}
                {degreeDocumentRequirements.isSuccess && currentDocs.length === 0 && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" /> No reviewed document policy exists for this level. Student creation is disabled.
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground mb-2">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
                <div className={cn("grid gap-2", currentDocs.length <= 5 ? "grid-cols-5" : currentDocs.length <= 7 ? "grid-cols-4" : "grid-cols-3")}>
                  {currentDocs.map((dt) => (
                    <DropZone key={dt.key} docType={dt} uploaded={docs[dt.key]}
                      onUpload={(doc) => setDocs((d) => ({ ...d, [dt.key]: doc }))}
                      onRemove={() => setDocs((d) => { const n = { ...d }; delete n[dt.key]; return n; })} />
                  ))}
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-xs text-amber-700">Student profiles require documents. If you only have contact details, create the person as a lead from the Leads page.</p>
              </div>
            </div>
          )}

          {step === "analyzing" && (
            <div className="flex flex-col items-center justify-center py-16 gap-6">
              <div className="relative">
                <div className="w-20 h-20 rounded-full bg-gradient-to-br from-violet-100 to-blue-100 flex items-center justify-center">
                  <Sparkles className="w-10 h-10 text-violet-500" />
                </div>
                <div className="absolute inset-0 rounded-full border-4 border-violet-200 animate-ping opacity-40" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-lg font-display font-semibold">AI is reading your documents…</p>
                <p className="text-sm text-muted-foreground">Extracting information from {uploadedCount} document{uploadedCount !== 1 ? "s" : ""}</p>
              </div>
              <div className="flex flex-col gap-2 w-full max-w-xs">
                {Object.values(docs).map((d) => (
                  <div key={d.key} className="flex items-center gap-2 text-sm bg-secondary/50 rounded-lg px-3 py-2">
                    <Loader2 className="w-3.5 h-3.5 text-primary animate-spin shrink-0" />
                    <span className="text-sm text-muted-foreground">Analyzing {d.label}…</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-6">
              {ef.size > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-start gap-2 dark:bg-emerald-900/20 dark:border-emerald-700/40">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    <strong>AI extracted {ef.size} field{ef.size !== 1 ? "s" : ""} automatically.</strong>{" "}
                    Fields marked <span className="bg-emerald-100 text-emerald-700 px-1 rounded font-semibold text-[10px] dark:bg-emerald-900/40 dark:text-emerald-300">AI ✓</span> were filled from documents. Review and complete any missing fields below.
                  </p>
                </div>
              )}
              {analysisError && (
                <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 dark:bg-rose-900/20 dark:border-rose-700/40">
                  <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                  <p className="text-xs text-rose-700 dark:text-rose-300">AI could not read the documents: {analysisError}. Please fill the form manually.</p>
                </div>
              )}

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <User className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Personal Information</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <FormField required label="First Name" value={form.firstName} onChange={field("firstName")} placeholder="First name" aiExtracted={ef.has("firstName")} latinUppercase />
                  <FormField required label="Last Name" value={form.lastName} onChange={field("lastName")} placeholder="Last name" aiExtracted={ef.has("lastName")} latinUppercase />
                  <FormField required label="Email" value={form.email} onChange={field("email")} placeholder="email@example.com" type="email" aiExtracted={ef.has("email")} />
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-sm flex items-center">Phone<span className="text-destructive ml-0.5">*</span>{ef.has("phone") && <AiBadge />}</Label>
                    <PhoneField value={form.phone} onChange={(v) => setForm(f => ({ ...f, phone: v }))} />
                  </div>
                  <FormField required label="Date of Birth" value={form.dateOfBirth} onChange={field("dateOfBirth")} type="date" aiExtracted={ef.has("dateOfBirth")} />
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">Gender<span className="text-destructive ml-0.5">*</span></Label>
                    <select value={form.gender} onChange={(e) => field("gender")(e.target.value)}
                      className="mt-1 flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm">
                      <option value="">Select…</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">Nationality<span className="text-destructive ml-0.5">*</span>{ef.has("nationality") && <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium dark:bg-emerald-900/40 dark:text-emerald-300">AI ✓</span>}</Label>
                    <div className="mt-1"><NationalityCombobox value={form.nationality} onChange={field("nationality")} countries={allCountries} /></div>
                  </div>
                  <FormField required label="Mother's Name" value={form.motherName} onChange={field("motherName")} placeholder="Mother's name" aiExtracted={ef.has("motherName")} latinUppercase />
                  <FormField required label="Father's Name" value={form.fatherName} onChange={field("fatherName")} placeholder="Father's name" aiExtracted={ef.has("fatherName")} latinUppercase />
                  <div className="col-span-2"><FormField label="Address" value={form.address} onChange={field("address")} placeholder="Full home address" aiExtracted={ef.has("address")} /></div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <span className="text-base leading-none">🛂</span>
                  <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Passport / Identity</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2"><FormField required label="Passport Number" value={form.passportNumber} onChange={field("passportNumber")} placeholder="e.g. AB1234567" aiExtracted={ef.has("passportNumber")} /></div>
                  <FormField required label="Issue Date" value={form.passportIssueDate} onChange={field("passportIssueDate")} type="date" aiExtracted={ef.has("passportIssueDate")} />
                  <FormField required label="Expiry Date" value={form.passportExpiry} onChange={field("passportExpiry")} type="date" aiExtracted={ef.has("passportExpiry")} />
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <GraduationCap className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Education</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2 space-y-1.5">
                    <Label className="font-semibold text-sm">Interested Level</Label>
                    <Select value={form.interestedLevel} onValueChange={selectInterestedLevel}>
                      <SelectTrigger className="rounded-xl h-9"><SelectValue placeholder="Select level..." /></SelectTrigger>
                      <SelectContent>{canonicalStudyLevels.map((level) => <SelectItem key={level.key} value={level.key}>{level.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2"><FormField label="High School" value={form.highSchool} onChange={field("highSchool")} placeholder="e.g. Ankara Fen Lisesi" aiExtracted={ef.has("highSchool")} /></div>
                  {isMasterOrHigher(applicationLevel) && (
                    <div className="col-span-2"><FormField label="University (Bachelor)" value={form.universityBachelor} onChange={field("universityBachelor")} placeholder="e.g. Istanbul University" aiExtracted={ef.has("universityBachelor")} /></div>
                  )}
                  {isDoctorate(applicationLevel) && (
                    <div className="col-span-2"><FormField label="University (Master)" value={form.universityMaster} onChange={field("universityMaster")} placeholder="e.g. Bogazici University" aiExtracted={ef.has("universityMaster")} /></div>
                  )}
                  <FormField label="Graduation Year" value={form.graduationYear} onChange={field("graduationYear")} placeholder="e.g. 2022" aiExtracted={ef.has("graduationYear")} />
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-sm flex items-center">GPA{ef.has("gpa") && <AiBadge />}</Label>
                    <div className="flex gap-1.5">
                      <Input type="number" step="0.01" min="0" max={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.max ?? 4}
                        value={form.gpa} onChange={(e) => setForm(f => ({ ...f, gpa: e.target.value }))}
                        placeholder={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.placeholder ?? "e.g. 3.8"}
                        className={cn("rounded-xl flex-1", ef.has("gpa") && "border-emerald-300 bg-emerald-50/40 focus-visible:ring-emerald-400")} />
                      <Select value={form.gradingSystem} onValueChange={(v) => setForm(f => ({ ...f, gradingSystem: v, gpa: "" }))}>
                        <SelectTrigger className="w-[110px] h-9 text-sm rounded-xl shrink-0"><SelectValue /></SelectTrigger>
                        <SelectContent>{GRADING_SYSTEMS.map(gs => (<SelectItem key={gs.value} value={gs.value}>/ {gs.value}</SelectItem>))}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="col-span-2"><FormField label="Language Score" value={form.languageScore} onChange={field("languageScore")} placeholder="e.g. IELTS 7.0, TOEFL 100" aiExtracted={ef.has("languageScore")} /></div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <FileUp className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Documents</h3>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">{Object.keys(docs).length}/{currentDocs.length} uploaded</p>
                </div>
                <p className="text-[11px] text-muted-foreground mb-1">{APPLICATION_DOCUMENT_HELP_TEXT}</p>
                <div className={cn("grid gap-2", currentDocs.length <= 5 ? "grid-cols-5" : currentDocs.length <= 7 ? "grid-cols-4" : "grid-cols-3")}>
                  {currentDocs.map((dt) => (
                    <DropZone key={dt.key} docType={dt} uploaded={docs[dt.key]}
                      onUpload={(doc) => setDocs((d) => ({ ...d, [dt.key]: doc }))}
                      onRemove={() => setDocs((d) => { const n = { ...d }; delete n[dt.key]; return n; })} />
                  ))}
                </div>
              </section>

              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Notes</Label>
                <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional notes about this student…" rows={2}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none" />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-5 pt-3 border-t border-border/50 flex items-center justify-between shrink-0 gap-3">
          {step === "upload" && (
            <>
              <Button variant="ghost" onClick={handleClose} className="rounded-xl">Cancel</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("review")} disabled={!canProceedToForm} className="rounded-xl text-muted-foreground">Skip AI Analysis</Button>
                <Button onClick={analyzeDocuments} disabled={!canProceedToForm}
                  className="rounded-xl gap-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white border-0">
                  <Sparkles className="w-4 h-4" />
                  Analyze {uploadedCount > 0 ? `${uploadedCount} Doc${uploadedCount !== 1 ? "s" : ""}` : "Documents"}
                </Button>
              </div>
            </>
          )}
          {step === "analyzing" && (<div className="w-full flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>)}
          {step === "review" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} className="rounded-xl gap-2"><ChevronLeft className="w-4 h-4" /> Back</Button>
              <Button onClick={handleSubmit}
                disabled={createStudent.isPending || !documentPolicyReady || !form.firstName.trim() || !form.lastName.trim() || !form.email.trim() || !form.phone.trim() || !form.dateOfBirth.trim() || !form.nationality.trim() || !form.motherName.trim() || !form.fatherName.trim() || !form.passportNumber.trim() || !form.passportIssueDate.trim() || !form.passportExpiry.trim() || !form.interestedLevel.trim()}
                className="rounded-xl gap-2">
                {createStudent.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Create Student
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
