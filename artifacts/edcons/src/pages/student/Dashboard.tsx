import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useListApplications, useListDocuments, customFetch } from "@workspace/api-client-react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { QuickLinkLogo } from "@/components/QuickLinkLogo";
import { Button } from "@/components/ui/button";
import { FileText, GraduationCap, Upload, CheckCircle, Clock, AlertCircle, MapPin, MessageSquare, Search, Mail, Phone, User, ExternalLink } from "lucide-react";
import { useLocation } from "wouter";
import { OfferDeadlinesWidget } from "@/components/OfferDeadlinesWidget";

const STAGE_META: Record<string, { labelKey: string; color: string; step: number }> = {
  inquiry: { labelKey: "studentDash.stageInquiry", color: "bg-slate-400", step: 1 },
  documents_collected: { labelKey: "studentDash.stageDocumentsCollected", color: "bg-blue-500", step: 2 },
  submitted: { labelKey: "studentDash.stageSubmitted", color: "bg-violet-500", step: 3 },
  offer_received: { labelKey: "studentDash.stageOfferReceived", color: "bg-amber-500", step: 4 },
  visa_applied: { labelKey: "studentDash.stageVisaApplied", color: "bg-orange-500", step: 5 },
  visa_approved: { labelKey: "studentDash.stageVisaApproved", color: "bg-emerald-500", step: 6 },
  enrolled: { labelKey: "studentDash.stageEnrolled", color: "bg-green-600", step: 7 },
  rejected: { labelKey: "studentDash.stageRejected", color: "bg-rose-500", step: 0 },
};

const STEPS = ["inquiry", "documents_collected", "submitted", "offer_received", "visa_applied", "visa_approved", "enrolled"];

function getInitials(first?: string | null, last?: string | null) {
  return `${(first || "")[0] || ""}${(last || "")[0] || ""}`.toUpperCase() || "?";
}

