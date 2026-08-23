import { useState, useEffect, useMemo } from "react";
import { useGetOverviewStats, useGetActivitySummary, useGetKommoSummary, useListUsers } from "@workspace/api-client-react";
import { formatDate } from "@workspace/i18n";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { OfferDeadlinesWidget } from "@/components/OfferDeadlinesWidget";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Users, FileText, GraduationCap, DollarSign, TrendingUp,
  AlertTriangle, Activity, Shield, CalendarClock, ExternalLink,
  Bell, UserPlus, FileCheck, CreditCard, MessageCircle, Megaphone,
  AlertCircle, ArrowUpRight, Timer, Trophy, TrendingDown, Target, Zap,
} from "lucide-react";
import { formatMoney } from "@/lib/currency";
import { formatDuration } from "@/lib/formatDuration";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { Link } from "wouter";
import { useI18n } from "@/hooks/use-i18n";
import { useSeason } from "@/contexts/SeasonContext";
import { localizeNotification } from "@/lib/notificationLocalization";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
function isOverdue(d: string) { return new Date(d) < new Date(); }

function toArray(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const data = (value as any).data;
    if (Array.isArray(data)) return data;
    const items = (value as any).items;
    if (Array.isArray(items)) return items;
  }
  return [];
}

const AVATAR_COLORS = [
  "bg-blue-500/15 text-blue-600",
  "bg-purple-500/15 text-purple-600",
  "bg-emerald-500/15 text-emerald-600",
  "bg-amber-500/15 text-amber-600",
  "bg-rose-500/15 text-rose-600",
  "bg-cyan-500/15 text-cyan-600",
];

function getInitials(firstName?: string, lastName?: string) {
  return `${(firstName || "?")[0]}${(lastName || "?")[0]}`.toUpperCase();
}

import { formatTimeAgo as i18nTimeAgo } from "@/lib/i18n";

const NOTIFICATION_ICONS: Record<string, typeof Bell> = {
  "lead.created": UserPlus,
  "lead.assigned": Users,
  "lead.stage_changed": Activity,
  "lead.follow_up_due": CalendarClock,
  "application.created": FileText,
  "application.stage_changed": FileCheck,
  "application.offer_received": GraduationCap,
  "application.visa_update": FileCheck,
  "student.created": GraduationCap,
  "student.document_uploaded": FileText,
  "student.status_changed": Activity,
  "finance.commission_confirmed": CreditCard,
  "finance.payment_received": DollarSign,
  "finance.payment_due": AlertCircle,
  "finance.agent_payout": CreditCard,
  "agent.new_registration": UserPlus,
  "agent.sub_agent_added": Users,
  "system.user_activated": Shield,
  "system.broadcast": Megaphone,
  "system.announcement": Megaphone,
  "message.new": MessageCircle,
  "message.mention": MessageCircle,
};

type ActivityRange = "daily" | "weekly" | "monthly" | "yearly";

const STAFF_ROLES_SET = new Set(["super_admin","admin","manager","staff","consultant","editor","accountant","agent_staff"]);
const ADMIN_ROLES_SET = new Set(["super_admin","admin","manager"]);

function fmtSec(sec: number | undefined | null): string {
  const s = sec ?? 0;
  if (s === 0) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function kommoRangeDates(range: ActivityRange): { from: string; to: string } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case "daily": return { from: today.toISOString(), to: now.toISOString() };
    case "weekly": {
      const d = new Date(today); d.setDate(d.getDate() - 7);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    case "monthly": {
      const d = new Date(today); d.setDate(d.getDate() - 30);
      return { from: d.toISOString(), to: now.toISOString() };
    }
    case "yearly": {
      const d = new Date(today); d.setFullYear(d.getFullYear() - 1);
      return { from: d.toISOString(), to: now.toISOString() };
    }
  }
}

