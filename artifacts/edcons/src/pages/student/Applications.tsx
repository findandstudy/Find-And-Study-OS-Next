import { useListApplications } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText, GraduationCap, Calendar, Clock, CheckCircle, XCircle, AlertCircle, BookOpen, Send, Award, Plane, Briefcase, Star, Flag, Inbox } from "lucide-react";
import { StageDocumentsPanel } from "@/components/StageDocumentsPanel";
import { ApplicationDocumentsPanel, APPLICATION_DOC_STAGES } from "@/components/ApplicationDocumentsPanel";
import { useI18n } from "@/hooks/use-i18n";
import { formatDate } from "@/lib/i18n";
import { useDateFormatPublic } from "@/hooks/use-date-format";
import { usePipelineStages } from "@/hooks/use-pipeline-stages";

// Translation key + visual style overrides for built-in default stages.
// Stages added via Settings → Pipeline Stages fall back to the stage label
// from the API and a neutral color/icon — so the progress bar stays in sync
// with whatever the admin has configured.
const STAGE_OVERRIDES: Record<string, { tKey: string; color: string; icon: typeof CheckCircle }> = {
  inquiry:              { tKey: "studentDash.stageInquiry",            color: "bg-slate-100 text-slate-700 border-slate-200",         icon: AlertCircle },
  documents_collected:  { tKey: "studentDash.stageDocumentsCollected", color: "bg-blue-100 text-blue-700 border-blue-200",            icon: FileText    },
  submitted:            { tKey: "studentDash.stageSubmitted",          color: "bg-violet-100 text-violet-700 border-violet-200",      icon: FileText    },
  offer_received:       { tKey: "studentDash.stageOfferReceived",      color: "bg-amber-100 text-amber-700 border-amber-200",         icon: CheckCircle },
  visa_applied:         { tKey: "studentDash.stageVisaApplied",        color: "bg-orange-100 text-orange-700 border-orange-200",      icon: Clock       },
  visa_approved:        { tKey: "studentDash.stageVisaApproved",       color: "bg-emerald-100 text-emerald-700 border-emerald-200",   icon: CheckCircle },
  enrolled:             { tKey: "studentDash.stageEnrolled",           color: "bg-green-100 text-green-700 border-green-200",         icon: GraduationCap },
  rejected:             { tKey: "studentDash.stageRejected",           color: "bg-rose-100 text-rose-700 border-rose-200",            icon: XCircle     },
};

const NEUTRAL_COLOR = "bg-slate-100 text-slate-700 border-slate-200";

// Map admin-configurable stage `icon` strings (set in Settings → Pipeline
// Stages) to lucide icon components. Unknown values fall through to the
// variant-based fallback so the UI stays sensible.
const PIPELINE_ICON_MAP: Record<string, typeof CheckCircle> = {
  inbox: Inbox,
  inquiry: AlertCircle,
  alert: AlertCircle,
  alertCircle: AlertCircle,
  fileText: FileText,
  document: FileText,
  documents: FileText,
  send: Send,
  submitted: Send,
  award: Award,
  offer: Award,
  clock: Clock,
  pending: Clock,
  plane: Plane,
  visa: Plane,
  check: CheckCircle,
  checkCircle: CheckCircle,
  approved: CheckCircle,
  graduationCap: GraduationCap,
  enrolled: GraduationCap,
  xCircle: XCircle,
  rejected: XCircle,
  calendar: Calendar,
  briefcase: Briefcase,
  bookOpen: BookOpen,
  star: Star,
  flag: Flag,
};

function resolveStageIcon(name: string | null | undefined): typeof CheckCircle | null {
  if (!name) return null;
  return PIPELINE_ICON_MAP[name] ?? PIPELINE_ICON_MAP[name.toLowerCase()] ?? null;
}