function formatRole(role: string | null | undefined, fallback: string) {
  if (!role) return fallback;
  return role.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export default function StudentDashboard() {
  const { user } = useAuth(true);
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const { data: applicationsResp, isLoading: appsLoading } = useListApplications(undefined, { query: { queryKey: ['student-applications'] } as any });
  const { data: documentsResp } = useListDocuments(undefined, { query: { queryKey: ['student-docs'] } as any });
  const applications: any[] = (applicationsResp as any)?.data || applicationsResp || [];
  const documents: any[] = (documentsResp as any)?.data || documentsResp || [];

  const { data: advisor, isLoading: advisorLoading } = useQuery<any>({
    queryKey: ["my-advisor"],
    queryFn: async () => {
      try {
        return await customFetch("/api/students/my-advisor");
      } catch {
        return null;
      }
    },
    enabled: !!user,
  });

  const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
  const { data: quickLinksData } = useQuery<any>({
    queryKey: ["/api/quick-links"],
    queryFn: () => fetch(`${BASE}/api/quick-links`, { credentials: "include" }).then(r => r.json()),
    enabled: !!user,
  });
  const quickLinks: any[] = quickLinksData?.data || [];

  const latestApp = applications?.[0];
  const stageInfo = latestApp ? STAGE_META[latestApp.stage] : null;
  const currentStep = stageInfo?.step || 0;
  const docStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      approved: "studentDash.docStatusApproved",
      rejected: "studentDash.docStatusRejected",
      pending: "studentDash.docStatusPending",
      requested: "studentDash.docStatusRequested",
      under_review: "studentDash.docStatusUnderReview",
    };
    return map[status] ? t(map[status]) : status;
  };
  const pendingDocs = (documents || []).filter(d => d.status === 'pending' || d.status === 'requested').length;

  return (
      <div className="space-y-8">
        <div className="bg-gradient-to-r from-primary to-accent rounded-2xl p-8 text-white relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 rounded-full bg-white/10 -translate-y-16 translate-x-16" />
          <div className="relative z-10">
            <GraduationCap className="w-10 h-10 mb-4 text-white/80" />
            <h1 className="text-3xl font-display font-bold mb-2">
              {t("studentDash.welcomeBack", { name: user?.firstName || t("studentDash.welcomeFallback") })}
            </h1>
            <p className="text-white/80 text-lg">
              {latestApp ? t("studentDash.appProgressing") : t("studentDash.letsStart")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: t("studentDash.applications"), value: applications?.length || 0, icon: FileText, color: "text-blue-500 bg-blue-500/10" },
            { label: t("studentDash.documents"), value: documents?.length || 0, icon: Upload, color: "text-purple-500 bg-purple-500/10" },
            { label: t("studentDash.pendingDocs"), value: pendingDocs, icon: AlertCircle, color: "text-amber-500 bg-amber-500/10" },
            { label: t("studentDash.enrolled"), value: (applications || []).filter(a => a.stage === 'enrolled').length, icon: CheckCircle, color: "text-green-500 bg-green-500/10" },
          ].map((s, i) => (
            <Card key={i} className="p-5 border-none shadow-md shadow-black/5">
              <div className={`w-10 h-10 rounded-xl ${s.color} flex items-center justify-center mb-3`}>
                <s.icon className="w-5 h-5" />
              </div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="text-2xl font-display font-bold text-foreground mt-1">{s.value}</p>
            </Card>
          ))}
        </div>

        {latestApp ? (
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-start justify-between mb-8">
              <div>
                <h2 className="font-display font-bold text-xl text-foreground">{t("studentDash.applicationProgress")}</h2>
                <p className="text-muted-foreground text-sm mt-1 flex items-center gap-1">
                  <MapPin className="w-4 h-4" /> {t("studentDash.applicationNumber", { id: latestApp.id })}
                </p>
              </div>
              {stageInfo && (
                <Badge className={`${stageInfo.color} text-white text-sm px-4 py-1.5`}>
                  {t(stageInfo.labelKey)}
                </Badge>
              )}
            </div>
            <div className="relative">
              <div className="absolute top-5 left-5 right-5 h-0.5 bg-border" />
              <div className="relative flex justify-between">
                {STEPS.map((step, i) => {
                  const info = STAGE_META[step];
                  const isDone = currentStep > i + 1;
                  const isCurrent = currentStep === i + 1;
                  return (
                    <div key={step} className="flex flex-col items-center gap-3 relative z-10">
                      <div className={`w-10 h-10 rounded-full border-2 flex items-center justify-center text-xs font-bold transition-all
                        ${isDone ? 'bg-primary border-primary text-white shadow-md shadow-primary/25' :
                          isCurrent ? 'bg-white border-primary text-primary shadow-md shadow-primary/25' :
                          'bg-background border-border text-muted-foreground'}`}>
                        {isDone ? <CheckCircle className="w-5 h-5" /> : i + 1}
                      </div>
                      <p className={`text-xs font-medium text-center max-w-[70px] leading-tight hidden sm:block
                        ${isCurrent ? 'text-primary font-bold' : isDone ? 'text-foreground' : 'text-muted-foreground'}`}>
                        {t(info.labelKey)}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        ) : (
          <Card className="p-12 border-none shadow-lg shadow-black/5 text-center border-2 border-dashed border-primary/20">
            <GraduationCap className="w-16 h-16 text-primary/30 mx-auto mb-4" />
            <h3 className="text-xl font-display font-bold text-foreground mb-2">{t("studentDash.startApplication")}</h3>
            <p className="text-muted-foreground mb-6">{t("studentDash.browsePrograms")}</p>
            <Button className="rounded-xl gap-2 px-8" onClick={() => setLocation("/student/course-finder")}>
              <Search className="w-4 h-4" /> {t("studentDash.applyNow")}
            </Button>
          </Card>
        )}

        {quickLinks.length > 0 && (
          <Card className="p-6 border-none shadow-lg shadow-black/5">
            <div className="flex items-center gap-2 mb-5">
              <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
                <ExternalLink className="w-4 h-4 text-violet-500" />
              </div>
              <h3 className="font-display font-bold text-base">{t("studentDash.quickLinks")}</h3>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {quickLinks.map((link: any) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 p-3 rounded-xl border border-border/60 hover:bg-primary/5 hover:border-primary/30 transition-all group"
                >
                  <QuickLinkLogo logoUrl={link.logoUrl} title={link.title} icon={link.icon} color={link.color} className="w-9 h-9" />
                  <span className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">{link.title}</span>
                </a>
              ))}
            </div>
          </Card>
        )}

        <OfferDeadlinesWidget detailHrefPrefix="/student/applications" hideStudent />

        <div className="grid lg:grid-cols-2 gap-6">
          <Card className="border-none shadow-lg shadow-black/5">
            <div className="p-5 border-b border-border/50 flex items-center justify-between">
              <h3 className="font-display font-bold text-lg">{t("studentDash.myDocuments")}</h3>
              <Badge variant="secondary">{documents?.length || 0}</Badge>
            </div>
            <div className="divide-y divide-border/50">
              {appsLoading ? (
                [...Array(3)].map((_, i) => <div key={i} className="p-4"><div className="h-10 bg-secondary animate-pulse rounded-xl" /></div>)
              ) : (documents || []).length === 0 ? (
                <div className="p-8 text-center text-muted-foreground">
                  <Upload className="w-10 h-10 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="font-medium">{t("studentDash.noDocuments")}</p>
                </div>
              ) : (documents || []).slice(0, 5).map(doc => (
                <div key={doc.id} className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                      <FileText className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-sm text-foreground">{doc.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{doc.type}</p>
                    </div>
                  </div>
                  <Badge className={
                    doc.status === 'approved' ? 'bg-green-500/10 text-green-600 border-green-200' :
                    doc.status === 'rejected' ? 'bg-rose-500/10 text-rose-600 border-rose-200' :
                    'bg-amber-500/10 text-amber-600 border-amber-200'
                  }>
                    {docStatusLabel(doc.status)}
                  </Badge>
                </div>
              ))}
            </div>
            <div className="p-4">
              <Button variant="outline" className="w-full rounded-xl gap-2" onClick={() => setLocation("/student/account")}>
                <Upload className="w-4 h-4" /> {t("studentDash.uploadDocument")}
              </Button>
            </div>
          </Card>

          <Card className="border-none shadow-lg shadow-black/5 p-6">
            <h3 className="font-display font-bold text-lg mb-5">{t("studentDash.yourAdvisor")}</h3>
            {advisorLoading ? (
              <div className="space-y-3">
                <div className="h-20 bg-secondary animate-pulse rounded-2xl" />
                <div className="h-10 bg-secondary animate-pulse rounded-xl" />
              </div>
            ) : advisor ? (
              <>
                <div className="flex items-center gap-4 p-5 rounded-2xl bg-primary/5 border border-primary/20 mb-5">
                  {advisor.avatarUrl ? (
                    <img src={advisor.avatarUrl} alt="" className="w-14 h-14 rounded-2xl object-cover shadow-md" />
                  ) : (
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center text-white font-display font-bold text-xl shadow-md">
                      {getInitials(advisor.firstName, advisor.lastName)}
                    </div>
                  )}
                  <div>
                    <p className="font-display font-bold text-foreground">{advisor.firstName} {advisor.lastName}</p>
                    <p className="text-muted-foreground text-sm">{formatRole(advisor.role, t("studentDash.consultant"))}</p>
                    {advisor.email && (
                      <p className="text-primary text-sm font-semibold mt-1 flex items-center gap-1">
                        <Mail className="w-3.5 h-3.5" /> {advisor.email}
                      </p>
                    )}
                  </div>
                </div>
                {advisor.phone && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 rounded-xl bg-secondary/40 mb-4">
                    <Phone className="w-4 h-4 text-primary" />
                    <span>{advisor.phone}</span>
                  </div>
                )}
                <Button
                  className="w-full rounded-xl gap-2 bg-gradient-to-r from-primary to-accent hover:opacity-90"
                  onClick={() => setLocation("/student/messages")}
                >
                  <MessageSquare className="w-4 h-4" /> {t("studentDash.messageAdvisor")}
                </Button>
              </>
            ) : (
              <div className="text-center py-6 text-muted-foreground">
                <User className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p className="font-medium">{t("studentDash.noAdvisor")}</p>
                <p className="text-xs mt-1">{t("studentDash.advisorWillBeAssigned")}</p>
              </div>
            )}
          </Card>
        </div>
      </div>
  );
}
