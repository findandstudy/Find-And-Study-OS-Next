import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import * as XLSX from "xlsx";
import { toLatinUpper } from "@/lib/textTransform";
import { Link, useLocation } from "wouter";
import { TableSkeleton } from "@/components/ui/page-skeleton";
import { usePersistedFilterValue } from "@/hooks/use-table-prefs";
import { QuickContactDialog } from "@/components/QuickContact";
import { AssignPopover } from "@/components/AssignPopover";
import { RowActionsMenu } from "@/components/RowActionsMenu";
import { BulkActionBar } from "@/components/BulkActionBar";
import { BulkMessageDialog } from "@/components/BulkMessageDialog";
import { useListStudents, useCreateStudent, customFetch } from "@workspace/api-client-react";
import { uploadDocumentFile } from "@/lib/uploadDocumentFile";
import { useAuth } from "@/hooks/use-auth";
import { useSeason } from "@/contexts/SeasonContext";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ColumnHeader } from "@/components/ui/column-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PhoneCodePicker } from "@/components/ui/phone-code-picker";
import { useStudyLevels } from "@/hooks/useStudyLevels";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import {
  DndContext, closestCorners, DragOverlay,
  useSensors, useSensor, PointerSensor, KeyboardSensor,
  useDroppable,
  type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Search, Plus, FileText, FileUp, Sparkles, ChevronLeft,
  User, GraduationCap, X, CheckCircle2, AlertCircle,
  Users, Download, Eye, Loader2, LayoutGrid, List,
  ArrowUpDown, ArrowUp, ArrowDown, Trash2, Pencil,
  ChevronRight, Filter, UserCheck, UserX, UserMinus, UserPlus,
  Trophy, XCircle, MessageSquare, Mail, Building2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { isNonLatinNameError } from "@/lib/latinNameError";
import { CountryFlag } from "@/components/CountryFlag";
import { useCountrySearch } from "@/hooks/use-countries";
import { OriginBadge } from "@/components/OriginBadge";
import { cn } from "@/lib/utils";
import { usePipelineStages, type PipelineStage } from "@/hooks/use-pipeline-stages";
import { useI18n } from "@/hooks/use-i18n";
import { AddStudentModal, NationalityCombobox } from "@/components/AddStudentModal";
import { LinkedTableCell } from "@/components/LinkedTableCell";
import { StudentListPhotoAvatar } from "@/components/StudentListPhotoAvatar";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

function getCsrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return m ? decodeURIComponent(m[1]) : "";
}

async function apiFetch(url: string, opts?: RequestInit) {
  const headers = new Headers(opts?.headers);
  if (opts?.method && opts.method !== "GET" && opts.method !== "HEAD") {
    headers.set("x-csrf-token", getCsrfToken());
  }
  const r = await fetch(url, { credentials: "include", ...opts, headers });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(text || `HTTP ${r.status}`);
  }
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
function levelBadgeColor(idx: number): string {
  return LEVEL_BADGE_COLORS[idx % LEVEL_BADGE_COLORS.length];
}
function isMasterOrHigher(level: string): boolean {
  const v = level.toLowerCase();
  return v.includes("master") || v.includes("ph") || v.includes("doctor");
}
function isDoctorate(level: string): boolean {
  const v = level.toLowerCase();
  return v.includes("ph") || v.includes("doctor");
}