function StaffPersonCard({
  user,
  activeSec,
  idleSec,
  loading,
  t,
}: {
  user: any;
  activeSec: number;
  idleSec: number;
  loading: boolean;
  t: (k: any) => string;
}) {
  const colorIdx = user ? (user.id % AVATAR_COLORS.length) : 0;
  return (
    <div className="flex items-center gap-3 p-3.5 rounded-xl bg-gradient-to-r from-secondary/40 to-secondary/20 border border-border/50">
      <div className={`w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold shrink-0 ${AVATAR_COLORS[colorIdx]}`}>
        {getInitials(user?.firstName, user?.lastName)}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">
          {user?.firstName} {user?.lastName}
        </p>
        <Badge variant="outline" className="text-[10px] capitalize mt-0.5 h-4 px-1.5">{user?.role}</Badge>
      </div>
      <div className="text-right shrink-0">
        <div className="flex items-center justify-end gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
          <span className="text-xs font-mono font-semibold tabular-nums">
            {loading ? "…" : fmtSec(activeSec)}
          </span>
        </div>
        <div className="flex items-center justify-end gap-1.5 mt-1">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
          <span className="text-xs font-mono text-muted-foreground tabular-nums">
            {loading ? "…" : fmtSec(idleSec)}
          </span>
        </div>
        <p className="text-[9px] text-muted-foreground mt-0.5 text-right">{t("adminDash.activeDur")} / {t("adminDash.idleDur")}</p>
      </div>
    </div>
  );
}

interface UserActivityPanelProps {
  range: ActivityRange;
  currentUserId: number | undefined;
  isAdmin: boolean;
  expandable?: boolean;
}