export default function StudentApplications() {
  const { t, lang } = useI18n();
  const dateFormat = useDateFormatPublic();
  const { data: resp, isLoading } = useListApplications(undefined, { query: { queryKey: ["student-apps-list"] } as any });
  const applications: any[] = (resp as any)?.data || resp || [];
  const { stages: pipelineStages } = usePipelineStages("application");

  // Progress steps are every non-lost stage in pipeline order. Admins can
  // reorder, add, or remove stages in Settings → Pipeline Stages and the
  // student progress bar updates accordingly.
  const stepStages = [...pipelineStages]
    .filter(s => s.variant !== "lost")
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const STEPS = stepStages.map(s => s.key);
  const stageMetaByKey = new Map(pipelineStages.map(s => [s.key, s]));

  // Dynamically derive which stages are doc-bearing so the dedicated
  // ApplicationDocumentsPanel and the generic StageDocumentsPanel never
  // render the same stage twice — even for admin-added custom stages.
  const dynamicDocStages = pipelineStages
    .filter(s => s.uploadPermissionLevel && s.uploadPermissionLevel !== "none")
    .map(s => s.key);
  const docStageExcludeSet = Array.from(new Set([...APPLICATION_DOC_STAGES, ...dynamicDocStages]));

  // Variant-based icon/color fallback for admin-added stages without an
  // override entry — keeps the progress bar visually meaningful for any
  // pipeline shape.
  function variantFallback(variant: string | null | undefined): { color: string; icon: typeof CheckCircle } {
    switch (variant) {
      case "won":          return { color: "bg-green-100 text-green-700 border-green-200",         icon: CheckCircle };
      case "partial_won":  return { color: "bg-amber-100 text-amber-700 border-amber-200",         icon: CheckCircle };
      case "lost":         return { color: "bg-rose-100 text-rose-700 border-rose-200",            icon: XCircle     };
      case "none_finance": return { color: "bg-gray-100 text-gray-600 border-gray-200",            icon: AlertCircle };
      default:             return { color: NEUTRAL_COLOR,                                          icon: FileText    };
    }
  }

  function getStageDisplay(stageKey: string): { label: string; color: string; icon: typeof CheckCircle; isLost: boolean } {
    const override = STAGE_OVERRIDES[stageKey];
    const meta = stageMetaByKey.get(stageKey);
    const label = override ? t(override.tKey) : (meta?.label || stageKey);
    const fallback = variantFallback(meta?.variant);
    // Honor admin-configured per-stage icon when present; otherwise fall
    // back to override (built-in default) or variant-based icon.
    const metaIcon = resolveStageIcon(meta?.icon);
    return {
      label,
      color: override?.color || fallback.color,
      icon: override?.icon || metaIcon || fallback.icon,
      isLost: meta?.variant === "lost",
    };
  }

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
            <FileText className="w-6 h-6 text-primary" /> {t("studentApps.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("studentApps.subtitle")}</p>
        </div>

        {isLoading ? (
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <Card key={i} className="p-6 border-none shadow-md shadow-black/5">
                <div className="space-y-3">
                  <div className="h-5 bg-secondary animate-pulse rounded-full w-1/3" />
                  <div className="h-4 bg-secondary animate-pulse rounded-full w-1/2" />
                  <div className="h-3 bg-secondary animate-pulse rounded-full w-full" />
                </div>
              </Card>
            ))}
          </div>
        ) : applications.length === 0 ? (
          <Card className="p-16 border-none shadow-lg shadow-black/5 text-center border-2 border-dashed border-primary/20">
            <GraduationCap className="w-16 h-16 text-primary/20 mx-auto mb-4" />
            <h3 className="text-xl font-display font-bold text-foreground mb-2">{t("studentApps.none")}</h3>
            <p className="text-muted-foreground">{t("studentApps.noneDesc")}</p>
          </Card>
        ) : (
          <div className="space-y-5">
            {applications.map((app: any) => {
              const stageCfg = getStageDisplay(app.stage);
              const stepIdx = STEPS.indexOf(app.stage);
              const currentStep = stepIdx >= 0 ? stepIdx + 1 : 0;
              const StageIcon = stageCfg.icon;

              return (
                <Card key={app.id} className="border-none shadow-lg shadow-black/5 overflow-hidden">
                  {/* Header */}
                  <div className="p-6 border-b border-border/50">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-muted-foreground">{t("studentApps.appNumber", { id: app.id })}</span>
                          <Badge className={`text-xs border ${stageCfg.color}`}>
                            <StageIcon className="w-3 h-3 mr-1" />
                            {stageCfg.label}
                          </Badge>
                        </div>
                        <h2 className="font-display font-bold text-lg text-foreground">
                          {app.universityName || (app.universityId ? `${t("common.university")} #${app.universityId}` : t("studentApps.universityApp"))}
                        </h2>
                        {app.programName && (
                          <p className="text-sm text-muted-foreground">{app.programName}</p>
                        )}
                        <div className="flex flex-wrap items-center gap-4 mt-1 text-sm text-muted-foreground">
                          {app.intakeDate && (
                            <span className="flex items-center gap-1">
                              <Calendar className="w-3.5 h-3.5" />
                              {t("studentApps.intake", { date: formatDate(lang, app.intakeDate, { month: "long", year: "numeric" }, dateFormat) })}
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="w-3.5 h-3.5" />
                            {t("studentApps.started", { date: formatDate(lang, app.createdAt, { month: "short", day: "numeric", year: "numeric" }, dateFormat) })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Progress Tracker — students only see steps up to current */}
                  {!stageCfg.isLost && STEPS.length > 0 && (() => {
                    const visibleSteps = currentStep > 0 ? STEPS.slice(0, currentStep) : STEPS;
                    return (
                    <div className="px-6 py-6 bg-secondary/20">
                      <div className="relative">
                        <div className="absolute top-5 left-5 right-5 h-0.5 bg-border" />
                        <div
                          className="absolute top-5 left-5 h-0.5 bg-primary transition-all duration-500"
                          style={{ width: visibleSteps.length > 1 ? `${((visibleSteps.length - 1) / Math.max(1, visibleSteps.length - 1)) * 100}%` : "0%" }}
                        />
                        <div className="relative flex justify-between">
                          {visibleSteps.map((step, i) => {
                            const info = getStageDisplay(step);
                            const isDone = currentStep > i + 1;
                            const isCurrent = currentStep === i + 1;
                            return (
                              <div key={step} className="flex flex-col items-center gap-2 relative z-10">
                                <div className={`w-10 h-10 rounded-full border-2 flex items-center justify-center transition-all
                                  ${isDone ? "bg-primary border-primary text-white shadow-md shadow-primary/30" :
                                    isCurrent ? "bg-white border-primary text-primary shadow-md shadow-primary/30" :
                                    "bg-background border-border text-muted-foreground"}`}>
                                  {isDone ? <CheckCircle className="w-5 h-5" /> : (
                                    <span className="text-xs font-bold">{i + 1}</span>
                                  )}
                                </div>
                                <p className={`text-[10px] font-medium text-center max-w-[60px] leading-tight hidden md:block
                                  ${isCurrent ? "text-primary font-bold" : isDone ? "text-foreground" : "text-muted-foreground"}`}>
                                  {info.label}
                                </p>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    );
                  })()}

                  {stageCfg.isLost && (
                    <div className="px-6 py-4 bg-rose-50 border-t border-rose-200">
                      <div className="flex items-center gap-2 text-rose-700">
                        <XCircle className="w-4 h-4" />
                        <p className="text-sm font-medium">{t("studentApps.notSuccessful")}</p>
                      </div>
                    </div>
                  )}

                  {/* Notes */}
                  {app.notes && (
                    <div className="px-6 py-4 border-t border-border/50">
                      <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-1">{t("studentApps.advisorNotes")}</p>
                      <p className="text-sm text-foreground">{app.notes}</p>
                    </div>
                  )}

                  <div className="px-6 py-4 border-t border-border/50 space-y-4">
                    <ApplicationDocumentsPanel
                      applicationId={app.id}
                      userRole="student"
                      currentStage={app.stage}
                    />
                    <StageDocumentsPanel
                      applicationId={app.id}
                      currentStage={app.stage}
                      userRole="student"
                      excludeStages={docStageExcludeSet}
                    />
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
  );
}