const DOC_TYPE_META: Record<string, { label: string; icon: string; accept: string }> = {
  high_school_diploma_translation:    { label: "HS Diploma",           icon: "🎓", accept: "image/*,.pdf" },
  class_10th_ssc_marks_sheet:         { label: "10th Marks Sheet",     icon: "📋", accept: "image/*,.pdf" },
  class_12th_hsc_certificate:         { label: "12th Certificate",     icon: "📜", accept: "image/*,.pdf" },
  class_12th_hsc_marks_sheet:         { label: "12th Marks Sheet",     icon: "📋", accept: "image/*,.pdf" },
  diploma_certificate:                { label: "Diploma Certificate",  icon: "🎓", accept: "image/*,.pdf" },
  diploma_transcript:                 { label: "Diploma Transcript",   icon: "📋", accept: "image/*,.pdf" },
  bachelors_certificate:              { label: "Bachelor's Cert.",     icon: "🎓", accept: "image/*,.pdf" },
  bachelors_transcript:               { label: "Bachelor's Transcript",icon: "📋", accept: "image/*,.pdf" },
  bachelors_provisional_certificate:  { label: "Provisional Cert.",    icon: "📜", accept: "image/*,.pdf" },
  bachelors_transcript_all_semesters: { label: "All Sem. Transcript",  icon: "📋", accept: "image/*,.pdf" },
  masters_certificate:                { label: "Master's Cert.",       icon: "🎓", accept: "image/*,.pdf" },
  masters_transcript:                 { label: "Master's Transcript",  icon: "📋", accept: "image/*,.pdf" },
  masters_provisional_certificate:    { label: "Master's Provisional", icon: "📜", accept: "image/*,.pdf" },
  masters_transcript_all_semesters:   { label: "All Sem. Transcript",  icon: "📋", accept: "image/*,.pdf" },
  passport:                           { label: "Passport",             icon: "🛂", accept: "image/*,.pdf" },
  cv:                                 { label: "CV / Resume",          icon: "📄", accept: "image/*,.pdf" },
  lor:                                { label: "LOR",                  icon: "✉️", accept: "image/*,.pdf" },
  sop:                                { label: "SOP",                  icon: "✍️", accept: "image/*,.pdf" },
  essay:                              { label: "Essay",                icon: "📝", accept: "image/*,.pdf" },
  experience_letters:                 { label: "Experience Letters",   icon: "💼", accept: "image/*,.pdf" },
  other_certificates_documents:       { label: "Other Documents",      icon: "📁", accept: "image/*,.pdf" },
  ielts_pte_gre_gmat_toefl_duolingo:  { label: "Language Test",        icon: "🌐", accept: "image/*,.pdf" },
  photo:                              { label: "Photograph",           icon: "📷", accept: ".pdf,.jpg,.jpeg,.png" },
  diploma_recognition:                { label: "Diploma Recognition",  icon: "📜", accept: "image/*,.pdf" },
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

const EMPTY_FORM = {
  firstName: "", lastName: "", email: "", phone: "", phoneCode: "",
  nationality: "", dateOfBirth: "", gender: "",
  passportNumber: "", passportIssueDate: "", passportExpiry: "",
  motherName: "", fatherName: "", address: "",
  highSchool: "", graduationYear: "", gpa: "", gradingSystem: "4",
  universityBachelor: "", universityMaster: "",
  languageScore: "",
  notes: "",
  interestedLevel: "",
};

const GRADING_SYSTEMS = [
  { value: "4", label: "Out of 4", placeholder: "e.g. 3.8", max: 4 },
  { value: "5", label: "Out of 5", placeholder: "e.g. 4.5", max: 5 },
  { value: "10", label: "Out of 10", placeholder: "e.g. 8.5", max: 10 },
  { value: "12", label: "Out of 12", placeholder: "e.g. 10", max: 12 },
  { value: "20", label: "Out of 20", placeholder: "e.g. 16.5", max: 20 },
  { value: "100", label: "Out of 100", placeholder: "e.g. 85", max: 100 },
];

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


const SAMPLE_CSV = `firstName,lastName,email,phone,nationality,dateOfBirth,gender,passportNumber,motherName,fatherName
John,Doe,john@example.com,+1-555-0001,American,1998-05-15,male,US12345678,Mary Doe,James Doe
Jane,Smith,jane@example.com,+44-20-0002,British,2000-09-22,female,GB87654321,Sarah Smith,Robert Smith`;

function BulkImportModal({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void; }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<any[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ success: number; errors: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleClose() {
    setCsvFile(null);
    setParsing(false);
    setPreview(null);
    setImporting(false);
    setResult(null);
    onClose();
  }

  async function fileToCsv(file: File): Promise<string> {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    if (!isExcel) return file.text();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) throw new Error(t("studentsPage.csvParsingFailed"));
    return XLSX.utils.sheet_to_csv(wb.Sheets[firstSheet]);
  }

  async function parseCSV(file: File) {
    setParsing(true);
    setPreview(null);
    try {
      const text = await fileToCsv(file);
      const res = await fetch(`${BASE_URL}/api/ai/extract-bulk-csv`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ csvData: text }),
      });
      if (!res.ok) throw new Error(t("studentsPage.csvParsingFailed"));
      const { students } = await res.json();
      setPreview(students);
    } catch (err: any) {
      toast({ title: "CSV parse failed", description: err.message, variant: "destructive" });
    } finally {
      setParsing(false);
    }
  }

  async function importAll() {
    if (!preview) return;
    setImporting(true);
    try {
      const res = await fetch(`${BASE_URL}/api/students/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ students: preview }),
      });
      if (!res.ok) throw new Error(t("studentsPage.importFailed"));
      const data = await res.json();
      setResult({ success: data.success, errors: data.errors?.length || 0 });
      onSuccess();
    } catch (err: any) {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-6 pt-5 pb-4 border-b border-border/50 shrink-0">
          <DialogTitle className="text-xl font-display flex items-center gap-2">
            <Users className="w-5 h-5 text-primary" />
            Bulk Import Students
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">
          {!result && (
            <>
              <div className="bg-gradient-to-br from-blue-50 to-violet-50 border border-blue-100 rounded-2xl p-4 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-semibold">AI-powered CSV / Excel Import</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Upload any CSV or Excel file with student data. AI will intelligently map column names regardless of format — no strict header requirements.
                  </p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold">CSV File</p>
                  <button
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                    onClick={() => {
                      const wb = XLSX.read(SAMPLE_CSV, { type: "string" });
                      const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
                      const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = "sample_students.xlsx";
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <Download className="w-3 h-3" /> Download Sample
                  </button>
                </div>

                {!csvFile ? (
                  <div
                    className="border-2 border-dashed border-border hover:border-primary/50 rounded-2xl p-8 text-center cursor-pointer transition-colors hover:bg-secondary/30"
                    onClick={() => inputRef.current?.click()}
                  >
                    <FileUp className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm font-semibold text-foreground">Drop CSV or Excel file here or click to browse</p>
                    <p className="text-xs text-muted-foreground mt-1">Accepts .csv, .xlsx, .xls files</p>
                    <input
                      ref={inputRef}
                      type="file"
                      accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) { setCsvFile(f); parseCSV(f); }
                        e.target.value = "";
                      }}
                    />
                  </div>
                ) : (
                  <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-xl border border-border">
                    <FileText className="w-5 h-5 text-primary" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{csvFile.name}</p>
                      <p className="text-xs text-muted-foreground">{Math.round(csvFile.size / 1024)}KB</p>
                    </div>
                    <button
                      onClick={() => { setCsvFile(null); setPreview(null); }}
                      className="text-muted-foreground hover:text-destructive transition-colors p-1"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {parsing && (
                <div className="flex items-center gap-3 p-4 bg-violet-50 border border-violet-100 rounded-xl">
                  <Loader2 className="w-5 h-5 text-violet-500 animate-spin" />
                  <div>
                    <p className="text-sm font-semibold text-violet-700">AI is parsing your CSV…</p>
                    <p className="text-xs text-violet-600">Mapping columns and extracting student records</p>
                  </div>
                </div>
              )}

              {preview && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold">
                      Preview — <span className="text-primary">{preview.length} students</span>
                    </p>
                    <span className="text-xs text-muted-foreground">Scroll to review all</span>
                  </div>
                  <div className="border border-border rounded-xl overflow-hidden">
                    <div className="overflow-x-auto max-h-60">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/50 border-b border-border sticky top-0">
                          <tr>
                            {["#", "First Name", "Last Name", "Email", "Nationality", "DOB", "Passport", "Mother", "Father"].map((h) => (
                              <th key={h} className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/50">
                          {preview.map((s: any, i: number) => (
                            <tr key={i} className="hover:bg-secondary/20">
                              <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                              <td className="px-3 py-2 font-medium">{s.firstName || "—"}</td>
                              <td className="px-3 py-2">{s.lastName || "—"}</td>
                              <td className="px-3 py-2 text-muted-foreground max-w-[120px] truncate">{s.email || "—"}</td>
                              <td className="px-3 py-2">{s.nationality || "—"}</td>
                              <td className="px-3 py-2">{s.dateOfBirth || "—"}</td>
                              <td className="px-3 py-2 font-mono">{s.passportNumber || "—"}</td>
                              <td className="px-3 py-2">{s.motherName || "—"}</td>
                              <td className="px-3 py-2">{s.fatherName || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}

          {result && (
            <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
              <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
                <CheckCircle2 className="w-10 h-10 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-display font-bold">{result.success} Students Imported!</p>
                {result.errors > 0 && (
                  <p className="text-sm text-destructive mt-1">{result.errors} row{result.errors !== 1 ? "s" : ""} skipped (missing required fields)</p>
                )}
              </div>
              <Button onClick={handleClose} className="rounded-xl mt-2">Done</Button>
            </div>
          )}
        </div>

        {!result && (
          <div className="px-6 pb-5 pt-3 border-t border-border/50 flex items-center justify-between shrink-0">
            <Button variant="outline" onClick={handleClose} className="rounded-xl">Cancel</Button>
            <Button
              onClick={importAll}
              disabled={!preview || importing || preview.length === 0}
              className="rounded-xl gap-2"
            >
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
              Import {preview ? `${preview.length} Students` : "Students"}
            </Button>
          </div>
        )}
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
  return (
    <StudentListPhotoAvatar
      studentId={student.id}
      firstName={student.firstName}
      lastName={student.lastName}
      photoUrl={student.photoUrl}
      size={size}
    />
  );
}

function DraggableStudentCard({ student, onView, variant, assignedUserName, onAssign, staffUsersList, currentUserId, canAssign, canReassign, canMoveCards }: { student: any; onView: (id: number) => void; variant?: StuColVariant; assignedUserName?: string; onAssign?: (entityId: number, userId: number) => void; staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: student.id, disabled: !canMoveCards });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const [contactOpen, setContactOpen] = useState(false);
  const [contactChannel, setContactChannel] = useState<"email" | "whatsapp" | "instagram" | "internal">("internal");
  const [, setLoc] = useLocation();

  const isDirect = !student.originType || student.originType === "direct";
  const cardBg =
    variant === "won" ? "bg-emerald-50 border-emerald-200 hover:border-emerald-300 dark:bg-emerald-900/20 dark:border-emerald-700/40 dark:hover:border-emerald-600/60" :
    variant === "lost" ? "bg-rose-50 border-rose-200 hover:border-rose-300 dark:bg-rose-900/20 dark:border-rose-700/40 dark:hover:border-rose-600/60" :
    isDirect ? "bg-blue-50 border-blue-200 hover:border-blue-300 hover:shadow-md dark:bg-blue-900/20 dark:border-blue-700/40 dark:hover:border-blue-600/60" :
    "bg-card border-border hover:shadow-md";

  function openContact(ch: "email" | "whatsapp" | "instagram" | "internal") {
    setContactChannel(ch);
    setContactOpen(true);
  }

  return (
    <>
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-xl border ${isDragging ? "border-primary shadow-xl opacity-50 z-50 relative" : cardBg} mb-3 transition-shadow duration-200`}
    >
      <div {...attributes} {...listeners} className={`p-4 pb-2 ${!canMoveCards ? "cursor-default" : isDragging ? "cursor-grabbing" : "cursor-grab"}`}>
        <div className="flex items-center gap-2.5 mb-1.5">
          <StudentAvatar student={student} />
          <div className="min-w-0">
            <h4 className="font-bold text-sm text-foreground line-clamp-1">{student.firstName} {student.lastName}</h4>
            <p className="text-xs text-muted-foreground truncate">{student.email || student.phone || "No contact"}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
          {student.nationality && <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">{student.nationality}</span>}
          <OriginBadge originType={student.originType || "direct"} originDisplayName={student.originDisplayName} />
        </div>
      </div>
      {student.agentName && (
        <div className="px-4 pb-1.5">
          <span
            className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 font-medium cursor-pointer hover:bg-amber-100 hover:border-amber-300 transition-colors max-w-full truncate dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/50 dark:hover:bg-amber-900/50"
            onClick={(e) => { e.stopPropagation(); setLoc(`/staff/agents/${student.agentId}`); }}
            title={`Agent: ${student.agentName}`}
          >
            <Building2 className="w-3 h-3 shrink-0" />{student.agentName}
          </span>
        </div>
      )}
      <div className="px-4 pb-3 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {onAssign && student.assignedToId ? (
            (canReassign || student.assignedToId === currentUserId) && staffUsersList ? (
              <AssignPopover assignedUserName={assignedUserName} staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(student.id, uid)} />
            ) : assignedUserName ? (
              <span className="flex min-w-0 items-center gap-0.5 truncate text-[10px] text-muted-foreground" title={assignedUserName}><UserCheck className="w-3 h-3 shrink-0" />{assignedUserName}</span>
            ) : null
          ) : onAssign && !student.assignedToId ? (
            canReassign && staffUsersList ? (
              <AssignPopover staffUsers={staffUsersList} currentUserId={currentUserId} onAssign={(uid) => onAssign(student.id, uid)} />
            ) : canAssign && currentUserId ? (
              <button onClick={(e) => { e.stopPropagation(); onAssign(student.id, currentUserId); }} className="text-[10px] text-primary hover:underline font-medium flex items-center gap-0.5" title="Assign to me">
                <UserPlus className="w-3 h-3 shrink-0" />Assign to me
              </button>
            ) : null
          ) : assignedUserName ? (
            <span className="flex min-w-0 items-center gap-0.5 truncate text-[10px] text-muted-foreground" title={assignedUserName}><UserCheck className="w-3 h-3 shrink-0" />{assignedUserName}</span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); openContact("internal"); }} title="Message"
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
          {student.email && (
            <button onClick={(e) => { e.stopPropagation(); openContact("email"); }} title="Email"
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
              <Mail className="w-3.5 h-3.5" />
            </button>
          )}
          {student.phone && (
            <button onClick={(e) => { e.stopPropagation(); openContact("whatsapp"); }} title="WhatsApp"
              className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-emerald-600 hover:bg-emerald-50 transition-colors">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            </button>
          )}
          <Link
            href={`/staff/students/${student.id}`}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
            title="View student"
          >
            <Eye className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>
      <QuickContactDialog
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        channel={contactChannel}
        setChannel={setContactChannel}
        name={`${student.firstName} ${student.lastName}`}
        email={student.email}
        phone={student.phone}
        entityType="student"
        entityId={student.id}
        hideEmail={!student.email}
        hideWhatsApp={!student.phone}
      />
    </div>
    </>
  );
}

