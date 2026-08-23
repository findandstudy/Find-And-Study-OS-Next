import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { useListStudents, useCreateStudent, customFetch } from "@workspace/api-client-react";
import { createDocumentRecord, uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { useSeason } from "@/contexts/SeasonContext";
import { useAuth } from "@/hooks/use-auth";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import {
  Search, Plus, FileText, FileUp, Sparkles, ChevronLeft,
  User, GraduationCap, X, CheckCircle2, AlertCircle,
  Users, Loader2, LayoutGrid, List, Eye,
  ArrowUpDown, ArrowUp, ArrowDown, Trash2, Pencil,
  Filter, UserCheck, UserX, UserMinus, UserPlus,
  Trophy, XCircle, Download, ArrowRightLeft,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-stages";
import { cn } from "@/lib/utils";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { validateFileObj as validateFile, sanitizeFileName, FILE_UPLOAD_HELP_TEXT } from "@/lib/fileUploadValidation";
import { useI18n } from "@/hooks/use-i18n";
import { AddStudentModal } from "@/components/agent/AddStudentModal";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

async function apiFetch(url: string, opts?: RequestInit) {
  const r = await fetch(url, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (r.status === 204) return undefined;
  return r.json();
}

const STATUS_COLORS_DEFAULT: Record<string, string> = {
  active: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60",
  inactive: "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50",
  graduated: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
  suspended: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60",
};

const STU_STAGE_COLORS = [
  "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60",
  "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50",
  "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",
  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",
  "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60",
  "bg-cyan-100 text-cyan-700 border-cyan-200 dark:bg-cyan-900/40 dark:text-cyan-300 dark:border-cyan-700/60",
];
const STU_WON_COLOR = "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60";
const STU_LOST_COLOR = "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700/60";

function getStuStageColor(stage: PipelineStage, index: number): string {
  if (stage.variant === "won") return STU_WON_COLOR;
  if (stage.variant === "lost") return STU_LOST_COLOR;
  return STU_STAGE_COLORS[index % STU_STAGE_COLORS.length];
}

const EMPTY_FORM = {
  firstName: "", lastName: "", email: "", phone: "", phoneCode: "",
  nationality: "", dateOfBirth: "", gender: "",
  passportNumber: "", passportIssueDate: "", passportExpiry: "",
  motherName: "", fatherName: "", address: "",
  highSchool: "", graduationYear: "", gpa: "", gradingSystem: "4",
  universityBachelor: "", universityMaster: "",
  languageScore: "",
  notes: "",
};

const GRADING_SYSTEMS = [
  { value: "4", label: "Out of 4", placeholder: "e.g. 3.8", max: 4 },
  { value: "5", label: "Out of 5", placeholder: "e.g. 4.5", max: 5 },
  { value: "10", label: "Out of 10", placeholder: "e.g. 8.5", max: 10 },
  { value: "12", label: "Out of 12", placeholder: "e.g. 10", max: 12 },
  { value: "20", label: "Out of 20", placeholder: "e.g. 16.5", max: 20 },
  { value: "100", label: "Out of 100", placeholder: "e.g. 85", max: 100 },
];

type LevelDoc = { key: string; label: string; icon: string; accept: string; required: boolean; note?: string };
type AppLevel = "pathway" | "undergraduate" | "graduate" | "doctorate";

const LEVELS: { key: AppLevel; label: string; badge: string; color: string; dbLevel: string }[] = [
  { key: "pathway",       label: "Language / Prep",     badge: "Pathway",       color: "bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-700/60",      dbLevel: "Associate" },
  { key: "undergraduate", label: "Bachelor / Associate", badge: "Undergraduate", color: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60",      dbLevel: "Bachelor" },
  { key: "graduate",      label: "Master's Degree",     badge: "Graduate",      color: "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-700/60", dbLevel: "Master" },
  { key: "doctorate",     label: "Doctorate (PhD)",     badge: "Doctorate",     color: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60",    dbLevel: "Ph.D" },
];

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

type UploadedDoc = {
  key: string;
  label: string;
  file: File;
  mediaType: string;
  isImage: boolean;
};

type ExtractedData = {
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  nationality?: string | null;
  passportNumber?: string | null;
  passportIssueDate?: string | null;
  passportExpiry?: string | null;
  motherName?: string | null;
  fatherName?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  highSchool?: string | null;
  graduationYear?: number | null;
  gpa?: string | null;
  languageScore?: string | null;
  confidence?: string;
  extractedNotes?: string | null;
};

const PHONE_CODES = [
  { code: "+90", country: "TR" },
  { code: "+1", country: "US" },
  { code: "+44", country: "GB" },
  { code: "+49", country: "DE" },
  { code: "+33", country: "FR" },
  { code: "+39", country: "IT" },
  { code: "+34", country: "ES" },
  { code: "+31", country: "NL" },
  { code: "+46", country: "SE" },
  { code: "+47", country: "NO" },
  { code: "+45", country: "DK" },
  { code: "+41", country: "CH" },
  { code: "+43", country: "AT" },
  { code: "+48", country: "PL" },
  { code: "+7", country: "RU" },
  { code: "+380", country: "UA" },
  { code: "+86", country: "CN" },
  { code: "+81", country: "JP" },
  { code: "+82", country: "KR" },
  { code: "+91", country: "IN" },
  { code: "+92", country: "PK" },
  { code: "+93", country: "AF" },
  { code: "+966", country: "SA" },
  { code: "+971", country: "AE" },
  { code: "+964", country: "IQ" },
  { code: "+98", country: "IR" },
  { code: "+962", country: "JO" },
  { code: "+961", country: "LB" },
  { code: "+20", country: "EG" },
  { code: "+212", country: "MA" },
  { code: "+234", country: "NG" },
  { code: "+27", country: "ZA" },
  { code: "+55", country: "BR" },
  { code: "+52", country: "MX" },
  { code: "+54", country: "AR" },
  { code: "+61", country: "AU" },
  { code: "+64", country: "NZ" },
  { code: "+60", country: "MY" },
  { code: "+65", country: "SG" },
  { code: "+63", country: "PH" },
  { code: "+66", country: "TH" },
  { code: "+84", country: "VN" },
  { code: "+62", country: "ID" },
  { code: "+994", country: "AZ" },
  { code: "+995", country: "GE" },
  { code: "+998", country: "UZ" },
  { code: "+996", country: "KG" },
  { code: "+993", country: "TM" },
  { code: "+77", country: "KZ" },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
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
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error("compress failed")); return; }
          const newName = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          resolve(new File([blob], newName, { type: "image/jpeg" }));
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
  if (isImage) {
    const compressed = await compressImage(file);
    return { file: compressed, mediaType: "image/jpeg", isImage: true };
  }
  return { file, mediaType: file.type || "application/pdf", isImage: false };
}

function DropZone({
  docType,
  uploaded,
  onUpload,
  onRemove,
}: {
  docType: LevelDoc;
  uploaded?: UploadedDoc;
  onUpload: (doc: UploadedDoc) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { toast } = useToast();

  async function handleFile(file: File) {
    const validation = validateFile(file);
    if (!validation.valid) {
      toast({ title: "Dosya hatas\u0131", description: validation.message, variant: "destructive" });
      return;
    }
    const safeFile = new File([file], sanitizeFileName(file.name), { type: file.type });
    const { file: prepared, mediaType, isImage } = await prepareDocumentFile(safeFile);
    onUpload({ key: docType.key, label: docType.label, file: prepared, mediaType, isImage });
  }

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    []
  );

  const requiredBadge = docType.required
    ? <span className="text-[10px] bg-rose-100 text-rose-600 px-1.5 py-0.5 rounded-full font-semibold border border-rose-200 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/60">Required</span>
    : <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full font-medium border border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50">Optional</span>;

  if (uploaded) {
    return (
      <>
      <div className="relative flex flex-col items-center gap-1.5 p-3 border-2 border-green-300 bg-green-50 rounded-2xl text-center min-h-[120px] justify-center">
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-2 right-2 w-5 h-5 bg-destructive/10 hover:bg-destructive/20 text-destructive rounded-full flex items-center justify-center"
        >
          <X className="w-3 h-3" />
        </button>
        <CheckCircle2 className="w-6 h-6 text-green-500" />
        <div>
          <p className="text-xs font-semibold text-foreground truncate max-w-[90px]">{uploaded.file.name}</p>
          <p className="text-xs text-muted-foreground">{Math.round(uploaded.file.size / 1024)}KB</p>
        </div>
        <span className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">{docType.label}</span>
      </div>
      </>
    );
  }

  return (
    <>
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
      <input
        ref={inputRef}
        type="file"
        accept={docType.accept}
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
      />
    </div>
    </>
  );
}

function AiBadge() {
  return <span className="ml-1.5 text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium dark:bg-emerald-900/40 dark:text-emerald-300">AI ✓</span>;
}

function FormField({
  label, value, onChange, placeholder, type = "text", aiExtracted, required, latinUppercase,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string; aiExtracted?: boolean; required?: boolean; latinUppercase?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let v = e.target.value;
    if (latinUppercase) {
      v = v.toUpperCase().replace(/[^A-ZÀ-ÖØ-Þ\s'-]/g, "");
    }
    onChange(v);
  };
  return (
    <>
    <div className="space-y-1.5">
      <Label className="font-semibold text-sm flex items-center">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
        {aiExtracted && <AiBadge />}
      </Label>
      <Input
        type={type}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        className={cn(
          "rounded-xl",
          latinUppercase && "uppercase",
          aiExtracted && "border-emerald-300 bg-emerald-50/40 focus-visible:ring-emerald-400"
        )}
      />
    </div>
    </>
  );
}

type Step = "upload" | "analyzing" | "review";

function NationalityCombobox({ value, onChange, countries, aiExtracted }: { value: string; onChange: (v: string) => void; countries: Array<{ id: number; name: string; code?: string }>; aiExtracted?: boolean }) {
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
        className="h-9 text-sm"
        autoComplete="off"
      />
      {open && (
        <div className="absolute z-[9999] mt-1 w-full bg-popover border rounded-md shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 && <div className="p-3 text-sm text-muted-foreground text-center">{searchVal ? "No match — custom value OK" : "No countries loaded"}</div>}
          {filtered.map(c => (
            <button key={c.id} type="button" className={`w-full text-left px-3 py-2 text-sm hover:bg-secondary/70 transition-colors flex items-center gap-2 ${c.name === value ? "bg-primary/10 font-medium" : ""}`}
              onMouseDown={e => { e.preventDefault(); onChange(c.name); setSearchVal(""); setOpen(false); }}>
              <CountryFlag code={c.code || ""} size="sm" />
              {c.name}
            </button>
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function _AddStudentModalInline_REMOVED({
  open,
  onClose,
  onSuccess,
  defaultStatus,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultStatus?: string;
}) {
  const { toast } = useToast();
  const createStudent = useCreateStudent();
  const { season } = useSeason();

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
  const [applicationLevel, setApplicationLevel] = useState<AppLevel>("undergraduate");

  // Degree-level requirements have been retired — at the new-student
  // intake step a program isn't selected yet, so we show a generic list
  // of all known doc types for upload (none are marked required here;
  // mandatory enforcement now lives on the per-application program
  // requirements).
  const currentDocs = useMemo<LevelDoc[]>(() => {
    return Object.entries(DOC_TYPE_META).map(([key, meta]) => ({
      key,
      label: meta.label,
      icon: meta.icon,
      accept: meta.accept,
      required: false,
    }));
  }, []);

  function handleClose() {
    setStep("upload");
    setDocs({});
    setExtractedFields(new Set());
    setForm(EMPTY_FORM);
    setAnalysisError(null);
    setApplicationLevel("undergraduate");
    onClose();
  }

  function field(name: keyof typeof EMPTY_FORM) {
    return (value: string) => setForm((f) => ({ ...f, [name]: value }));
  }

  async function analyzeDocuments() {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) {
      toast({ title: "Upload at least one document", variant: "destructive" });
      return;
    }

    setStep("analyzing");
    setAnalysisError(null);

    try {
      const docPayload = await Promise.all(uploadedDocs.map(async (d) => ({
        type: d.isImage ? "image" : "pdf",
        data: await fileToBase64(d.file),
        mediaType: d.mediaType,
        label: d.label,
      })));

      const res = await fetch(`${BASE_URL}/api/ai/extract-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ documents: docPayload, scope: "agent" }),
      });

      if (!res.ok) {
        if (res.status === 413) {
          throw new Error("Documents are too large even after compression. Please use smaller files (max ~10MB total).");
        }
        const err = await res.json().catch(() => ({ error: "AI extraction failed" }));
        throw new Error(err.error || "AI extraction failed");
      }

      const { extracted, warnings: serverWarnings }: { extracted: ExtractedData; warnings?: string[] } = await res.json();

      if ((extracted as any).passportExpired === true) {
        setAnalysisError(`Passport has expired (${extracted.passportExpiry}). Expired passports cannot be used for applications. Please upload a valid passport.`);
        setStep("review");
        return;
      }

      if (serverWarnings?.length) {
        setAnalysisError(serverWarnings.join(" "));
      }

      // Preserve any fields the user already filled in manually before
      // clicking "Analyze" — only AI-extracted fields should be overwritten.
      const newForm = { ...form };
      const newExtracted = new Set<string>();

      const mapping: [keyof typeof EMPTY_FORM, keyof ExtractedData][] = [
        ["firstName", "firstName"], ["lastName", "lastName"],
        ["email", "email"], ["phone", "phone"],
        ["nationality", "nationality"], ["dateOfBirth", "dateOfBirth"],
        ["passportNumber", "passportNumber"], ["passportIssueDate", "passportIssueDate"],
        ["passportExpiry", "passportExpiry"],
        ["motherName", "motherName"], ["fatherName", "fatherName"],
        ["address", "address"], ["highSchool", "highSchool"],
        ["gpa", "gpa"], ["languageScore", "languageScore"],
      ];

      for (const [fk, ek] of mapping) {
        const val = extracted[ek];
        if (val !== null && val !== undefined && val !== "") {
          if (fk === "phone") {
            const phoneStr = String(val).replace(/\s+/g, " ").trim();
            if (phoneStr.startsWith("+")) {
              const sortedCodes = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
              const matched = sortedCodes.find(pc => phoneStr.startsWith(pc.code));
              if (matched) {
                newForm.phoneCode = matched.code;
                newForm.phone = phoneStr.slice(matched.code.length).trim();
              } else {
                newForm.phone = phoneStr;
              }
            } else {
              newForm.phone = phoneStr;
            }
            newExtracted.add("phone");
          } else if (fk === "nationality") {
            const natVal = String(val).trim();
            const lower = natVal.toLowerCase();
            const exactMatch = allCountries.find(c => c.name.toLowerCase() === lower);
            if (exactMatch) {
              newForm.nationality = exactMatch.name;
            } else {
              const DEMONYM_MAP: Record<string, string> = {
                "afghan": "Afghanistan", "turkish": "Turkey", "iranian": "Iran",
                "pakistani": "Pakistan", "indian": "India", "iraqi": "Iraq",
                "syrian": "Syria", "jordanian": "Jordan", "lebanese": "Lebanon",
                "palestinian": "Palestine", "egyptian": "Egypt", "moroccan": "Morocco",
                "algerian": "Algeria", "tunisian": "Tunisia", "libyan": "Libya",
                "sudanese": "Sudan", "somali": "Somalia", "nigerian": "Nigeria",
                "ethiopian": "Ethiopia", "kenyan": "Kenya", "ghanaian": "Ghana",
                "british": "United Kingdom", "american": "United States", "canadian": "Canada",
                "french": "France", "german": "Germany", "dutch": "Netherlands",
                "swedish": "Sweden", "italian": "Italy", "spanish": "Spain",
                "polish": "Poland", "hungarian": "Hungary", "czech": "Czech Republic",
                "romanian": "Romania", "ukrainian": "Ukraine", "russian": "Russia",
                "australian": "Australia", "chinese": "China", "japanese": "Japan",
                "korean": "South Korea", "malaysian": "Malaysia", "singaporean": "Singapore",
                "bangladeshi": "Bangladesh", "azerbaijani": "Azerbaijan",
                "kazakh": "Kazakhstan", "uzbek": "Uzbekistan", "kyrgyz": "Kyrgyzstan",
                "tajik": "Tajikistan", "turkmen": "Turkmenistan",
                "saudi": "Saudi Arabia", "emirati": "UAE", "qatari": "Qatar",
                "kuwaiti": "Kuwait", "yemeni": "Yemen",
                "afg": "Afghanistan", "tur": "Turkey", "irn": "Iran", "pak": "Pakistan",
                "ind": "India", "irq": "Iraq", "syr": "Syria",
              };
              const mapped = DEMONYM_MAP[lower];
              if (mapped) {
                const countryMatch = allCountries.find(c => c.name.toLowerCase() === mapped.toLowerCase());
                newForm.nationality = countryMatch ? countryMatch.name : mapped;
              } else {
                const codeMatch = allCountries.find(c => c.code?.toLowerCase() === lower);
                if (codeMatch) {
                  newForm.nationality = codeMatch.name;
                } else {
                  newForm.nationality = natVal;
                }
              }
            }
            newExtracted.add("nationality");
          } else if (fk === "gpa") {
            // Server-side AI extract already normalizes any source scale
            // (4.0/5/10/20/raw %) into a 0-100 percent string, so we just
            // lock the grading system to /100 and use the value as-is.
            const gpaStr = String(val).trim();
            const isPct = (extracted as any).gpaScale === 100 || (extracted as any).gpaScale === "100";
            if (isPct || /^\d+(\.\d+)?$/.test(gpaStr)) {
              newForm.gpa = gpaStr;
              newForm.gradingSystem = "100";
            } else {
              const gpaMatch = gpaStr.match(/^([\d.]+)\s*\/\s*(\d+)$/);
              if (gpaMatch) {
                newForm.gpa = gpaMatch[1];
                const matchedSystem = GRADING_SYSTEMS.find(g => g.value === gpaMatch[2]);
                if (matchedSystem) newForm.gradingSystem = matchedSystem.value;
              } else {
                newForm.gpa = gpaStr;
              }
            }
            newExtracted.add("gpa");
          } else {
            (newForm as any)[fk] = String(val);
            newExtracted.add(fk);
          }
        }
      }
      if (extracted.graduationYear != null) {
        newForm.graduationYear = String(extracted.graduationYear);
        newExtracted.add("graduationYear");
      }

      setForm(newForm);
      setExtractedFields(newExtracted);
      setStep("review");
    } catch (err: any) {
      setAnalysisError(err.message || "AI extraction failed");
      setStep("review");
    }
  }

  async function saveDocumentsForStudent(studentId: number, firstName: string, lastName: string) {
    const uploadedDocs = Object.values(docs);
    if (uploadedDocs.length === 0) return;

    const docTypeLabel: Record<string, string> = {
      passport: "Passport",
      diploma: "Diploma",
      transcript: "Transcript",
      photo: "Photo",
      other: "Other",
    };

    await Promise.allSettled(
      uploadedDocs.map(async (d) => {
        const label = docTypeLabel[d.label?.toLowerCase()] ?? d.label ?? "Document";
        const docName = `${firstName}-${lastName}-${label}`;
        try {
          const { fileKey, mimeType, sizeBytes } = await uploadDocumentFile(d.file);
          return createDocumentRecord({
            name: docName,
            type: d.label?.toLowerCase() ?? "other",
            status: "pending",
            studentId,
            fileKey,
            mimeType,
            sizeBytes,
            originalFileName: d.file?.name ?? null,
          });
        } catch (err) {
          console.error(`[AGENT_STUDENTS] upload failed for ${label}:`, err);
          return null;
        }
      })
    );
  }

  function handleSubmit() {
    const missing: string[] = [];
    if (!form.firstName.trim()) missing.push("First Name");
    if (!form.lastName.trim()) missing.push("Last Name");
    if (!form.email.trim()) missing.push("Email");
    if (!form.phone.trim()) missing.push("Phone");
    if (!form.dateOfBirth.trim()) missing.push("Date of Birth");
    if (!form.gender.trim()) missing.push("Gender");
    if (!form.nationality.trim()) missing.push("Nationality");
    if (!form.motherName.trim()) missing.push("Mother's Name");
    if (!form.fatherName.trim()) missing.push("Father's Name");
    if (!form.passportNumber.trim()) missing.push("Passport Number");
    if (!form.passportIssueDate.trim()) missing.push("Issue Date");
    if (!form.passportExpiry.trim()) missing.push("Expiry Date");
    if (missing.length > 0) {
      toast({ title: "Required fields missing", description: missing.join(", "), variant: "destructive" });
      return;
    }

    const missingDocs = currentDocs.filter(dt => dt.required && !docs[dt.key]).map(dt => dt.label);
    if (missingDocs.length > 0) {
      toast({ title: "Required documents missing", description: missingDocs.join(", "), variant: "destructive" });
      return;
    }

    const fullPhone = form.phone ? `${form.phoneCode} ${form.phone}` : null;

    createStudent.mutate(
      {
        data: {
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email || null,
          phone: fullPhone,
          nationality: form.nationality || null,
          dateOfBirth: form.dateOfBirth || null,
          gender: form.gender || null,
          passportNumber: form.passportNumber || null,
          passportIssueDate: form.passportIssueDate || null,
          passportExpiry: form.passportExpiry || null,
          motherName: form.motherName || null,
          fatherName: form.fatherName || null,
          address: form.address || null,
          highSchool: form.highSchool || null,
          graduationYear: form.graduationYear ? parseInt(form.graduationYear, 10) : null,
          gpa: form.gpa ? `${form.gpa} / ${form.gradingSystem}` : null,
          languageScore: form.languageScore || null,
          notes: form.notes || null,
          status: defaultStatus || "active",
        } as any,
      },
      {
        onSuccess: async (createdStudent: any) => {
          const docCount = Object.keys(docs).length;
          if (docCount > 0) {
            await saveDocumentsForStudent(createdStudent.id, form.firstName, form.lastName);
            toast({ title: "Student created", description: `${docCount} document${docCount !== 1 ? "s" : ""} added to profile.` });
          } else {
            toast({ title: "Student created successfully" });
          }
          handleClose();
          onSuccess();
        },
        onError: (err: any) => {
          toast({ title: "Failed to create student", description: err?.message, variant: "destructive" });
        },
      }
    );
  }

  const uploadedCount = Object.keys(docs).length;
  const stepProgress = step === "upload" ? 33 : step === "analyzing" ? 66 : 100;
  const ef = extractedFields;

  return (
    <>
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
              {[
                { id: "upload", label: "1. Upload Documents" },
                { id: "analyzing", label: "2. AI Analysis" },
                { id: "review", label: "3. Review & Save" },
              ].map((s) => (
                <span
                  key={s.id}
                  className={cn(step === s.id ? "text-primary" : "text-muted-foreground")}
                >
                  {s.label}
                </span>
              ))}
            </div>
          </div>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 py-5">
          {step === "upload" && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Application Level</p>
                <div className="grid grid-cols-4 gap-2">
                  {LEVELS.map(lv => (
                    <button
                      key={lv.key}
                      type="button"
                      onClick={() => setApplicationLevel(lv.key)}
                      className={cn(
                        "rounded-xl border-2 px-3 py-2.5 text-center transition-all",
                        applicationLevel === lv.key
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-border hover:border-primary/40 hover:bg-secondary/40"
                      )}
                    >
                      <span className={cn("text-[11px] font-bold px-1.5 py-0.5 rounded-md border", lv.color)}>{lv.badge}</span>
                      <p className="text-xs text-foreground font-medium mt-1.5 leading-tight">{lv.label}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-gradient-to-br from-violet-50 to-blue-50 border border-violet-100 rounded-2xl p-3 flex items-start gap-3">
                <Sparkles className="w-4 h-4 text-violet-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">AI Auto-Fill</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Upload documents — AI will read and fill the form. <span className="font-medium text-rose-600">Required</span> documents take priority.
                  </p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold text-foreground">Required Documents</p>
                  <p className="text-xs text-muted-foreground">
                    {uploadedCount}/{currentDocs.length} uploaded
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground mb-2">{FILE_UPLOAD_HELP_TEXT}</p>
                <div className={cn(
                  "grid gap-2",
                  currentDocs.length <= 5 ? "grid-cols-5" : currentDocs.length <= 7 ? "grid-cols-4" : "grid-cols-3"
                )}>
                  {currentDocs.map((dt) => (
                    <DropZone
                      key={dt.key}
                      docType={dt}
                      uploaded={docs[dt.key]}
                      onUpload={(doc) => setDocs((d) => ({ ...d, [dt.key]: doc }))}
                      onRemove={() => setDocs((d) => { const n = { ...d }; delete n[dt.key]; return n; })}
                    />
                  ))}
                </div>
              </div>

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-xs text-amber-700">
                  No documents? Use <strong>"Skip to Form"</strong> to fill the form manually.
                </p>
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
                <p className="text-sm text-muted-foreground">
                  Extracting information from {uploadedCount} document{uploadedCount !== 1 ? "s" : ""}
                </p>
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
                  <p className="text-xs text-rose-700 dark:text-rose-300">
                    AI could not read the documents: {analysisError}. Please fill the form manually.
                  </p>
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
                    <Label className="font-semibold text-sm flex items-center">
                      Phone<span className="text-destructive ml-0.5">*</span>
                      {ef.has("phone") && <AiBadge />}
                    </Label>
                    <div className="flex gap-1.5">
                      <PhoneCodePicker value={form.phoneCode} onChange={field("phoneCode")} triggerClassName="w-[100px] h-9 text-sm rounded-xl shrink-0" />
                      <Input
                        value={form.phone}
                        onChange={(e) => setForm(f => ({ ...f, phone: e.target.value }))}
                        placeholder="555 000 0000"
                        className={cn(
                          "rounded-xl flex-1",
                          ef.has("phone") && "border-emerald-300 bg-emerald-50/40 focus-visible:ring-emerald-400"
                        )}
                      />
                    </div>
                  </div>
                  <FormField required label="Date of Birth" value={form.dateOfBirth} onChange={field("dateOfBirth")} type="date" aiExtracted={ef.has("dateOfBirth")} />
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">Gender<span className="text-destructive ml-0.5">*</span></Label>
                    <select
                      value={form.gender}
                      onChange={(e) => field("gender")(e.target.value)}
                      className="mt-1 flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="">Select…</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs font-medium text-muted-foreground flex items-center gap-1">Nationality<span className="text-destructive ml-0.5">*</span>{ef.has("nationality") && <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-medium dark:bg-emerald-900/40 dark:text-emerald-300">AI ✓</span>}</Label>
                    <div className="mt-1">
                      <NationalityCombobox value={form.nationality} onChange={field("nationality")} countries={allCountries} />
                    </div>
                  </div>
                  <FormField required label="Mother's Name" value={form.motherName} onChange={field("motherName")} placeholder="Mother's name" aiExtracted={ef.has("motherName")} latinUppercase />
                  <FormField required label="Father's Name" value={form.fatherName} onChange={field("fatherName")} placeholder="Father's name" aiExtracted={ef.has("fatherName")} latinUppercase />
                  <div className="col-span-2">
                    <FormField label="Address" value={form.address} onChange={field("address")} placeholder="Full home address" aiExtracted={ef.has("address")} />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <span className="text-base leading-none">{"\u{1F6C2}"}</span>
                  <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Passport / Identity</h3>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="col-span-2">
                    <FormField required label="Passport Number" value={form.passportNumber} onChange={field("passportNumber")} placeholder="e.g. AB1234567" aiExtracted={ef.has("passportNumber")} />
                  </div>
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
                  <div className="col-span-2">
                    <FormField label="High School" value={form.highSchool} onChange={field("highSchool")} placeholder="e.g. Ankara Fen Lisesi" aiExtracted={ef.has("highSchool")} />
                  </div>
                  {(applicationLevel === "graduate" || applicationLevel === "doctorate") && (
                    <div className="col-span-2">
                      <FormField label="University (Bachelor)" value={form.universityBachelor} onChange={field("universityBachelor")} placeholder="e.g. Istanbul University" aiExtracted={ef.has("universityBachelor")} />
                    </div>
                  )}
                  {applicationLevel === "doctorate" && (
                    <div className="col-span-2">
                      <FormField label="University (Master)" value={form.universityMaster} onChange={field("universityMaster")} placeholder="e.g. Bogazici University" aiExtracted={ef.has("universityMaster")} />
                    </div>
                  )}
                  <FormField label="Graduation Year" value={form.graduationYear} onChange={field("graduationYear")} placeholder="e.g. 2022" aiExtracted={ef.has("graduationYear")} />
                  <div className="space-y-1.5">
                    <Label className="font-semibold text-sm flex items-center">
                      GPA{ef.has("gpa") && <AiBadge />}
                    </Label>
                    <div className="flex gap-1.5">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.max ?? 4}
                        value={form.gpa}
                        onChange={(e) => setForm(f => ({ ...f, gpa: e.target.value }))}
                        placeholder={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.placeholder ?? "e.g. 3.8"}
                        className={cn(
                          "rounded-xl flex-1",
                          ef.has("gpa") && "border-emerald-300 bg-emerald-50/40 focus-visible:ring-emerald-400"
                        )}
                      />
                      <Select value={form.gradingSystem} onValueChange={(v) => setForm(f => ({ ...f, gradingSystem: v, gpa: "" }))}>
                        <SelectTrigger className="w-[110px] h-9 text-sm rounded-xl shrink-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GRADING_SYSTEMS.map(gs => (
                            <SelectItem key={gs.value} value={gs.value}>
                              / {gs.value}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="col-span-2">
                    <FormField label="Language Score" value={form.languageScore} onChange={field("languageScore")} placeholder="e.g. IELTS 7.0, TOEFL 100" aiExtracted={ef.has("languageScore")} />
                  </div>
                </div>
              </section>

              <section className="space-y-4">
                <div className="flex items-center gap-2 border-b border-border/50 pb-2">
                  <FileUp className="w-4 h-4 text-primary" />
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wide">Documents</h3>
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    {Object.keys(docs).length}/{currentDocs.length} uploaded
                  </p>
                </div>
                <p className="text-[11px] text-muted-foreground mb-1">{FILE_UPLOAD_HELP_TEXT}</p>
                <div className={cn(
                  "grid gap-2",
                  currentDocs.length <= 5 ? "grid-cols-5" : currentDocs.length <= 7 ? "grid-cols-4" : "grid-cols-3"
                )}>
                  {currentDocs.map((dt) => (
                    <DropZone
                      key={dt.key}
                      docType={dt}
                      uploaded={docs[dt.key]}
                      onUpload={(doc) => setDocs((d) => ({ ...d, [dt.key]: doc }))}
                      onRemove={() => setDocs((d) => { const n = { ...d }; delete n[dt.key]; return n; })}
                    />
                  ))}
                </div>
              </section>

              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Notes</Label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  placeholder="Any additional notes about this student…"
                  rows={2}
                  className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 pb-5 pt-3 border-t border-border/50 flex items-center justify-between shrink-0 gap-3">
          {step === "upload" && (
            <>
              <Button variant="ghost" onClick={handleClose} className="rounded-xl">Cancel</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("review")} className="rounded-xl text-muted-foreground">
                  Skip to Form
                </Button>
                <Button
                  onClick={analyzeDocuments}
                  disabled={uploadedCount === 0}
                  className="rounded-xl gap-2 bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white border-0"
                >
                  <Sparkles className="w-4 h-4" />
                  Analyze {uploadedCount > 0 ? `${uploadedCount} Doc${uploadedCount !== 1 ? "s" : ""}` : "Documents"}
                </Button>
              </div>
            </>
          )}

          {step === "analyzing" && (
            <div className="w-full flex justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          )}

          {step === "review" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} className="rounded-xl gap-2">
                <ChevronLeft className="w-4 h-4" /> Back
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={createStudent.isPending || !form.firstName.trim() || !form.lastName.trim() || !form.email.trim() || !form.phone.trim() || !form.dateOfBirth.trim() || !form.nationality.trim() || !form.motherName.trim() || !form.fatherName.trim() || !form.passportNumber.trim() || !form.passportIssueDate.trim() || !form.passportExpiry.trim()}
                className="rounded-xl gap-2"
              >
                {createStudent.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Create Student
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}


const VIEW_KEY_STU = "edcons_students_view";

type StuSortKey = "name" | "email" | "nationality" | "status" | "passport" | "date";
type StuSortDir = "asc" | "desc";

function StuSortHeader({ label, sortKey, currentSort, onSort }: {
  label: string; sortKey: StuSortKey; currentSort: { key: StuSortKey; dir: StuSortDir }; onSort: (k: StuSortKey) => void;
}) {
  const active = currentSort.key === sortKey;
  return (
    <>
    <TableHead className="cursor-pointer select-none hover:bg-muted/50 transition-colors" onClick={() => onSort(sortKey)}>
      <div className="flex items-center gap-1">
        {label}
        {active ? (currentSort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 text-muted-foreground/50" />}
      </div>
    </TableHead>
    </>
  );
}

type StuColVariant = "won" | "lost" | undefined;

function StudentAvatar({ student, size = "sm" }: { student: any; size?: "sm" | "md" }) {
  const dim = size === "md" ? "w-10 h-10" : "w-8 h-8";
  const textSize = size === "md" ? "text-sm" : "text-xs";
  const [imgError, setImgError] = useState(false);

  if (student.hasPhoto && !imgError) {
    return (
      <>
      <img
        src={student.photoUrl || `/api/students/${student.id}/photo/thumbnail`}
        alt={`${student.firstName} ${student.lastName}`}
        className={`${dim} rounded-full object-cover border border-primary/20 shrink-0`}
        onError={() => setImgError(true)}
      />
      </>
    );
  }
  return (
    <>
    <div className={`${dim} rounded-full bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shrink-0`}>
      <span className={`${textSize} font-bold text-primary`}>{student.firstName?.[0]}{student.lastName?.[0]}</span>
    </div>
    </>
  );
}

function DraggableStudentCard({ student, onView, variant }: { student: any; onView: (id: number) => void; variant?: StuColVariant }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: student.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const cardBg =
    variant === "won" ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/50 dark:hover:border-emerald-600" :
    variant === "lost" ? "bg-rose-50 border-rose-200 hover:border-rose-300 dark:bg-rose-900/20 dark:border-rose-700/50 dark:hover:border-rose-600" :
    "bg-card border-border hover:shadow-md";

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border ${isDragging ? "border-primary shadow-xl opacity-50 z-50 relative" : cardBg} mb-3 transition-shadow duration-200`}
    >
      <div {...attributes} {...listeners} className={`p-4 pb-2 ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}>
        <div className="flex items-center gap-2.5 mb-1.5">
          <StudentAvatar student={student} />
          <div className="min-w-0">
            <h4 className="font-bold text-sm text-foreground line-clamp-1">{student.firstName} {student.lastName}</h4>
            <p className="text-xs text-muted-foreground truncate">{student.email || student.phone || "No contact"}</p>
          </div>
        </div>
        {student.nationality && <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">{student.nationality}</span>}
      </div>
      <div className="px-4 pb-3 flex justify-end">
        <button
          onClick={() => onView(student.id)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors"
        >
          <Eye className="w-3 h-3" /> View
        </button>
      </div>
    </div>
    </>
  );
}

function DroppableStuColumn({ status, label, variant, students, onView }: { status: string; label: string; variant?: string | null; students: any[]; onView: (id: number) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const v = variant as StuColVariant;

  const colBg = v === "won" ? "bg-emerald-50/60 border-emerald-200/50 dark:bg-emerald-900/15 dark:border-emerald-700/30" : v === "lost" ? "bg-rose-50/60 border-rose-200/50 dark:bg-rose-900/15 dark:border-rose-700/30" : "bg-secondary/50 border-border/50";
  const headerBg = v === "won" ? "bg-emerald-100/80 border-emerald-200/70 dark:bg-emerald-900/30 dark:border-emerald-700/40" : v === "lost" ? "bg-rose-100/80 border-rose-200/70 dark:bg-rose-900/30 dark:border-rose-700/40" : "bg-card/50 border-border/50";
  const badgeBg = v === "won" ? "bg-emerald-200/60 text-emerald-800 border-emerald-300/50 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700/40" : v === "lost" ? "bg-rose-200/60 text-rose-800 border-rose-300/50 dark:bg-rose-900/40 dark:text-rose-300 dark:border-rose-700/40" : "bg-background text-muted-foreground border shadow-sm";

  const dropBg =
    v === "won" ? (isOver ? "bg-emerald-100/60 dark:bg-emerald-900/25" : "") :
    v === "lost" ? (isOver ? "bg-rose-100/60 dark:bg-rose-900/25" : "") :
    (isOver ? "bg-primary/5" : "");

  const emptyBorder =
    v === "won" ? "border-emerald-300/50 text-emerald-500" :
    v === "lost" ? "border-rose-300/50 text-rose-400" :
    "border-border/50 text-muted-foreground";

  const icon =
    v === "won" ? <Trophy className="w-4 h-4 text-emerald-500 shrink-0" /> :
    v === "lost" ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" /> :
    null;

  return (
    <>
    <div className={`w-72 flex flex-col max-h-full rounded-2xl border overflow-hidden ${colBg}`}>
      <div className={`p-4 border-b shrink-0 ${headerBg}`}>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            {icon}
            <h3 className={`font-display font-bold text-sm ${v === "won" ? "text-emerald-800" : v === "lost" ? "text-rose-700" : "text-foreground"}`}>{label}</h3>
          </div>
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border ${badgeBg}`}>{students.length}</span>
        </div>
      </div>
      <div ref={setNodeRef} className={`p-3 flex-1 overflow-y-auto custom-scrollbar transition-colors duration-150 ${dropBg}`}>
        <SortableContext items={students.map(s => s.id)} strategy={verticalListSortingStrategy}>
          {students.map((s: any) => (
            <DraggableStudentCard key={s.id} student={s} onView={onView} variant={v} />
          ))}
          {students.length === 0 && (
            <div className={`h-20 border-2 border-dashed rounded-xl flex items-center justify-center text-sm font-medium ${emptyBorder}`}>Drop here</div>
          )}
        </SortableContext>
      </div>
    </div>
    </>
  );
}

function EditStudentDialog({ open, onClose, student, stages }: { open: boolean; onClose: () => void; student: any; stages: PipelineStage[] }) {
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "", phoneCode: "",
    nationality: "", status: "active", dateOfBirth: "", gender: "",
    passportNumber: "", passportIssueDate: "", passportExpiry: "",
    motherName: "", fatherName: "", address: "",
    highSchool: "", graduationYear: "", gpa: "", gradingSystem: "4",
    universityBachelor: "", universityMaster: "",
    languageScore: "", notes: "",
  });
  const [saving, setSaving] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: countriesResp } = useQuery({
    queryKey: ["all-countries-nationality"],
    queryFn: () => fetch(`${BASE_URL}/api/countries?limit=500`, { credentials: "include" }).then(r => r.json()),
    staleTime: 5 * 60_000,
  });
  const allCountries: Array<{ id: number; name: string; code?: string; flagEmoji?: string | null }> = countriesResp?.data ?? [];

  useEffect(() => {
    if (open && student) {
      let phoneCode = "";
      let phoneNum = student.phone || "";
      if (phoneNum.startsWith("+")) {
        const sortedCodes = [...PHONE_CODES].sort((a, b) => b.code.length - a.code.length);
        const matched = sortedCodes.find(pc => phoneNum.startsWith(pc.code));
        if (matched) {
          phoneCode = matched.code;
          phoneNum = phoneNum.slice(matched.code.length).trim();
        }
      }
      const gpaRaw = student.gpa || "";
      let gpaVal = gpaRaw;
      let gradingSys = "4";
      const gpaMatch = gpaRaw.match(/^([\d.]+)\s*\/\s*(\d+)$/);
      if (gpaMatch) {
        gpaVal = gpaMatch[1];
        const ms = GRADING_SYSTEMS.find(g => g.value === gpaMatch[2]);
        if (ms) gradingSys = ms.value;
      }
      setForm({
        firstName: student.firstName || "", lastName: student.lastName || "",
        email: student.email || "", phone: phoneNum, phoneCode,
        nationality: student.nationality || "", status: student.status || "active",
        dateOfBirth: student.dateOfBirth || "",
        gender: student.gender || "",
        passportNumber: student.passportNumber || "",
        passportIssueDate: student.passportIssueDate || "",
        passportExpiry: student.passportExpiry || "",
        motherName: student.motherName || "", fatherName: student.fatherName || "",
        address: student.address || "",
        highSchool: student.highSchool || "",
        graduationYear: student.graduationYear?.toString() || "",
        gpa: gpaVal, gradingSystem: gradingSys,
        universityBachelor: student.universityBachelor || "",
        universityMaster: student.universityMaster || "",
        languageScore: student.languageScore || "",
        notes: student.notes || "",
      });
    }
  }, [open, student]);

  function field(name: string) {
    return (val: string) => setForm(f => ({ ...f, [name]: val }));
  }

  async function handleSave() {
    if (!student || !form.firstName || !form.lastName) return;
    setSaving(true);
    try {
      const phone = form.phone ? `${form.phoneCode}${form.phone.replace(/^\s+/, "")}` : "";
      const gpa = form.gpa ? (form.gradingSystem !== "4" ? `${form.gpa}/${form.gradingSystem}` : form.gpa) : "";
      const res = await fetch(`${BASE_URL}/api/students/${student.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName, lastName: form.lastName,
          email: form.email, phone,
          nationality: form.nationality, status: form.status,
          dateOfBirth: form.dateOfBirth,
          gender: form.gender || null,
          passportNumber: form.passportNumber,
          passportIssueDate: form.passportIssueDate,
          passportExpiry: form.passportExpiry,
          motherName: form.motherName, fatherName: form.fatherName,
          address: form.address, highSchool: form.highSchool,
          graduationYear: form.graduationYear ? parseInt(form.graduationYear) : null,
          gpa, universityBachelor: form.universityBachelor,
          universityMaster: form.universityMaster,
          languageScore: form.languageScore, notes: form.notes,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast({ title: "Student updated" });
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to update", variant: "destructive" });
    } finally { setSaving(false); }
  }

  const F = ({ label, value, onChange, type = "text", placeholder = "", required = false, className = "", latinUppercase = false }: {
    label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; required?: boolean; className?: string; latinUppercase?: boolean;
  }) => (
    <div className={cn("space-y-1.5", className)}>
      <Label className="font-semibold text-sm">{label}{required && <span className="text-destructive ml-0.5">*</span>}</Label>
      <Input type={type} value={value} onChange={e => { let v = e.target.value; if (latinUppercase) v = v.toUpperCase().replace(/[^A-ZÀ-ÖØ-Þ\s'-]/g, ""); onChange(v); }} placeholder={placeholder} className={cn("rounded-xl h-9", latinUppercase && "uppercase")} />
    </div>
  );

  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader><DialogTitle>Edit Student</DialogTitle></DialogHeader>
        <div className="overflow-y-auto flex-1 space-y-6 pr-1 py-2">
          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <User className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Personal Information</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F required label="First Name" value={form.firstName} onChange={field("firstName")} placeholder="First name" latinUppercase />
              <F required label="Last Name" value={form.lastName} onChange={field("lastName")} placeholder="Last name" latinUppercase />
              <F label="Email" value={form.email} onChange={field("email")} type="email" placeholder="email@example.com" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Phone</Label>
                <div className="flex gap-1.5">
                  <PhoneCodePicker value={form.phoneCode} onChange={field("phoneCode")} triggerClassName="w-[100px] h-9 text-sm rounded-xl shrink-0" />
                  <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="555 000 0000" className="rounded-xl flex-1 h-9" />
                </div>
              </div>
              <F label="Date of Birth" value={form.dateOfBirth} onChange={field("dateOfBirth")} type="date" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Gender</Label>
                <select
                  value={form.gender}
                  onChange={(e) => field("gender")(e.target.value)}
                  className="flex h-10 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Select…</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Nationality</Label>
                <NationalityCombobox value={form.nationality} onChange={field("nationality")} countries={allCountries} />
              </div>
              <F label="Mother's Name" value={form.motherName} onChange={field("motherName")} placeholder="Mother's name" latinUppercase />
              <F label="Father's Name" value={form.fatherName} onChange={field("fatherName")} placeholder="Father's name" latinUppercase />
              <F label="Address" value={form.address} onChange={field("address")} placeholder="Full home address" className="col-span-2" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Status</Label>
                <Select value={form.status} disabled>
                  <SelectTrigger className="h-9 text-sm rounded-xl opacity-60 cursor-not-allowed"><SelectValue /></SelectTrigger>
                  <SelectContent>{stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">Only admin & staff can change status</p>
              </div>
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <span className="text-base leading-none">{"\u{1F6C2}"}</span>
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Passport / Identity</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="Passport Number" value={form.passportNumber} onChange={field("passportNumber")} placeholder="e.g. AB1234567" className="col-span-2" />
              <F label="Issue Date" value={form.passportIssueDate} onChange={field("passportIssueDate")} type="date" />
              <F label="Expiry Date" value={form.passportExpiry} onChange={field("passportExpiry")} type="date" />
            </div>
          </section>

          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <GraduationCap className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Education</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F label="High School" value={form.highSchool} onChange={field("highSchool")} placeholder="e.g. Ankara Fen Lisesi" className="col-span-2" />
              <F label="University (Bachelor)" value={form.universityBachelor} onChange={field("universityBachelor")} placeholder="e.g. Istanbul University" className="col-span-2" />
              <F label="University (Master)" value={form.universityMaster} onChange={field("universityMaster")} placeholder="e.g. Bogazici University" className="col-span-2" />
              <F label="Graduation Year" value={form.graduationYear} onChange={field("graduationYear")} placeholder="e.g. 2022" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">GPA</Label>
                <div className="flex gap-1.5">
                  <Input
                    type="number" step="0.01" min="0"
                    max={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.max ?? 4}
                    value={form.gpa}
                    onChange={e => setForm(f => ({ ...f, gpa: e.target.value }))}
                    placeholder={GRADING_SYSTEMS.find(g => g.value === form.gradingSystem)?.placeholder ?? "e.g. 3.8"}
                    className="rounded-xl flex-1 h-9"
                  />
                  <Select value={form.gradingSystem} onValueChange={v => setForm(f => ({ ...f, gradingSystem: v, gpa: "" }))}>
                    <SelectTrigger className="w-[110px] h-9 text-sm rounded-xl shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {GRADING_SYSTEMS.map(gs => (
                        <SelectItem key={gs.value} value={gs.value}>/ {gs.value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <F label="Language Score" value={form.languageScore} onChange={field("languageScore")} placeholder="e.g. IELTS 7.0, TOEFL 100" className="col-span-2" />
            </div>
          </section>

          <div className="space-y-1.5">
            <Label className="font-semibold text-sm">Notes</Label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Any additional notes about this student..."
              rows={2}
              className="w-full rounded-xl border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring resize-none"
            />
          </div>
        </div>
        <DialogFooter className="pt-3 border-t border-border/50">
          <Button variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          <Button onClick={handleSave} disabled={!form.firstName || !form.lastName || saving} className="rounded-xl">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Saving...</> : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function StuDeleteConfirmDialog({ open, onClose, count, onConfirm, isPending }: {
  open: boolean; onClose: () => void; count: number; onConfirm: () => void; isPending: boolean;
}) {
  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Delete {count} Student{count > 1 ? "s" : ""}?</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground py-2">This action cannot be undone.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>{isPending ? "Deleting..." : `Delete ${count}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

type AgentStuFilters = { status: string; nationality: string; dateRange: string; followupRange: string };
const DEFAULT_AGENT_STU_FILTERS: AgentStuFilters = { status: "all", nationality: "all", dateRange: "all", followupRange: "all" };

function stuIsDateInRange(dateStr: string, range: string): boolean {
  if (range === "all") return true;
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (range === "today") return d >= today && d < new Date(today.getTime() + 86400000);
  if (range === "yesterday") { const y = new Date(today); y.setDate(y.getDate() - 1); return d >= y && d < today; }
  if (range === "last7") { const w = new Date(today); w.setDate(w.getDate() - 7); return d >= w; }
  if (range === "thisMonth") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  if (range === "thisYear") return d.getFullYear() === now.getFullYear();
  if (range === "upcoming7") { const w = new Date(today); w.setDate(w.getDate() + 7); return d >= today && d <= w; }
  if (range === "overdue") return d < today;
  if (range === "none") return false;
  return true;
}

function StuFilterPopover({ filters, onChange, stages, nationalities }: {
  stages: PipelineStage[];
  nationalities: string[];
  filters: AgentStuFilters;
  onChange: (f: AgentStuFilters) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasActive = filters.status !== "all" || filters.nationality !== "all" || filters.dateRange !== "all" || filters.followupRange !== "all";
  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className={`rounded-full relative ${hasActive ? "border-primary text-primary bg-primary/5" : ""}`}>
          <Filter className="w-4 h-4" />
          {hasActive && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-4 space-y-3 max-h-[70vh] overflow-y-auto" align="end">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">{t("agentStudents.filter.title")}</p>
          {hasActive && <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onChange({ ...DEFAULT_AGENT_STU_FILTERS })}>{t("agentStudents.filter.clear")}</Button>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("agentStudents.filter.status")}</Label>
          <Select value={filters.status} onValueChange={v => onChange({ ...filters, status: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("agentStudents.filter.all")}</SelectItem>
              {stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("agentStudents.filter.nationality")}</Label>
          <Select value={filters.nationality} onValueChange={v => onChange({ ...filters, nationality: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("agentStudents.filter.all")}</SelectItem>
              {nationalities.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.createdDate")}</Label>
          <Select value={filters.dateRange} onValueChange={v => onChange({ ...filters, dateRange: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="today">{t("studentsPage.today")}</SelectItem>
              <SelectItem value="yesterday">{t("studentsPage.yesterday")}</SelectItem>
              <SelectItem value="last7">{t("studentsPage.last7days")}</SelectItem>
              <SelectItem value="thisMonth">{t("studentsPage.thisMonth")}</SelectItem>
              <SelectItem value="thisYear">{t("studentsPage.thisYear")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.nextFollowup")}</Label>
          <Select value={filters.followupRange} onValueChange={v => onChange({ ...filters, followupRange: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="overdue">{t("studentsPage.overdue")}</SelectItem>
              <SelectItem value="today">{t("studentsPage.today")}</SelectItem>
              <SelectItem value="upcoming7">{t("studentsPage.next7days")}</SelectItem>
              <SelectItem value="none">{t("studentsPage.notSet")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" className="w-full" onClick={() => setOpen(false)}>{t("agentStudents.filter.apply")}</Button>
      </PopoverContent>
    </Popover>
    </>
  );
}

function TransferToSubAgentDialog({ open, onClose, student, subAgents, onSuccess }: {
  open: boolean;
  onClose: () => void;
  student: any;
  subAgents: any[];
  onSuccess: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [subAgentId, setSubAgentId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { if (open) setSubAgentId(""); }, [open, student?.id]);
  if (!student) return null;
  const label = (sa: any) =>
    (sa.companyName || "").trim() ||
    `${sa.firstName ?? ""} ${sa.lastName ?? ""}`.trim() ||
    sa.email ||
    `#${sa.id}`;
  async function handleConfirm() {
    if (!subAgentId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/students/${student.id}/transfer-to-sub-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ subAgentId: Number(subAgentId) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Transfer failed");
      }
      toast({ title: t("agentStudents.transfer.success") });
      onSuccess();
      onClose();
    } catch (e: any) {
      toast({ title: t("agentStudents.transfer.error"), description: e?.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("agentStudents.transfer.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            {t("agentStudents.transfer.description", { name: `${student.firstName ?? ""} ${student.lastName ?? ""}`.trim() })}
          </p>
          <div className="space-y-2">
            <Label>{t("agentStudents.transfer.selectLabel")}</Label>
            <Select value={subAgentId} onValueChange={setSubAgentId}>
              <SelectTrigger><SelectValue placeholder={t("agentStudents.transfer.selectPlaceholder")} /></SelectTrigger>
              <SelectContent>
                {subAgents.map((sa: any) => (
                  <SelectItem key={sa.id} value={String(sa.id)}>{label(sa)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">{t("agentStudents.transfer.note")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>{t("agentStudents.transfer.cancel")}</Button>
          <Button onClick={handleConfirm} disabled={!subAgentId || submitting}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : t("agentStudents.transfer.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentStudentsPage() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Authorization (role + granular permission) is enforced by the route-level
  // ProtectedRoute (AGENT_ROLES + requiredPermission). Do NOT pass a narrower
  // role list here — ["agent","sub_agent"] excludes agent_staff and would
  // bounce permitted agent_staff users to "/" (→ /en).
  const { user } = useAuth(true);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"pipeline" | "list">(() => (localStorage.getItem(VIEW_KEY_STU) as "pipeline" | "list") || "list");
  const [filters, setFilters] = useState<AgentStuFilters>({ ...DEFAULT_AGENT_STU_FILTERS });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sort, setSort] = useState<{ key: StuSortKey; dir: StuSortDir }>({ key: "date", dir: "desc" });
  const [editStudent, setEditStudent] = useState<any>(null);
  const [transferStudent, setTransferStudent] = useState<any>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteInProgress, setDeleteInProgress] = useState(false);
  const pg = useTablePagination(25);
  const [activeId, setActiveId] = useState<number | null>(null);

  const stuSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  );

  const { stages: pipelineStages } = usePipelineStages("student");
  const studentStatuses = pipelineStages.map(s => s.key);
  const stageMap = Object.fromEntries(pipelineStages.map((s, i) => [s.key, { ...s, _index: i }]));

  const { season } = useSeason();
  const { data, isLoading } = useListStudents({ search, season, limit: 500 });
  const allStudents: any[] = data?.data ?? [];

  // Only a parent agent ("agent" role) can transfer students to its OWN
  // sub-agents. sub_agent / agent_staff never see the control.
  const isParentAgent = user?.role === "agent";
  const { data: subAgentsResp } = useQuery({
    queryKey: ["/api/agents/me/sub-agents", "transfer"],
    queryFn: () => fetch(`${BASE_URL}/api/agents/me/sub-agents?limit=100`, { credentials: "include" }).then(r => r.json()),
    enabled: isParentAgent,
  });
  const subAgents: any[] = subAgentsResp?.data ?? [];
  const canTransfer = isParentAgent && subAgents.length > 0;

  const nationalityOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of allStudents) {
      const n = (s.nationality || "").trim();
      if (n) set.add(n);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [allStudents]);

  const filteredStudents = allStudents.filter((s: any) => {
    if (filters.status !== "all" && s.status !== filters.status) return false;
    if (filters.nationality !== "all" && (s.nationality || "").trim() !== filters.nationality) return false;
    if (filters.dateRange !== "all" && s.createdAt && !stuIsDateInRange(s.createdAt, filters.dateRange)) return false;
    if (filters.followupRange !== "all") {
      if (filters.followupRange === "none") { if (s.nextFollowup) return false; }
      else if (!s.nextFollowup || !stuIsDateInRange(s.nextFollowup, filters.followupRange)) return false;
    }
    return true;
  });

  const sortedStudents = useMemo(() => {
    const arr = [...filteredStudents];
    arr.sort((a: any, b: any) => {
      let valA: any, valB: any;
      switch (sort.key) {
        case "name": valA = `${a.firstName} ${a.lastName}`.toLowerCase(); valB = `${b.firstName} ${b.lastName}`.toLowerCase(); break;
        case "email": valA = (a.email || "").toLowerCase(); valB = (b.email || "").toLowerCase(); break;
        case "nationality": valA = (a.nationality || "").toLowerCase(); valB = (b.nationality || "").toLowerCase(); break;
        case "status": valA = a.status || ""; valB = b.status || ""; break;
        case "passport": valA = a.passportNumber || ""; valB = b.passportNumber || ""; break;
        case "date": valA = a.createdAt || ""; valB = b.createdAt || ""; break;
        default: return 0;
      }
      if (valA < valB) return sort.dir === "asc" ? -1 : 1;
      if (valA > valB) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [filteredStudents, sort]);

  const { paged: pagedStudents, total: totalStudentsCount } = pg.paginate(sortedStudents);

  useEffect(() => { pg.setPage(1); setSelectedIds(new Set()); }, [search, filters, sort]);

  const pagedIds = useMemo(() => new Set(pagedStudents.map((s: any) => s.id)), [pagedStudents]);
  const allPageSelected = pagedStudents.length > 0 && pagedStudents.every((s: any) => selectedIds.has(s.id));

  function toggleView(mode: "pipeline" | "list") { setViewMode(mode); localStorage.setItem(VIEW_KEY_STU, mode); setSelectedIds(new Set()); }
  function handleSort(key: StuSortKey) { setSort(prev => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }); }
  function toggleSelect(id: number) { setSelectedIds(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function toggleSelectAll() {
    if (allPageSelected) { setSelectedIds(prev => { const next = new Set(prev); pagedIds.forEach(id => next.delete(id)); return next; }); }
    else { setSelectedIds(prev => { const next = new Set(prev); pagedIds.forEach(id => next.add(id)); return next; }); }
  }

  function invalidate() { queryClient.invalidateQueries({ queryKey: ["/api/students"] }); }

  async function handleExport(scope: "selected" | "all" = "all") {
    // Export the current client-side scoped/filtered set. "selected" exports
    // only the checked rows; "all" exports every filtered+sorted row.
    // Data is already agent-scoped server-side by /api/students, so this adds
    // no new IDOR surface.
    const rows = scope === "selected"
      ? sortedStudents.filter((s: any) => selectedIds.has(s.id))
      : sortedStudents;
    if (rows.length === 0) {
      toast({ title: t("agentStudents.export.empty"), variant: "destructive" });
      return;
    }
    const data = rows.map((s: any) => ({
      [t("agentStudents.export.colName")]: `${s.firstName ?? ""} ${s.lastName ?? ""}`.trim(),
      [t("agentStudents.export.colEmail")]: s.email || "",
      [t("agentStudents.export.colPhone")]: s.phone || "",
      [t("agentStudents.export.colNationality")]: s.nationality || "",
      [t("agentStudents.export.colPassport")]: s.passportNumber || "",
      [t("agentStudents.export.colStatus")]: stageMap[s.status]?.label || s.status || "",
      [t("agentStudents.export.colJoined")]: s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "",
    }));
    const XLSX = await import("xlsx");
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Students");
    XLSX.writeFile(wb, `students_${new Date().toISOString().slice(0, 10)}.xlsx`);
    toast({ title: t("agentStudents.export.success", { count: rows.length }) });
  }

  async function handleBulkDelete() {
    setDeleteInProgress(true);
    const ids = Array.from(selectedIds);
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`${BASE_URL}/api/students/${id}`, { method: "DELETE", credentials: "include" });
        if (!res.ok) failed++;
      } catch { failed++; }
    }
    setDeleteInProgress(false); setDeleteOpen(false); setSelectedIds(new Set());
    invalidate();
    if (failed === 0) toast({ title: `${ids.length} student${ids.length > 1 ? "s" : ""} deleted` });
    else toast({ title: "Some could not be deleted", variant: "destructive" });
  }

  const allStuColumnIds = new Set(pipelineStages.map(s => s.key));
  const activeStuCard = activeId ? allStudents.find((s: any) => s.id === activeId) : null;

  const handleStuDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);

  const handleStuDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    toast({ title: "Only admin & staff can change student status", variant: "destructive" });
  };
  const _handleStuDragEndDisabled = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const studentId = active.id as number;
    const overId = over.id;

    let targetStatus: string;
    if (allStuColumnIds.has(overId as string)) {
      targetStatus = overId as string;
    } else {
      const overStu = allStudents.find((s: any) => s.id === overId);
      if (!overStu) return;
      targetStatus = overStu.status;
    }

    const student = allStudents.find((s: any) => s.id === studentId);
    if (!student || student.status === targetStatus) return;

    apiFetch(`${BASE_URL}/api/students/${studentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: targetStatus }),
    }).then(() => {
      invalidate();
      queryClient.invalidateQueries({ queryKey: [`/api/students/${studentId}`] });
      const colLabel = pipelineStages.find(s => s.key === targetStatus)?.label ?? targetStatus;
      toast({ title: `Student moved → ${colLabel}` });
    }).catch(() => {
      toast({ title: "Error", description: "Could not move student", variant: "destructive" });
      invalidate();
      queryClient.invalidateQueries({ queryKey: [`/api/students/${studentId}`] });
    });
  };

  function formatDate(d: string | null | undefined) {
    if (!d) return "-";
    return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  return (
    <>
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">{t("agentStudents.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{data?.meta?.total ?? 0} total students</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search students..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-white dark:bg-black/20 border-border rounded-full" />
            </div>
            <StuFilterPopover filters={filters} onChange={setFilters} stages={pipelineStages} nationalities={nationalityOptions} />
            <Button variant="outline" className="rounded-full gap-2" onClick={() => handleExport("all")} title={t("agentStudents.export.button")}>
              <Download className="w-4 h-4" /> {t("agentStudents.export.button")}
            </Button>
            <div className="flex items-center border rounded-full overflow-hidden">
              <button onClick={() => toggleView("pipeline")} className={`p-2 transition-colors ${viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="Pipeline view"><LayoutGrid className="w-4 h-4" /></button>
              <button onClick={() => toggleView("list")} className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="List view"><List className="w-4 h-4" /></button>
            </div>
            <Button className="rounded-full shadow-lg shadow-primary/20" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Student
            </Button>
          </div>
        </div>

        {viewMode === "pipeline" && (
          <div className="flex-1 overflow-x-auto overflow-y-hidden pb-4">
            <div className="flex gap-5 h-full min-w-max px-1">
              {pipelineStages.map((ps, idx) => {
                  const statusStudents = filteredStudents.filter((s: any) => s.status === ps.key).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                  return <DroppableStuColumn key={ps.key} status={ps.key} label={ps.label} variant={ps.variant} students={statusStudents} onView={id => setLocation(`/agent/students/${id}`)} />;
                })}
            </div>
          </div>
        )}

        {viewMode === "list" && (
          <div className="flex-1 flex flex-col overflow-hidden bg-card rounded-2xl border">
            {selectedIds.size > 0 && (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-b bg-primary/5 shrink-0">
                <span className="text-sm font-medium text-foreground">{t("agentStudents.selectedCount", { count: selectedIds.size })}</span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" className="gap-2" onClick={() => handleExport("selected")}>
                    <Download className="w-3.5 h-3.5" /> {t("agentStudents.export.exportSelected")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>{t("agentStudents.clearSelection")}</Button>
                </div>
              </div>
            )}
            <div className="flex-1 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-10">
                      <Checkbox
                        checked={allPageSelected}
                        onCheckedChange={toggleSelectAll}
                        aria-label={t("agentStudents.selectAll")}
                      />
                    </TableHead>
                    <StuSortHeader label="Name" sortKey="name" currentSort={sort} onSort={handleSort} />
                    <StuSortHeader label="Email" sortKey="email" currentSort={sort} onSort={handleSort} />
                    <StuSortHeader label="Nationality" sortKey="nationality" currentSort={sort} onSort={handleSort} />
                    <StuSortHeader label="Passport" sortKey="passport" currentSort={sort} onSort={handleSort} />
                    <StuSortHeader label="Status" sortKey="status" currentSort={sort} onSort={handleSort} />
                    <StuSortHeader label="Joined" sortKey="date" currentSort={sort} onSort={handleSort} />
                    <TableHead className="w-20 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">Loading...</TableCell></TableRow>
                  ) : pagedStudents.length === 0 ? (
                    <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No students found</TableCell></TableRow>
                  ) : pagedStudents.map((student: any) => (
                    <TableRow key={student.id} className={cn("cursor-pointer hover:bg-muted/30 transition-colors", selectedIds.has(student.id) && "bg-primary/5")}>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(student.id)}
                          onCheckedChange={() => toggleSelect(student.id)}
                          aria-label={t("agentStudents.selectRow")}
                        />
                      </TableCell>
                      <TableCell className="font-medium cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>
                        <div className="flex items-center gap-2">
                          <StudentAvatar student={student} />
                          <div>
                            <p className="text-sm font-semibold">{student.firstName} {student.lastName}</p>
                            {student.phone && <p className="text-xs text-muted-foreground">{student.phone}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>{student.email || "-"}</TableCell>
                      <TableCell className="cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>{student.nationality || "-"}</TableCell>
                      <TableCell className="font-mono text-xs cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>{student.passportNumber || "-"}</TableCell>
                      <TableCell className="cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>
                        <Badge className={cn("text-xs border font-medium", stageMap[student.status] ? getStuStageColor(stageMap[student.status], stageMap[student.status]._index) : "bg-gray-100 text-gray-600 border-gray-200")}>{stageMap[student.status]?.label || student.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs cursor-pointer" onClick={() => setLocation(`/agent/students/${student.id}`)}>{formatDate(student.createdAt)}</TableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => setEditStudent(student)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title="Edit"><Pencil className="w-3.5 h-3.5" /></button>
                          {canTransfer && (
                            <button onClick={() => setTransferStudent(student)} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" title={t("agentStudents.transfer.title")}><ArrowRightLeft className="w-3.5 h-3.5" /></button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <TablePagination
              currentPage={pg.page}
              totalItems={totalStudentsCount}
              pageSize={pg.pageSize}
              onPageChange={pg.setPage}
              onPageSizeChange={pg.setPageSize}
            />
          </div>
        )}
      </div>

      <EditStudentDialog open={!!editStudent} onClose={() => setEditStudent(null)} student={editStudent} stages={pipelineStages} />
      <TransferToSubAgentDialog open={!!transferStudent} onClose={() => setTransferStudent(null)} student={transferStudent} subAgents={subAgents} onSuccess={invalidate} />
      <AddStudentModal open={addOpen} onClose={() => setAddOpen(false)} onSuccess={invalidate} defaultStatus={pipelineStages[0]?.key} />
    </>
  );
}