function UserActivityPanel({ range, currentUserId, isAdmin, expandable = false }: UserActivityPanelProps) {
  const { t } = useI18n();
  const [localRange, setLocalRange] = useState<ActivityRange>(range);
  const [staffId, setStaffId] = useState<number | undefined>(undefined);

  useEffect(() => { setLocalRange(range); }, [range]);

  const staffQuery = useListUsers({ roles: [...STAFF_ROLES_SET].join(","), limit: 200 } as any);
  const staffList = useMemo(() => {
    const d = staffQuery.data as any;
    const arr: any[] = Array.isArray(d) ? d : (d?.data ?? d?.items ?? []);
    return arr.filter((u: any) => STAFF_ROLES_SET.has(u.role));
  }, [staffQuery.data]);

  const effectiveStaffId = isAdmin ? staffId : currentUserId;

  const activityQ = useGetActivitySummary({ range: localRange, staffId: effectiveStaffId });
  const act = activityQ.data as any;
  const loadingAct = activityQ.isLoading;

  const { from: komFrom, to: komTo } = useMemo(() => kommoRangeDates(localRange), [localRange]);
  const kommoQ = useGetKommoSummary({ from: komFrom, to: komTo, staffId: effectiveStaffId });
  const kom = kommoQ.data as any;
  const loadingKom = kommoQ.isLoading;

  const selectedUser = useMemo(
    () => effectiveStaffId ? (staffList.find((u: any) => u.id === effectiveStaffId) ?? null) : null,
    [staffList, effectiveStaffId],
  );

  const topKommo = [
    { label: t("adminDash.avgReply"),    value: fmtSec(kom?.avgReplyTime),    icon: Zap,    color: "text-amber-500 bg-amber-50 dark:bg-amber-500/10" },
    { label: t("adminDash.medianReply"), value: fmtSec(kom?.medianReplyTime), icon: Timer,  color: "text-blue-500 bg-blue-50 dark:bg-blue-500/10" },
    { label: t("adminDash.activeLeads"), value: String(kom?.activeLeads ?? 0), icon: Target, color: "text-green-500 bg-green-50 dark:bg-green-500/10" },
  ];

  const botKommo = [
    { label: t("adminDash.wonLeads"),  value: String(kom?.wonLeads ?? 0),  icon: Trophy,      color: "text-emerald-500 bg-emerald-50 dark:bg-emerald-500/10" },
    { label: t("adminDash.lostLeads"), value: String(kom?.lostLeads ?? 0), icon: TrendingDown, color: "text-rose-500 bg-rose-50 dark:bg-rose-500/10" },
    { label: t("adminDash.totalMsgs"), value: String((kom?.incomingMessages ?? 0) + (kom?.outgoingMessages ?? 0)), icon: MessageCircle, color: "text-cyan-500 bg-cyan-50 dark:bg-cyan-500/10" },
  ];

  const viewMetrics = [
    { label: t("adminDash.leadsViewedMetric"),    value: act?.leadsViewed ?? 0,        icon: Users,         color: "text-blue-500" },
    { label: t("adminDash.studentsViewedMetric"),  value: act?.studentsViewed ?? 0,      icon: GraduationCap, color: "text-purple-500" },
    { label: t("adminDash.appsViewedMetric"),      value: act?.applicationsViewed ?? 0,  icon: FileText,      color: "text-emerald-500" },
    { label: t("adminDash.msgsNotConnected"),      value: "—",                           icon: MessageCircle, color: "text-cyan-500" },
  ];

  return (
    <Card className="p-5 border-none shadow-lg shadow-black/5 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Activity className="w-3.5 h-3.5 text-primary" />
          </div>
          <h3 className="font-display font-bold text-base">{t("adminDash.activityPanelTitle")}</h3>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Select value={localRange} onValueChange={(v) => setLocalRange(v as ActivityRange)}>
            <SelectTrigger className="h-7 text-xs w-28 rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="daily">{t("adminDash.rangeDaily")}</SelectItem>
              <SelectItem value="weekly">{t("adminDash.rangeWeekly")}</SelectItem>
              <SelectItem value="monthly">{t("adminDash.rangeMonthly")}</SelectItem>
              <SelectItem value="yearly">{t("adminDash.rangeYearly")}</SelectItem>
            </SelectContent>
          </Select>
          {isAdmin && (
            <Select
              value={staffId !== undefined ? String(staffId) : "all"}
              onValueChange={(v) => setStaffId(v === "all" ? undefined : Number(v))}
            >
              <SelectTrigger className="h-7 text-xs w-36 rounded-lg">
                <SelectValue placeholder={t("adminDash.staffAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("adminDash.staffAll")}</SelectItem>
                {staffList.map((u: any) => (
                  <SelectItem key={u.id} value={String(u.id)}>
                    {u.firstName} {u.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* Top 3 Kommo metrics */}
      <div className="grid grid-cols-3 gap-2">
        {topKommo.map((m, i) => (
          <div key={i} className="p-2.5 rounded-xl bg-secondary/30 border border-border/40 text-center">
            <div className={`w-6 h-6 rounded-lg ${m.color} flex items-center justify-center mx-auto mb-1`}>
              <m.icon className="w-3 h-3" />
            </div>
            <p className="text-sm font-bold font-mono tabular-nums leading-tight">
              {loadingKom ? "…" : m.value}
            </p>
            <p className="text-[9px] text-muted-foreground leading-tight mt-0.5 truncate">{m.label}</p>
          </div>
        ))}
      </div>

      {/* Staff person card */}
      {selectedUser ? (
        <StaffPersonCard
          user={selectedUser}
          activeSec={act?.activeDurationSeconds ?? 0}
          idleSec={act?.idleDurationSeconds ?? 0}
          loading={loadingAct}
          t={t}
        />
      ) : (
        <div className="flex items-center gap-3 p-3.5 rounded-xl bg-secondary/30 border border-border/50 border-dashed">
          <div className="w-11 h-11 rounded-full bg-secondary flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-muted-foreground">
              {isAdmin ? t("adminDash.staffAll") : t("adminDash.activityPanelTitle")}
            </p>
            <p className="text-xs text-muted-foreground/70 mt-0.5">
              {t("adminDash.activeDur")}: <span className="font-mono font-semibold">{loadingAct ? "…" : fmtSec(act?.activeDurationSeconds)}</span>
              {" · "}
              {t("adminDash.idleDur")}: <span className="font-mono">{loadingAct ? "…" : fmtSec(act?.idleDurationSeconds)}</span>
            </p>
          </div>
        </div>
      )}

      {/* View metrics 2x2 */}
      <div className="grid grid-cols-2 gap-2">
        {viewMetrics.map((m, i) => (
          <div key={i} className="flex items-center gap-2 p-2.5 rounded-xl bg-secondary/20 border border-border/30">
            <m.icon className={`w-3.5 h-3.5 shrink-0 ${m.color}`} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-bold font-mono tabular-nums">
                {i === 3 ? m.value : (loadingAct ? "…" : String(m.value))}
              </p>
              <p className="text-[9px] text-muted-foreground truncate leading-tight">{m.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom 3 Kommo metrics */}
      <div className="grid grid-cols-3 gap-2">
        {botKommo.map((m, i) => (
          <div key={i} className="p-2.5 rounded-xl bg-secondary/30 border border-border/40 text-center">
            <div className={`w-6 h-6 rounded-lg ${m.color} flex items-center justify-center mx-auto mb-1`}>
              <m.icon className="w-3 h-3" />
            </div>
            <p className="text-sm font-bold font-mono tabular-nums leading-tight">
              {loadingKom ? "…" : m.value}
            </p>
            <p className="text-[9px] text-muted-foreground leading-tight mt-0.5 truncate">{m.label}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function AdminDashboard() {
  const { t, lang } = useI18n();
  const timeAgo = (d: string) => i18nTimeAgo(lang, d);
  const { user } = useAuth(true);
  const { season } = useSeason();
  const showOfferDeadlines = user?.role !== "super_admin";
  const isAdmin = ADMIN_ROLES_SET.has(user?.role || "");

  const [trendRange, setTrendRange] = useState<ActivityRange>("monthly");
  const [followUpFilter, setFollowUpFilter] = useState<string>("all");

  const { data: stats, isLoading } = useGetOverviewStats({ season });

  const { data: growthRaw } = useQuery<unknown>({
    queryKey: ["/api/stats/growth", season],
    queryFn: () =>
      fetch(`${BASE}/api/stats/growth?season=${encodeURIComponent(season)}`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => []),
  });
  const growthData: any[] = toArray(growthRaw);

  const followUpCreatedById = followUpFilter === "all" ? null
    : followUpFilter === "mine" ? (user?.id ?? null)
    : parseInt(followUpFilter, 10) || null;

  const { data: upcomingRaw } = useQuery<unknown>({
    queryKey: ["/api/follow-ups/upcoming", followUpCreatedById],
    queryFn: () => {
      const url = new URL(`${BASE}/api/follow-ups/upcoming`, window.location.href);
      if (followUpCreatedById != null) url.searchParams.set("createdById", String(followUpCreatedById));
      return fetch(url.toString(), { credentials: "include" }).then(r => r.json()).catch(() => []);
    },
  });
  const upcomingFollowUps: any[] = toArray(upcomingRaw);

  const { data: staffUsersRaw } = useListUsers({ roles: "super_admin,admin,manager,staff,consultant,editor,accountant", limit: 200 } as any);

  const { data: latestStudentsRaw } = useQuery<unknown>({
    queryKey: ["/api/students", "dashboard-latest"],
    queryFn: () =>
      fetch(`${BASE}/api/students?limit=20&page=1`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => ({ data: [] })),
  });
  const latestStudents: any[] = toArray(latestStudentsRaw);

  const { data: latestAuditRaw } = useQuery<unknown>({
    queryKey: ["/api/audit", "dashboard-latest"],
    queryFn: () =>
      fetch(`${BASE}/api/audit?limit=20&page=1`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => ({ data: [] })),
  });
  const latestUpdates: any[] = toArray(latestAuditRaw);

  const { data: notificationsRaw } = useQuery<unknown>({
    queryKey: ["/api/notifications", "dashboard-latest"],
    queryFn: () =>
      fetch(`${BASE}/api/notifications?limit=5`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => ({ data: [] })),
  });
  const latestNotifications: any[] = toArray(notificationsRaw);

  const { data: contractAgentsRaw } = useQuery<unknown>({
    queryKey: ["/api/agents/contract-alerts"],
    queryFn: () =>
      fetch(`${BASE}/api/agents/contract-alerts`, { credentials: "include" })
        .then(r => r.json())
        .catch(() => []),
  });
  const contractAgents: any[] = toArray(contractAgentsRaw);

  const s: any = stats || {};
  const statCards = [
    { label: t("adminDash.totalLeads"), value: s.totalLeads || 0, icon: Users, color: "text-blue-500", bg: "bg-blue-500/10", href: "/staff/leads" },
    { label: t("adminDash.activeApplications"), value: s.activeApplications || 0, icon: FileText, color: "text-purple-500", bg: "bg-purple-500/10", href: "/staff/applications" },
    { label: t("adminDash.studentsEnrolled"), value: s.enrolledStudents || 0, icon: GraduationCap, color: "text-green-500", bg: "bg-green-500/10", href: "/staff/students" },
    { label: t("adminDash.revenueMonth"), value: s.monthlyRevenueByCurrency || { USD: s.monthlyRevenue || 0 }, icon: DollarSign, color: "text-amber-500", bg: "bg-amber-500/10", isMoney: true, href: "/staff/finance" },
  ];

  const RANGE_LABELS: Record<ActivityRange, string> = {
    daily: t("adminDash.rangeDaily"),
    weekly: t("adminDash.rangeWeekly"),
    monthly: t("adminDash.rangeMonthly"),
    yearly: t("adminDash.rangeYearly"),
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-foreground">{t("adminDash.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("adminDash.subtitle")}</p>
        </div>
        <Badge className="bg-primary/10 text-primary border-primary/20 px-4 py-2 text-sm font-semibold">
          <Shield className="w-4 h-4 mr-2" /> {t("adminDash.adminAccess")}
        </Badge>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {statCards.map((sc: any, i) => (
          <Link key={i} href={sc.href}>
            <Card className="p-6 border-none shadow-lg shadow-black/5 hover:-translate-y-1 transition-transform duration-300 group cursor-pointer">
              <div className="flex items-start justify-between mb-4">
                <div className={`w-12 h-12 rounded-xl ${sc.bg} flex items-center justify-center group-hover:scale-110 transition-transform`}>
                  <sc.icon className={`w-6 h-6 ${sc.color}`} />
                </div>
              </div>
              <p className="text-sm font-medium text-muted-foreground">{sc.label}</p>
              {sc.isMoney ? (
                <div className="mt-1 space-y-0.5">
                  {(() => {
                    const entries = Object.entries(sc.value as Record<string, number>).filter(([, v]) => v !== 0);
                    if (entries.length === 0) entries.push(["USD", 0]);
                    return entries.map(([cur, v]) => (
                      <p key={cur} className="text-2xl font-display font-bold text-foreground leading-tight">
                        {isLoading ? "..." : formatMoney(v as number, cur)}
                      </p>
                    ));
                  })()}
                </div>
              ) : (
                <p className="text-3xl font-display font-bold text-foreground mt-1">
                  {isLoading ? "..." : sc.value}
                </p>
              )}
            </Card>
          </Link>
        ))}
      </div>

      {/* Contract Alerts */}
      {contractAgents.length > 0 && (
        <Card className="p-5 border-none shadow-lg shadow-black/5 bg-gradient-to-r from-orange-50 to-red-50 dark:from-orange-950/20 dark:to-red-950/20">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
            </div>
            <div>
              <h3 className="font-display font-bold text-sm">{t("adminDash.contractAlerts")}</h3>
              <p className="text-xs text-muted-foreground">{t("adminDash.agentsNeedAttention", { count: contractAgents.length })}</p>
            </div>
            <Link href="/admin/agents" className="ml-auto">
              <Badge variant="outline" className="text-xs cursor-pointer hover:bg-primary/10 gap-1">
                {t("adminDash.viewAll")} <ArrowUpRight className="w-3 h-3" />
              </Badge>
            </Link>
          </div>
          <div className="space-y-2">
            {contractAgents.slice(0, 4).map((a: any) => {
              const daysLeft = Math.ceil((new Date(a.contractEndDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
              const isExpired = daysLeft <= 0;
              return (
                <div key={a.id} className="flex items-center justify-between p-2.5 rounded-lg bg-white/60 dark:bg-card/40 border border-border/50">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isExpired ? "bg-red-500" : "bg-orange-500 animate-pulse"}`} />
                    <span className="text-sm font-medium">{a.firstName} {a.lastName}</span>
                    {a.companyName && <span className="text-xs text-muted-foreground">({a.companyName})</span>}
                  </div>
                  <Badge variant="outline" className={`text-xs ${isExpired ? "bg-red-500/10 text-red-600 border-red-200" : "bg-orange-500/10 text-orange-600 border-orange-200"}`}>
                    {isExpired ? t("common.expiredAgo", { n: Math.abs(daysLeft) }) : t("common.daysLeft", { n: daysLeft })}
                  </Badge>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Quick Nav */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {[
          { label: "Users", icon: Users, href: "/admin/users", color: "text-blue-500 bg-blue-500/10" },
          { label: "Leads", icon: Users, href: "/staff/leads", color: "text-purple-500 bg-purple-500/10" },
          { label: "Applications", icon: FileText, href: "/staff/applications", color: "text-green-500 bg-green-500/10" },
          { label: "Finance", icon: DollarSign, href: "/staff/finance", color: "text-amber-500 bg-amber-500/10" },
          { label: "Settings", icon: Shield, href: "/admin/settings", color: "text-primary bg-primary/10" },
          { label: "Audit Log", icon: Activity, href: "/admin/audit", color: "text-rose-500 bg-rose-500/10" },
        ].map((item, i) => (
          <Link key={i} href={item.href}>
            <Card className="p-5 text-center border-none shadow-md shadow-black/5 hover:-translate-y-1 hover:shadow-lg transition-[transform,box-shadow] duration-200 cursor-pointer group">
              <div className={`w-12 h-12 rounded-xl ${item.color} flex items-center justify-center mx-auto mb-3 group-hover:scale-110 transition-transform`}>
                <item.icon className="w-5 h-5" />
              </div>
              <p className="text-sm font-semibold text-foreground">{item.label}</p>
            </Card>
          </Link>
        ))}
      </div>

      {/* ── Upper row: Latest Students / Latest Updates / Notifications ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Latest Students */}
        <Card className="p-6 border-none shadow-lg shadow-black/5">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
              <GraduationCap className="w-4 h-4 text-green-500" />
            </div>
            <h3 className="font-display font-bold text-base">Latest Students</h3>
          </div>
          <div className="space-y-3 max-h-[320px] overflow-y-auto">
            {latestStudents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No students yet.</p>
            ) : (
              latestStudents.map((st: any, i: number) => (
                <Link key={st.id} href={`/staff/students/${st.id}`}>
                  <div className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors cursor-pointer group">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 overflow-hidden ${AVATAR_COLORS[i % AVATAR_COLORS.length]}`}>
                      <img
                        src={st.photoUrl || `${BASE}/api/students/${st.id}/photo/thumbnail`}
                        alt={`${st.firstName} ${st.lastName}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          const el = e.target as HTMLImageElement;
                          el.style.display = "none";
                          el.parentElement!.textContent = getInitials(st.firstName, st.lastName);
                        }}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-foreground truncate uppercase">
                        {st.firstName} {st.lastName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDate(st.createdAt, lang)}{", "}
                        {new Date(st.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                      </p>
                    </div>
                    <Badge variant="secondary" className="text-[10px] w-6 h-6 rounded-full p-0 flex items-center justify-center shrink-0 bg-primary/10 text-primary font-bold">
                      {i + 1}
                    </Badge>
                  </div>
                </Link>
              ))
            )}
          </div>
        </Card>

        {/* Latest Updates */}
        <Card className="p-6 border-none shadow-lg shadow-black/5">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <Activity className="w-4 h-4 text-purple-500" />
            </div>
            <h3 className="font-display font-bold text-base">Latest Updates</h3>
          </div>
          <div className="space-y-3 max-h-[320px] overflow-y-auto">
            {latestUpdates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent updates.</p>
            ) : (
              latestUpdates.map((u: any, i: number) => {
                const detailHref = u.resource && u.resourceId
                  ? `/staff/${u.resource === "application" ? "applications" : u.resource === "student" ? "students" : u.resource === "lead" ? "leads" : ""}/${u.resourceId}`
                  : null;
                const actionLabel = (u.action || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                const resourceLabel = (u.resource || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
                const changes = u.data ? Object.entries(u.data).filter(([k]) => !["id", "updatedAt"].includes(k)).slice(0, 2).map(([k, v]) => `${k}: ${v}`).join(", ") : "";
                const Wrapper = detailHref ? Link : "div" as any;
                const wrapperProps = detailHref ? { href: detailHref } : {};
                return (
                  <Wrapper key={u.id} {...wrapperProps}>
                    <div className={`flex items-start gap-3 p-2.5 rounded-xl hover:bg-secondary/50 transition-colors ${detailHref ? "cursor-pointer" : ""}`}>
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5 ${AVATAR_COLORS[(i + 2) % AVATAR_COLORS.length]}`}>
                        {u.userName ? u.userName.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase() : "SY"}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground truncate">{u.userName || "System"}</p>
                        <p className="text-xs text-foreground/80 font-medium mt-0.5">
                          {actionLabel}{resourceLabel ? ` — ${resourceLabel}` : ""}
                          {u.resourceId ? ` #${u.resourceId}` : ""}
                        </p>
                        {changes && <p className="text-[11px] text-foreground/65 dark:text-foreground/75 line-clamp-1 mt-0.5">{changes}</p>}
                      </div>
                      <div className="flex flex-col items-end shrink-0 mt-1">
                        <span className="text-[10px] text-foreground/60 dark:text-foreground/70 whitespace-nowrap">{timeAgo(u.createdAt)}</span>
                        {detailHref && <ArrowUpRight className="w-3 h-3 text-muted-foreground mt-1" />}
                      </div>
                    </div>
                  </Wrapper>
                );
              })
            )}
          </div>
        </Card>

        {/* Notifications */}
        <Card className="p-6 border-none shadow-lg shadow-black/5">
          <div className="flex items-center gap-2 mb-5">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Bell className="w-4 h-4 text-amber-500" />
            </div>
            <h3 className="font-display font-bold text-base">Notifications</h3>
          </div>
          <div className="space-y-3 max-h-[320px] overflow-y-auto">
            {latestNotifications.length === 0 ? (
              <p className="text-sm text-muted-foreground">No notifications.</p>
            ) : (
              latestNotifications.map((n: any) => {
                const NIcon = NOTIFICATION_ICONS[n.type] || Bell;
                const localized = localizeNotification(n, lang);
                return (
                  <div key={n.id} className={`p-3 rounded-xl border transition-colors ${n.isRead ? "bg-secondary/20 border-border/50" : "bg-primary/5 border-primary/20"}`}>
                    <div className="flex items-start gap-2.5">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${n.isRead ? "bg-muted/50" : "bg-primary/10"}`}>
                        <NIcon className={`w-3.5 h-3.5 ${n.isRead ? "text-muted-foreground" : "text-primary"}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium line-clamp-1 ${n.isRead ? "text-foreground/75 dark:text-foreground/80" : "text-foreground"}`}>{localized.title}</p>
                        {localized.body && <p className="text-xs text-foreground/65 dark:text-foreground/75 line-clamp-2 mt-0.5">{localized.body}</p>}
                      </div>
                      <span className="text-[10px] text-foreground/60 dark:text-foreground/70 whitespace-nowrap shrink-0 mt-0.5">{timeAgo(n.createdAt)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>
      </div>

      {/* Offer Deadlines */}
      {showOfferDeadlines && <OfferDeadlinesWidget detailHrefPrefix="/staff/applications" />}

      {/* ── Middle-bottom: Trends | UserActivityPanel | Follow-ups ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Col 1: Lead & Application Trends (narrowed, left) */}
        <Card className="p-6 border-none shadow-lg shadow-black/5 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-5">
            <h3 className="font-display font-bold text-base leading-tight">{t("adminDash.trendsTitle")}</h3>
            <Select value={trendRange} onValueChange={(v) => setTrendRange(v as ActivityRange)}>
              <SelectTrigger className="h-7 text-xs w-32 rounded-lg shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">{t("adminDash.rangeDaily")}</SelectItem>
                <SelectItem value="weekly">{t("adminDash.rangeWeekly")}</SelectItem>
                <SelectItem value="monthly">{t("adminDash.rangeMonthly")}</SelectItem>
                <SelectItem value="yearly">{t("adminDash.rangeYearly")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={growthData} margin={{ top: 10, right: 8, left: -24, bottom: 0 }}>
                <defs>
                  <linearGradient id="admLeads" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="admApps" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--accent))" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="hsl(var(--accent))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", borderRadius: "12px", border: "1px solid hsl(var(--border))" }} />
                <Area type="monotone" dataKey="leads" name="Leads" stroke="hsl(var(--primary))" strokeWidth={2.5} fillOpacity={1} fill="url(#admLeads)" />
                <Area type="monotone" dataKey="applications" name="Applications" stroke="hsl(var(--accent))" strokeWidth={2.5} fillOpacity={1} fill="url(#admApps)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          {/* Legend */}
          <div className="flex items-center gap-4 mt-3 justify-center">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 rounded-full bg-primary inline-block" />
              <span className="text-[11px] text-muted-foreground">Leads</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-1.5 rounded-full bg-accent inline-block" />
              <span className="text-[11px] text-muted-foreground">Applications</span>
            </div>
          </div>
        </Card>

        {/* Col 2: User Activity Panel (center, new) */}
        <UserActivityPanel
          range={trendRange}
          currentUserId={user?.id}
          isAdmin={isAdmin}
          expandable
        />

        {/* Col 3: Upcoming Follow-ups (right, preserved) */}
        <Card className="p-6 border-none shadow-lg shadow-black/5">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-primary" />
              <h3 className="font-display font-bold text-lg">{t("adminDash.upcomingFollowUps")}</h3>
            </div>
            {isAdmin && (
              <Select value={followUpFilter} onValueChange={setFollowUpFilter}>
                <SelectTrigger className="h-7 text-xs w-36 shrink-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("adminDash.fuFilterAll")}</SelectItem>
                  <SelectItem value="mine">{t("adminDash.fuFilterMine")}</SelectItem>
                  {(toArray((staffUsersRaw as any)?.data ?? staffUsersRaw)).map((u: any) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.firstName} {u.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-3">
            {upcomingFollowUps.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("adminDash.noFollowUps")}</p>
            ) : (
              upcomingFollowUps.slice(0, 5).map((fu: any) => (
                <Link key={fu.id} href={fu.leadId ? `/staff/leads/${fu.leadId}` : fu.studentId ? `/staff/students/${fu.studentId}` : "#"}>
                  <div className={`p-3 rounded-xl border cursor-pointer hover:scale-[1.02] transition-transform ${
                    isOverdue(fu.scheduledAt) ? "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800" : "bg-secondary/30 border-border"
                  }`}>
                    <div className="flex items-start justify-between">
                      <p className="text-sm font-medium text-foreground line-clamp-1">{fu.title}</p>
                      <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5" />
                    </div>
                    {fu.leadName && <p className="text-xs text-primary mt-0.5">{fu.leadName}</p>}
                    <p className={`text-xs mt-1 ${isOverdue(fu.scheduledAt) ? "text-red-600 font-semibold" : "text-muted-foreground"}`}>
                      {formatDate(fu.scheduledAt, lang)}
                      {" "}
                      {new Date(fu.scheduledAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}
                      {isOverdue(fu.scheduledAt) && " — Overdue"}
                    </p>
                    {(fu.updatedByName ?? fu.createdByName) && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {fu.updatedByName ? t("adminDash.followUpLastEditedBy", { name: fu.updatedByName }) : t("adminDash.followUpCreatedBy", { name: fu.createdByName })}
                      </p>
                    )}
                  </div>
                </Link>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