function DroppableStuColumn({ status, label, variant, students, totalCount, onView, staffUsersMap, onAssign, staffUsersList, currentUserId, canAssign, canReassign, canMoveCards }: { status: string; label: string; variant?: string | null; students: any[]; totalCount?: number; onView: (id: number) => void; staffUsersMap?: Record<number, string>; onAssign?: (entityId: number, userId: number) => void; staffUsersList?: { id: number; name: string }[]; currentUserId?: number; canAssign?: boolean; canReassign?: boolean; canMoveCards?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const v = variant as StuColVariant;

  const colBg = v === "won" ? "bg-emerald-50/60 border-emerald-200/50 dark:bg-emerald-900/20 dark:border-emerald-700/30" : v === "lost" ? "bg-rose-50/60 border-rose-200/50 dark:bg-rose-900/20 dark:border-rose-700/30" : "bg-secondary/50 border-border/50";
  const headerBg = v === "won" ? "bg-emerald-100/80 border-emerald-200/70 dark:bg-emerald-900/40 dark:border-emerald-700/50" : v === "lost" ? "bg-rose-100/80 border-rose-200/70 dark:bg-rose-900/40 dark:border-rose-700/50" : "bg-card/50 border-border/50";
  const badgeBg = v === "won" ? "bg-emerald-200/60 text-emerald-800 border-emerald-300/50 dark:bg-emerald-800/40 dark:text-emerald-200 dark:border-emerald-600/40" : v === "lost" ? "bg-rose-200/60 text-rose-800 border-rose-300/50 dark:bg-rose-800/40 dark:text-rose-200 dark:border-rose-600/40" : "bg-background text-muted-foreground border shadow-sm";

  const dropBg =
    v === "won" ? (isOver ? "bg-emerald-100/60 dark:bg-emerald-900/30" : "") :
    v === "lost" ? (isOver ? "bg-rose-100/60 dark:bg-rose-900/30" : "") :
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
          <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border ${badgeBg}`}>{totalCount ?? students.length}</span>
        </div>
      </div>
      <div ref={setNodeRef} className={`p-3 flex-1 overflow-y-auto custom-scrollbar transition-colors duration-150 ${dropBg}`}>
        <SortableContext items={students.map(s => s.id)} strategy={verticalListSortingStrategy}>
          {students.map((s: any) => (
            <DraggableStudentCard key={s.id} student={s} onView={onView} variant={v} assignedUserName={s.assignedToId && staffUsersMap ? staffUsersMap[s.assignedToId] : undefined} onAssign={onAssign} staffUsersList={staffUsersList} currentUserId={currentUserId} canAssign={canAssign} canReassign={canReassign} canMoveCards={canMoveCards} />
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
  const { t } = useI18n();
  const { levels: studyLevels } = useStudyLevels();
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", phone: "", phoneCode: "",
    nationality: "", status: "active", dateOfBirth: "",
    passportNumber: "", passportIssueDate: "", passportExpiry: "",
    motherName: "", fatherName: "", address: "",
    cityOfBirth: "", addressCity: "", postalCode: "", needsVisaSupport: "",
    highSchool: "", graduationYear: "", gpa: "", gradingSystem: "",
    universityBachelor: "", universityMaster: "",
    languageScore: "", notes: "", interestedLevel: "",
    eduCity: "", eduCountry: "", eduField: "",
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
  const { data: educationRecords = [] } = useQuery<any[]>({
    queryKey: ["/api/students", student?.id, "education-records"],
    queryFn: () =>
      fetch(`${BASE_URL}/api/students/${student.id}/education-records`, {
        credentials: "include",
      }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
    enabled: open && !!student?.id,
  });

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
      const level = (student.interestedLevel || "").toLowerCase();
      const priorLevel =
        /phd|doctor/.test(level) ? "master" :
        /master/.test(level) ? "bachelor" :
        /bachelor|associate|certificate/.test(level) ? "high_school" :
        "";
      const priorRecord = educationRecords.find(
        (record: any) => record.level === priorLevel,
      );
      const gpaRaw = priorRecord?.gpa || student.gpa || "";
      let gpaVal = gpaRaw;
      let gradingSys = priorRecord?.gpaType
        ? String(priorRecord.gpaType)
          .toLowerCase()
          .replace("percentage", "100")
          .replace("4.0", "4")
          .replace(/^grading system out of /, "")
        : "";
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
        passportNumber: student.passportNumber || "",
        passportIssueDate: student.passportIssueDate || "",
        passportExpiry: student.passportExpiry || "",
        motherName: student.motherName || "", fatherName: student.fatherName || "",
        address: student.address || "",
        cityOfBirth: student.cityOfBirth || "",
        addressCity: student.addressCity || "",
        postalCode: student.postalCode || "",
        needsVisaSupport:
          student.needsVisaSupport == null
            ? ""
            : student.needsVisaSupport ? "yes" : "no",
        highSchool: student.highSchool || "",
        graduationYear: priorRecord?.endYear?.toString() || student.graduationYear?.toString() || "",
        gpa: gpaVal, gradingSystem: gradingSys,
        universityBachelor: student.universityBachelor || "",
        universityMaster: student.universityMaster || "",
        languageScore: priorRecord?.languageScore || student.languageScore || "",
        notes: student.notes || "",
        interestedLevel: student.interestedLevel || "",
        eduCity: priorRecord?.city || "",
        eduCountry: priorRecord?.country || "",
        eduField: priorRecord?.fieldOfStudy || "",
      });
    }
  }, [open, student, educationRecords]);

  function field(name: string) {
    return (val: string) => setForm(f => ({ ...f, [name]: val }));
  }

  async function handleSave() {
    if (!student || !form.firstName || !form.lastName) return;
    setSaving(true);
    try {
      const phone = form.phone ? `${form.phoneCode}${form.phone.replace(/^\s+/, "")}` : "";
      const gpa =
        form.gpa && form.gradingSystem
          ? form.gradingSystem !== "4"
            ? `${form.gpa}/${form.gradingSystem}`
            : form.gpa
          : form.gpa;
      const res = await fetch(`${BASE_URL}/api/students/${student.id}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: form.firstName, lastName: form.lastName,
          email: form.email, phone,
          nationality: form.nationality, status: form.status,
          dateOfBirth: form.dateOfBirth,
          passportNumber: form.passportNumber,
          passportIssueDate: form.passportIssueDate,
          passportExpiry: form.passportExpiry,
          motherName: form.motherName, fatherName: form.fatherName,
          address: form.address,
          cityOfBirth: form.cityOfBirth || null,
          addressCity: form.addressCity || null,
          postalCode: form.postalCode || null,
          needsVisaSupport:
            form.needsVisaSupport === "" ? null : form.needsVisaSupport === "yes",
          highSchool: form.highSchool,
          interestedLevel: form.interestedLevel || null,
          graduationYear: form.graduationYear ? parseInt(form.graduationYear) : null,
          gpa, universityBachelor: form.universityBachelor,
          universityMaster: form.universityMaster,
          languageScore: form.languageScore, notes: form.notes,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Also write education_records for the prior level based on interestedLevel
      const lvl = (form.interestedLevel || "").toLowerCase();
      const isBachelorApp = /bachelor|associate|certificate/.test(lvl);
      const isMasterApp = /master/.test(lvl);
      const isPhdApp = /phd|doctor/.test(lvl);
      if (isBachelorApp || isMasterApp || isPhdApp) {
        const priorLevel = isBachelorApp ? "high_school" : isMasterApp ? "bachelor" : "master";
        const schoolName = isBachelorApp ? form.highSchool : isMasterApp ? form.universityBachelor : form.universityMaster;
        if (schoolName || form.eduCity || form.eduCountry || form.eduField) {
          try {
            const eduRes = await fetch(`${BASE_URL}/api/students/${student.id}/education-records/${priorLevel}`, {
              method: "PUT", credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                schoolName: schoolName || null,
                city: form.eduCity || null,
                country: form.eduCountry || null,
                fieldOfStudy: form.eduField || null,
                endYear: form.graduationYear ? parseInt(form.graduationYear) : null,
                gpa: form.gpa || null,
                gpaType: form.gpa && form.gradingSystem ? form.gradingSystem : null,
                languageScore: form.languageScore || null,
              }),
            });
            if (!eduRes.ok) throw new Error(`HTTP ${eduRes.status}`);
          } catch {
            toast({ title: "Warning", description: "Student saved, but education record could not be updated.", variant: "destructive" });
          }
        }
      }
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
        <DialogHeader><DialogTitle>{t("studentsPage.editStudent")}</DialogTitle></DialogHeader>
        <div className="overflow-y-auto flex-1 space-y-6 pr-1 py-2">
          <section className="space-y-4">
            <div className="flex items-center gap-2 border-b border-border/50 pb-2">
              <User className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-bold uppercase tracking-wide text-foreground">Personal Information</h3>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <F required label={t("studentsPage.firstName")} value={form.firstName} onChange={field("firstName")} placeholder={t("studentsPage.firstNamePlaceholder")} latinUppercase />
              <F required label={t("studentsPage.lastName")} value={form.lastName} onChange={field("lastName")} placeholder={t("studentsPage.lastNamePlaceholder")} latinUppercase />
              <F label="Email" value={form.email} onChange={field("email")} type="email" placeholder="email@example.com" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Phone</Label>
                <div className="flex gap-1.5">
                  <PhoneCodePicker value={form.phoneCode} onChange={field("phoneCode")} triggerClassName="w-[100px] h-9 shrink-0" />
                  <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="555 000 0000" className="rounded-xl flex-1 h-9" />
                </div>
              </div>
              <F label="Date of Birth" value={form.dateOfBirth} onChange={field("dateOfBirth")} type="date" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Nationality</Label>
                <NationalityCombobox value={form.nationality} onChange={field("nationality")} countries={allCountries} />
              </div>
              <F label={t("studentsPage.motherName")} value={form.motherName} onChange={field("motherName")} placeholder={t("studentsPage.motherNamePlaceholder")} latinUppercase />
              <F label={t("studentsPage.fatherName")} value={form.fatherName} onChange={field("fatherName")} placeholder={t("studentsPage.fatherNamePlaceholder")} latinUppercase />
              <F label={t("studentsPage.address")} value={form.address} onChange={field("address")} placeholder={t("studentsPage.addressPlaceholder")} className="col-span-2" />
              <F label="Residence City" value={form.addressCity} onChange={field("addressCity")} placeholder="e.g. Khujand" />
              <F label="Postal Code" value={form.postalCode} onChange={field("postalCode")} placeholder="e.g. 735700" />
              <F label="City of Birth (optional)" value={form.cityOfBirth} onChange={field("cityOfBirth")} placeholder="e.g. Khujand" />
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Needs Visa Support</Label>
                <select
                  value={form.needsVisaSupport}
                  onChange={(e) => field("needsVisaSupport")(e.target.value)}
                  className="flex h-9 w-full rounded-xl border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Not specified</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-semibold text-sm">Status</Label>
                <Select value={form.status} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger className="h-9 text-sm rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>{stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}</SelectContent>
                </Select>
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
              <div className="col-span-2 space-y-1.5">
                <Label className="font-semibold text-sm">Interested Level</Label>
                <Select value={form.interestedLevel} onValueChange={field("interestedLevel")}>
                  <SelectTrigger className="rounded-xl h-9">
                    <SelectValue placeholder="Select level..." />
                  </SelectTrigger>
                  <SelectContent>
                    {studyLevels.map(l => <SelectItem key={l.key} value={l.key}>{l.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {(() => {
                const lvl = (form.interestedLevel || "").toLowerCase();
                const isBachelorApp = /bachelor|associate|certificate/.test(lvl);
                const isMasterApp = /master/.test(lvl);
                const isPhdApp = /phd|doctor/.test(lvl);
                const showLevelSpecific = isBachelorApp || isMasterApp || isPhdApp;
                const priorLabel = isBachelorApp ? "High School" : isMasterApp ? "University (Bachelor)" : "University (Master)";
                const priorField = isBachelorApp ? "highSchool" : isMasterApp ? "universityBachelor" : "universityMaster";
                const priorValue = isBachelorApp ? form.highSchool : isMasterApp ? form.universityBachelor : form.universityMaster;
                const priorPlaceholder = isBachelorApp ? "e.g. Ankara Fen Lisesi" : isMasterApp ? "e.g. Istanbul University" : "e.g. Bogazici University";
                if (showLevelSpecific) return (
                  <>
                    <F label={priorLabel} value={priorValue} onChange={field(priorField)} placeholder={priorPlaceholder} className="col-span-2" />
                    <F label="City" value={form.eduCity} onChange={field("eduCity")} placeholder="e.g. Istanbul" />
                    <div className="space-y-1.5">
                      <Label className="font-semibold text-sm">Country</Label>
                      <NationalityCombobox value={form.eduCountry} onChange={field("eduCountry")} countries={allCountries} />
                    </div>
                    {!isBachelorApp && (
                      <F label="Field of Study" value={form.eduField} onChange={field("eduField")} placeholder="e.g. Computer Engineering" className="col-span-2" />
                    )}
                  </>
                );
                return (
                  <>
                    <F label="High School" value={form.highSchool} onChange={field("highSchool")} placeholder="e.g. Ankara Fen Lisesi" className="col-span-2" />
                    <F label="University (Bachelor)" value={form.universityBachelor} onChange={field("universityBachelor")} placeholder="e.g. Istanbul University" className="col-span-2" />
                    <F label="University (Master)" value={form.universityMaster} onChange={field("universityMaster")} placeholder="e.g. Bogazici University" className="col-span-2" />
                  </>
                );
              })()}
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
              placeholder={t("studentsPage.additionalNotesPlaceholder")}
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
  const { t } = useI18n();
  return (
    <>
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{count > 1 ? t("studentsPage.deleteStudentMulti") : t("studentsPage.deleteStudentSingle")}</DialogTitle></DialogHeader>
        <p className="text-sm text-muted-foreground py-2">{t("studentsPage.thisActionCannotBeUndone")}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("studentsPage.cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>{isPending ? t("studentsPage.deleting") : `${t("studentsPage.deleteAction")} ${count}`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

type StuFilters = { status: string; appSource: string; assignment: string; nationality: string; agent: string; dateRange: string; followupRange: string; originType: string };
const DEFAULT_STU_FILTERS: StuFilters = { status: "all", appSource: "all", assignment: "mine_unassigned", nationality: "all", agent: "all", dateRange: "all", followupRange: "all", originType: "all" };

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

function StuFilterPopover({ filters, onChange, stages, staffUsers, currentUserId, students, facetNationalities, facetAgents, canViewOthers, canViewUnassigned }: {
  stages: PipelineStage[];
  filters: StuFilters;
  onChange: (f: StuFilters) => void;
  staffUsers: any[];
  currentUserId?: number;
  students: any[];
  facetNationalities?: string[];
  facetAgents?: Array<{ id: number; name: string }>;
  canViewOthers: boolean;
  canViewUnassigned: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const hasActive = Object.entries(filters).some(([k, v]) => v !== (DEFAULT_STU_FILTERS as any)[k]);

  const uniqueNationalities = useMemo(() => {
    const set = new Set<string>();
    students.forEach((s: any) => { if (s.nationality) set.add(s.nationality); });
    return facetNationalities?.length ? facetNationalities : Array.from(set).sort();
  }, [students, facetNationalities]);

  const uniqueAgents = useMemo(() => {
    const map = new Map<number, string>();
    students.forEach((s: any) => { if (s.agentId && s.agentName) map.set(s.agentId, s.agentName); });
    return facetAgents?.length
      ? facetAgents.map((agent) => [agent.id, agent.name] as [number, string])
      : Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [students, facetAgents]);

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" className={`rounded-full relative ${hasActive ? "border-primary text-primary bg-primary/5" : ""}`}>
          <Filter className="w-4 h-4" />
          {hasActive && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4 space-y-3 max-h-[70vh] overflow-y-auto" align="end">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Filter</p>
          {hasActive && <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => onChange({ ...DEFAULT_STU_FILTERS, assignment: "all" })}>Clear</Button>}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Status</Label>
          <Select value={filters.status} onValueChange={v => onChange({ ...filters, status: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {stages.map(s => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.nationalityLabel")}</Label>
          <Select value={filters.nationality} onValueChange={v => onChange({ ...filters, nationality: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              {uniqueNationalities.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.agentLabel")}</Label>
          <Select value={filters.agent} onValueChange={v => onChange({ ...filters, agent: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="none">{t("studentsPage.noAgent")}</SelectItem>
              {uniqueAgents.map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.origin")}</Label>
          <Select value={filters.originType} onValueChange={v => onChange({ ...filters, originType: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="direct">{t("studentsPage.direct")}</SelectItem>
              <SelectItem value="agent">{t("studentsPage.agentLabel")}</SelectItem>
              <SelectItem value="sub_agent">{t("studentsPage.subAgent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.assignedToLabel")}</Label>
          <Select value={filters.assignment} onValueChange={v => onChange({ ...filters, assignment: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent className="max-h-60">
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="mine">{t("studentsPage.me")}</SelectItem>
              <SelectItem value="unassigned">{t("studentsPage.unassigned")}</SelectItem>
              <SelectItem value="mine_unassigned">{t("studentsPage.meUnassigned")}</SelectItem>
              {staffUsers.filter((u: any) => u.id !== currentUserId).map((u: any) => (
                <SelectItem key={u.id} value={String(u.id)}>{`${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("studentsPage.applications")}</Label>
          <Select value={filters.appSource} onValueChange={v => onChange({ ...filters, appSource: v })}>
            <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("studentsPage.all")}</SelectItem>
              <SelectItem value="agent">{t("studentsPage.agentLabel")}</SelectItem>
              <SelectItem value="staff">{t("studentsPage.staffLabel")}</SelectItem>
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
        <Button size="sm" className="w-full" onClick={() => setOpen(false)}>{t("studentsPage.apply")}</Button>
      </PopoverContent>
    </Popover>
    </>
  );
}

export default function StudentsPage() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user, hasPermission } = useAuth(true, [
    "super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant",
  ]);
  const isAdmin = user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager";
  const canMoveCards = isAdmin || hasPermission("records.move_cards");
  const canAssign = isAdmin || hasPermission("records.assign_button");
  const canReassign = !!isAdmin; // Task #494: non-admin relies on per-record current-assignee check
  const canViewOthers = hasPermission("records.view_others");
  const canViewUnassigned = hasPermission("records.view_unassigned");
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"pipeline" | "list">(() => (localStorage.getItem(VIEW_KEY_STU) as "pipeline" | "list") || "list");
  const [persistedAssignment, setPersistedAssignment] = usePersistedFilterValue(
    "students-table", "assignment_v2",
    (user?.role === "super_admin" || user?.role === "admin" || user?.role === "manager") ? "all" : DEFAULT_STU_FILTERS.assignment,
    user?.id,
  );
  const [filters, setFilters] = useState<StuFilters>({ ...DEFAULT_STU_FILTERS, assignment: persistedAssignment });
  useEffect(() => {
    setFilters(f => f.assignment === persistedAssignment ? f : { ...f, assignment: persistedAssignment });
  }, [persistedAssignment]);
  const persistAssignmentRef = useRef(setPersistedAssignment);
  persistAssignmentRef.current = setPersistedAssignment;
  useEffect(() => {
    persistAssignmentRef.current(filters.assignment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.assignment]);
  const [colFilters, setColFilters] = useState({ name: "", email: "", passport: "" });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [messageCampaignOpen, setMessageCampaignOpen] = useState(false);
  const [sort, setSort] = useState<{ key: StuSortKey; dir: StuSortDir }>({ key: "date", dir: "desc" });
  const [editStudent, setEditStudent] = useState<any>(null);
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

  const { data: staffUsersData } = useQuery({
    queryKey: ["staff-users-list"],
    queryFn: () => customFetch("/api/users?roles=super_admin,admin,manager,staff,consultant,accountant,editor&limit=100") as Promise<any>,
    staleTime: 5 * 60 * 1000,
  });
  const staffUsers = staffUsersData
    ? (Array.isArray(staffUsersData) ? staffUsersData : staffUsersData?.data || []).filter((u: any) => ["super_admin", "admin", "manager", "staff", "consultant", "accountant", "editor"].includes(u.role))
    : [];
  const staffUsersMap = useMemo(() => {
    const m: Record<number, string> = {};
    staffUsers.forEach((u: any) => { m[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email; });
    return m;
  }, [staffUsers]);

  const staffUsersList = useMemo(() =>
    staffUsers.map((u: any) => ({ id: u.id, name: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email })),
    [staffUsers]
  );

  async function handleAssign(studentId: number, userId: number) {
    try {
      await customFetch(`/api/students/${studentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: userId }),
      });
      queryClient.invalidateQueries({ queryKey: ["/api/students"] });
      toast({ title: "Student assigned" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  }

  const { season } = useSeason();
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const studentListParams = useMemo(() => ({
    search: debouncedSearch || undefined,
    season,
    page: viewMode === "list" ? pg.page : 1,
    limit: viewMode === "list" ? pg.pageSize : 500,
    status: filters.status !== "all" ? filters.status : undefined,
    appSource: filters.appSource !== "all" ? filters.appSource : undefined,
    assignment: filters.assignment !== "all" ? filters.assignment : undefined,
    nationality: filters.nationality !== "all" ? filters.nationality : undefined,
    agentId: filters.agent !== "all" ? filters.agent : undefined,
    originType: filters.originType !== "all" ? filters.originType : undefined,
    dateRange: filters.dateRange !== "all" ? filters.dateRange : undefined,
    followupRange: filters.followupRange !== "all" ? filters.followupRange : undefined,
    name: colFilters.name || undefined,
    email: colFilters.email || undefined,
    passport: colFilters.passport || undefined,
    sortKey: sort.key,
    sortDir: sort.dir,
    includeFacets: pg.page === 1 ? 1 : 0,
  }), [debouncedSearch, season, viewMode, pg.page, pg.pageSize, filters, colFilters, sort]);
  const { data, isLoading } = useListStudents(studentListParams as any);
  const allStudents: any[] = data?.data ?? [];
  const studentFacetScopeKey = useMemo(() => {
    const { page: _page, limit: _limit, includeFacets: _includeFacets, ...scope } = studentListParams as any;
    return JSON.stringify(scope);
  }, [studentListParams]);
  const studentAggregateCache = useRef<{
    key: string;
    statusCounts: Record<string, number>;
    facets?: { nationalities?: string[]; agents?: Array<{ id: number; name: string }> };
  } | null>(null);
  const studentAggregates = useMemo(() => {
    const meta = (data as any)?.meta;
    if (meta?.facets) {
      const next = {
        key: studentFacetScopeKey,
        statusCounts: (meta.statusCounts || {}) as Record<string, number>,
        facets: meta.facets as { nationalities?: string[]; agents?: Array<{ id: number; name: string }> },
      };
      studentAggregateCache.current = next;
      return next;
    }
    return studentAggregateCache.current?.key === studentFacetScopeKey
      ? studentAggregateCache.current
      : { key: studentFacetScopeKey, statusCounts: {}, facets: undefined };
  }, [data, studentFacetScopeKey]);
  const studentFacets = studentAggregates.facets;
  const studentStatusCounts = studentAggregates.statusCounts;

  const uniqueNationalities = useMemo(() => {
    if (studentFacets?.nationalities?.length) return studentFacets.nationalities;
    const set = new Set<string>();
    allStudents.forEach((s: any) => { if (s.nationality) set.add(s.nationality); });
    return Array.from(set).sort();
  }, [allStudents, studentFacets]);

  const filteredStudents = allStudents.filter((s: any) => {
    if (colFilters.name) {
      const fullName = `${s.firstName || ""} ${s.lastName || ""}`.toUpperCase();
      const needle = toLatinUpper(colFilters.name);
      if (!fullName.includes(needle)) return false;
    }
    if (colFilters.email && !(s.email || "").toLowerCase().includes(colFilters.email.toLowerCase())) return false;
    if (colFilters.passport && !(s.passportNumber || s.passport || "").toLowerCase().includes(colFilters.passport.toLowerCase())) return false;
    if (filters.status !== "all" && s.status !== filters.status) return false;
    if (filters.appSource === "agent" && !s.agentId) return false;
    if (filters.appSource === "staff" && s.agentId) return false;
    if (filters.assignment === "mine" && s.assignedToId !== user?.id) return false;
    if (filters.assignment === "mine_unassigned" && !(s.assignedToId === user?.id || s.assignedToId == null)) return false;
    if (filters.assignment === "unassigned" && s.assignedToId != null) return false;
    if (filters.assignment !== "all" && filters.assignment !== "mine" && filters.assignment !== "mine_unassigned" && filters.assignment !== "unassigned" && !isNaN(Number(filters.assignment)) && s.assignedToId !== Number(filters.assignment)) return false;
    if (filters.nationality !== "all" && (s.nationality || "") !== filters.nationality) return false;
    if (filters.agent !== "all") {
      if (filters.agent === "none") { if (s.agentId) return false; }
      else if (String(s.agentId) !== filters.agent) return false;
    }
    if (filters.originType !== "all" && (s.originType || "direct") !== filters.originType) return false;
    if (filters.dateRange !== "all" && s.createdAt && !stuIsDateInRange(s.createdAt, filters.dateRange)) return false;
    if (filters.followupRange !== "all") {
      if (filters.followupRange === "none") { if (s.nextFollowup) return false; }
      else if (!s.nextFollowup) return false;
      else if (!stuIsDateInRange(s.nextFollowup, filters.followupRange)) return false;
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

  const pagedStudents = sortedStudents;
  const totalStudentsCount = Number((data as any)?.meta?.total ?? sortedStudents.length);

  useEffect(() => { pg.setPage(1); setSelectedIds(new Set()); }, [search, filters, colFilters, sort]);

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

  async function handleBulkDelete() {
    setDeleteInProgress(true);
    try {
      const res = await fetch(`${BASE_URL}/api/students/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "delete" }) });
      if (!res.ok) throw new Error("Failed");
      const d = await res.json();
      toast({ title: `${d.updated} student${d.updated !== 1 ? "s" : ""} deleted` });
    } catch { toast({ title: "Some could not be deleted", variant: "destructive" }); }
    setDeleteInProgress(false); setDeleteOpen(false); setSelectedIds(new Set());
    invalidate();
  }

  async function handleBulkAssign(userId: number) {
    try {
      const res = await fetch(`${BASE_URL}/api/students/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "assign", assignedToId: userId }) });
      if (!res.ok) throw new Error("Failed");
      const d = await res.json();
      toast({ title: `${d.updated} student${d.updated !== 1 ? "s" : ""} assigned` });
    } catch { toast({ title: "Could not assign students", variant: "destructive" }); }
    setSelectedIds(new Set()); invalidate();
  }

  async function handleBulkMoveStatus(status: string) {
    try {
      const res = await fetch(`${BASE_URL}/api/students/bulk-action`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": getCsrfToken() }, credentials: "include", body: JSON.stringify({ ids: Array.from(selectedIds), action: "move", status }) });
      if (!res.ok) throw new Error("Failed");
      const d = await res.json();
      toast({ title: `${d.updated} student${d.updated !== 1 ? "s" : ""} moved` });
    } catch { toast({ title: "Could not move students", variant: "destructive" }); }
    setSelectedIds(new Set()); invalidate();
  }

  const allStuColumnIds = new Set(pipelineStages.map(s => s.key));
  const activeStuCard = activeId ? allStudents.find((s: any) => s.id === activeId) : null;

  const handleStuDragStart = (event: DragStartEvent) => setActiveId(event.active.id as number);

  const isSuperAdmin = user?.role === "super_admin";

  const handleStuDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    if (!canMoveCards) {
      toast({ title: "You don't have permission to move cards", variant: "destructive" });
      return;
    }

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
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "-";
    return `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}.${dt.getFullYear()}`;
  }

  if (isLoading) {
    return (
      <>
        <TableSkeleton />
      </>
    );
  }

  return (
    <>
      <div className="h-[calc(100vh-8rem)] flex flex-col">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div>
            <h1 className="text-3xl font-display font-bold text-foreground">{t("staffStudents.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{data?.meta?.total ?? 0} total students</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input placeholder={t("studentsPage.searchStudents")} value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-white dark:bg-black/20 border-border rounded-full" />
            </div>
            <StuFilterPopover
              filters={filters}
              onChange={setFilters}
              stages={pipelineStages}
              staffUsers={staffUsers}
              currentUserId={user?.id}
              students={allStudents}
              facetNationalities={studentFacets?.nationalities}
              facetAgents={studentFacets?.agents}
              canViewOthers={canViewOthers}
              canViewUnassigned={canViewUnassigned}
            />
            <div className="flex items-center border rounded-full overflow-hidden">
              <button onClick={() => toggleView("pipeline")} className={`p-2 transition-colors ${viewMode === "pipeline" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="Pipeline view"><LayoutGrid className="w-4 h-4" /></button>
              <button onClick={() => toggleView("list")} className={`p-2 transition-colors ${viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"}`} title="List view"><List className="w-4 h-4" /></button>
            </div>
            <BulkActionBar
              selectedCount={selectedIds.size}
              onDelete={(isAdmin || hasPermission("students.delete")) ? () => setDeleteOpen(true) : undefined}
              onAssign={handleBulkAssign}
              onMove={handleBulkMoveStatus}
              onSendMessage={() => setMessageCampaignOpen(true)}
              stages={pipelineStages.map(s => ({ key: s.key, label: s.label }))}
              staffUsers={canReassign ? staffUsersList : []}
              entityLabel="students"
              moveLabel="Move Status"
            />
            {isAdmin && (
              <Button variant="outline" size="sm" className="rounded-full h-8 gap-1.5" onClick={() => { const a = document.createElement("a"); const idsParam = selectedIds.size > 0 ? `&ids=${Array.from(selectedIds).join(",")}` : ""; a.href = `${BASE_URL}/api/export/students?season=${encodeURIComponent(season || "")}${idsParam}`; a.click(); }}>
                <Download className="w-3.5 h-3.5" /> Excel
              </Button>
            )}
            {(isAdmin || hasPermission("students.import")) && (
              <Button variant="outline" className="rounded-full gap-2 border-primary/30 text-primary hover:bg-primary/5" onClick={() => setBulkOpen(true)}>
                <FileUp className="w-4 h-4" /> Bulk Import
              </Button>
            )}
            <Button className="rounded-full shadow-lg shadow-primary/20" onClick={() => setAddOpen(true)}>
              <Plus className="w-4 h-4 mr-2" /> Add Student
            </Button>
          </div>
        </div>

        {viewMode === "pipeline" && (
          <div className="flex-1 overflow-x-auto overflow-y-hidden pb-4">
            <div className="flex gap-5 h-full min-w-max px-1">
              <DndContext
                sensors={stuSensors}
                collisionDetection={closestCorners}
                onDragStart={handleStuDragStart}
                onDragEnd={handleStuDragEnd}
              >
                {pipelineStages.map((ps, idx) => {
                  const statusStudents = filteredStudents.filter((s: any) => s.status === ps.key).sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
                  return <DroppableStuColumn key={ps.key} status={ps.key} label={ps.label} variant={ps.variant} students={statusStudents} totalCount={studentStatusCounts[ps.key]} onView={id => setLocation(`/staff/students/${id}`)} staffUsersMap={staffUsersMap} onAssign={handleAssign} staffUsersList={staffUsersList} currentUserId={user?.id} canAssign={canAssign} canReassign={canReassign} canMoveCards={canMoveCards} />;
                })}

                <DragOverlay>
                  {activeStuCard ? (
                    <div className="bg-card rounded-xl border border-primary shadow-2xl p-4 w-72 opacity-95 rotate-1">
                      <div className="flex items-center gap-2.5 mb-1.5">
                        <StudentAvatar student={activeStuCard} />
                        <div className="min-w-0">
                          <h4 className="font-bold text-sm text-foreground line-clamp-1">{activeStuCard.firstName} {activeStuCard.lastName}</h4>
                          <p className="text-xs text-muted-foreground truncate">{activeStuCard.email || activeStuCard.phone || "No contact"}</p>
                        </div>
                      </div>
                      {activeStuCard.nationality && <span className="text-[10px] px-2 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">{activeStuCard.nationality}</span>}
                    </div>
                  ) : null}
                </DragOverlay>
              </DndContext>
            </div>
          </div>
        )}

        {viewMode === "list" && (
          <div className="flex-1 flex flex-col overflow-hidden bg-card rounded-2xl border">
            <div className="flex-1 overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-10"><Checkbox checked={allPageSelected} onCheckedChange={toggleSelectAll} /></TableHead>
                    <ColumnHeader
                      label={t("studentsPage.name")}
                      sort={{ sortKey: "name", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.email")}
                      sort={{ sortKey: "email", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.nationalityLabel")}
                      sort={{ sortKey: "nationality", current: sort, onSort: handleSort }}
                      filter={{ type: "select", value: filters.nationality, onChange: v => setFilters(f => ({ ...f, nationality: v })), options: uniqueNationalities.map(n => ({ value: n, label: n })), label: t("studentsPage.nationalityLabel") }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.passport")}
                      sort={{ sortKey: "passport", current: sort, onSort: handleSort }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.statusLabel")}
                      sort={{ sortKey: "status", current: sort, onSort: handleSort }}
                      filter={{ type: "select", value: filters.status, onChange: v => setFilters(f => ({ ...f, status: v })), options: pipelineStages.map(s => ({ value: s.key, label: s.label })), label: t("studentsPage.statusLabel") }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.assigned")}
                      filter={{
                        type: "select",
                        value: filters.assignment,
                        onChange: v => setFilters(f => ({ ...f, assignment: v })),
                        options: [
                          { value: "mine", label: t("studentsPage.me") },
                          { value: "unassigned", label: t("studentsPage.unassigned") },
                          { value: "mine_unassigned", label: t("studentsPage.meUnassigned") },
                          ...staffUsers.filter((u: any) => u.id !== user?.id).map((u: any) => ({
                            value: String(u.id),
                            label: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email,
                          })),
                        ],
                        allLabel: t("studentsPage.all"),
                        hideAll: false,
                        label: t("studentsPage.assignedToLabel"),
                      }}
                    />
                    <ColumnHeader
                      label={t("studentsPage.joined")}
                      sort={{ sortKey: "date", current: sort, onSort: handleSort }}
                      filter={{
                        type: "select",
                        value: filters.dateRange,
                        onChange: v => setFilters(f => ({ ...f, dateRange: v })),
                        options: [
                          { value: "today", label: t("studentsPage.today") },
                          { value: "yesterday", label: t("studentsPage.yesterday") },
                          { value: "last7", label: t("studentsPage.last7days") },
                          { value: "thisMonth", label: t("studentsPage.thisMonth") },
                          { value: "thisYear", label: t("studentsPage.thisYear") },
                        ],
                        label: t("studentsPage.joinedDateLabel"),
                      }}
                    />
                    <TableHead className="w-20 text-right">{t("studentsPage.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    <TableRow><TableCell colSpan={9} className="text-center py-12 text-muted-foreground">{t("studentsPage.loading")}</TableCell></TableRow>
                  ) : pagedStudents.length === 0 ? (
                    <TableRow><TableCell colSpan={9} className="text-center py-12 text-muted-foreground">{t("studentsPage.noStudentsFound")}</TableCell></TableRow>
                  ) : pagedStudents.map((student: any) => (
                    <TableRow key={student.id} className={`cursor-pointer hover:bg-muted/30 transition-colors ${selectedIds.has(student.id) ? "bg-primary/5" : ""}`}>
                      <TableCell onClick={e => e.stopPropagation()}><Checkbox checked={selectedIds.has(student.id)} onCheckedChange={() => toggleSelect(student.id)} /></TableCell>
                      <LinkedTableCell
                        href={`/staff/students/${student.id}`}
                        linkLabel={`Open ${student.firstName} ${student.lastName}`}
                        primary
                        className="font-medium"
                      >
                        <div className="flex items-center gap-2">
                          <StudentAvatar student={student} />
                          <div>
                            <div className="flex items-center gap-1.5">
                              <p className="text-sm font-semibold">{student.firstName} {student.lastName}</p>
                              <OriginBadge originType={student.originType} originDisplayName={student.originDisplayName} />
                            </div>
                            {student.phone && <p className="text-xs text-muted-foreground">{student.phone}</p>}
                          </div>
                        </div>
                      </LinkedTableCell>
                      <LinkedTableCell href={`/staff/students/${student.id}`} linkLabel={`Open ${student.firstName} ${student.lastName}`} className="text-muted-foreground">{student.email || "-"}</LinkedTableCell>
                      <LinkedTableCell href={`/staff/students/${student.id}`} linkLabel={`Open ${student.firstName} ${student.lastName}`}>{student.nationality || "-"}</LinkedTableCell>
                      <LinkedTableCell href={`/staff/students/${student.id}`} linkLabel={`Open ${student.firstName} ${student.lastName}`} className="font-mono text-xs">{student.passportNumber || "-"}</LinkedTableCell>
                      <LinkedTableCell href={`/staff/students/${student.id}`} linkLabel={`Open ${student.firstName} ${student.lastName}`}>
                        <Badge className={cn("text-xs border font-medium", stageMap[student.status] ? getStuStageColor(stageMap[student.status], stageMap[student.status]._index) : "bg-gray-100 text-gray-600 border-gray-200")}>{stageMap[student.status]?.label || student.status}</Badge>
                      </LinkedTableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        {student.assignedToId ? (
                          (canReassign || student.assignedToId === user?.id) ? (
                            <AssignPopover
                              assignedUserName={staffUsersMap[student.assignedToId]}
                              staffUsers={staffUsersList}
                              currentUserId={user?.id}
                              onAssign={(userId) => handleAssign(student.id, userId)}
                              size="list"
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground truncate flex items-center gap-1">
                              <UserCheck className="w-3 h-3" />{staffUsersMap[student.assignedToId] || t("leadsPage.assigned")}
                            </span>
                          )
                        ) : canReassign ? (
                          <AssignPopover
                            staffUsers={staffUsersList}
                            currentUserId={user?.id}
                            onAssign={(userId) => handleAssign(student.id, userId)}
                            size="list"
                          />
                        ) : canAssign ? (
                          <button
                            onClick={e => { e.stopPropagation(); handleAssign(student.id, user!.id); }}
                            className="text-[10px] text-primary hover:underline font-medium flex items-center gap-1"
                          >
                            <UserPlus className="w-3 h-3 shrink-0" />{t("leadsPage.assignToMe")}
                          </button>
                        ) : null}
                      </TableCell>
                      <LinkedTableCell href={`/staff/students/${student.id}`} linkLabel={`Open ${student.firstName} ${student.lastName}`} className="text-muted-foreground text-xs">{formatDate(student.createdAt)}</LinkedTableCell>
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <RowActionsMenu
                          entityType="student"
                          entityId={student.id}
                          entityName={`${student.firstName} ${student.lastName}`}
                          currentAgentId={student.agentId}
                          currentAgentName={student.agentName}
                          currentAssignedToId={student.assignedToId}
                          staffUsersMap={staffUsersMap}
                          staffUsersList={staffUsersList}
                          currentUserId={user?.id}
                          isAdmin={isAdmin}
                          canAssign={canAssign}
                          canReassign={canReassign}
                          userId={student.userId}
                          onEdit={() => setEditStudent(student)}
                          onDelete={(isAdmin || hasPermission("students.delete")) ? () => { setSelectedIds(new Set([student.id])); setDeleteOpen(true); } : undefined}
                          onAssign={(uid) => handleAssign(student.id, uid)}
                          onRefresh={() => queryClient.invalidateQueries({ queryKey: ["/api/students"] })}
                        />
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
      <StuDeleteConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} count={selectedIds.size} onConfirm={handleBulkDelete} isPending={deleteInProgress} />
      <BulkMessageDialog
        open={messageCampaignOpen}
        onOpenChange={setMessageCampaignOpen}
        entityType="student"
        entityIds={Array.from(selectedIds)}
        onCreated={() => setSelectedIds(new Set())}
      />
      <AddStudentModal open={addOpen} onClose={() => setAddOpen(false)} onSuccess={invalidate} defaultStatus={pipelineStages[0]?.key} />
      <BulkImportModal open={bulkOpen} onClose={() => setBulkOpen(false)} onSuccess={invalidate} />
    </>
  );
}
