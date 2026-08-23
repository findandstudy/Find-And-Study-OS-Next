import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DollarSign, CheckCircle, Banknote, Receipt } from "lucide-react";
import { TablePagination, useTablePagination } from "@/components/TablePagination";
import { useI18n } from "@/hooks/use-i18n";
import { formatDate } from "@/lib/i18n";
import { CurrencySelector } from "@/components/CurrencySelector";
import { useCurrencyPreference } from "@/hooks/use-currency-preference";
import { formatMoney, SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/currency";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export default function AgentCommissions() {
  const { t, lang } = useI18n();
  const { user } = useAuth(true);
  const { currency, setCurrency } = useCurrencyPreference("agent-commissions", "all");
  const pgComm = useTablePagination(25);
  const pgFee = useTablePagination(25);

  const { data: summary } = useQuery<any>({
    queryKey: ["agent-finance-summary", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/agent/finance-summary`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const commQs = currency === "all" ? "" : `&currency=${currency}`;
  const { data: commData, isLoading: commLoading } = useQuery({
    queryKey: ["agent-commissions", user?.id, currency],
    enabled: !!user,
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/agent/commissions?limit=200${commQs}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const { data: feeData, isLoading: feeLoading } = useQuery({
    queryKey: ["agent-service-fees", user?.id, currency],
    enabled: !!user,
    queryFn: async () => {
      const r = await fetch(`${BASE_URL}/api/agent/service-fees?limit=200${commQs}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const commissions: any[] = commData?.data || [];
  const isSubAgent: boolean = commData?.isSubAgent || false;
  const serviceFees: any[] = feeData?.data || [];
  const { paged: pagedComm, total: totalComm } = pgComm.paginate(commissions);
  const { paged: pagedFees, total: totalFees } = pgFee.paginate(serviceFees);

  const commByCur: Record<string, any> = summary?.commissions?.byCurrency || {};
  const feeByCur: Record<string, any> = summary?.serviceFees?.byCurrency || {};
  const activeCurrencies: CurrencyCode[] = currency === "all"
    ? (() => {
        const set = new Set<string>();
        Object.keys(commByCur).forEach(c => set.add(c));
        Object.keys(feeByCur).forEach(c => set.add(c));
        const arr = [...set].filter(c => (SUPPORTED_CURRENCIES as readonly string[]).includes(c)) as CurrencyCode[];
        return arr.length > 0 ? arr : ["USD"];
      })()
    : [currency as CurrencyCode];

  function renderCardValues(buckets: Record<string, any>, field: string) {
    return (
      <div className="space-y-0.5">
        {activeCurrencies.map(c => {
          const b = buckets[c] || {};
          const v = Number(b[field] || 0);
          return (
            <p key={c} className="text-base lg:text-lg font-display font-bold text-foreground leading-tight">
              {formatMoney(v, c, { maximumFractionDigits: 2, minimumFractionDigits: 0 })}
            </p>
          );
        })}
      </div>
    );
  }

  return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-display font-bold text-foreground flex items-center gap-2">
              <DollarSign className="w-6 h-6 text-primary" /> {t("agentCommissions.title")}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">{t("agentCommissions.subtitle")}</p>
          </div>
          <CurrencySelector value={currency} onChange={setCurrency} />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: t("agentCommissions.potentialCommission"), field: "potential", icon: DollarSign, color: "text-green-500 bg-green-500/10" },
            { label: t("agentCommissions.confirmedCommission"), field: "confirmed", icon: DollarSign, color: "text-amber-500 bg-amber-500/10" },
            { label: t("agentCommissions.commissionPaid"), field: "paid", icon: DollarSign, color: "text-blue-500 bg-blue-500/10" },
            { label: t("agentCommissions.pendingCommission"), field: "pending", icon: DollarSign, color: "text-purple-500 bg-purple-500/10" },
          ].map((s, i) => (
            <Card key={i} className="p-5 border-none shadow-md shadow-black/5 hover:-translate-y-1 transition-transform">
              <div className={`w-10 h-10 rounded-xl ${s.color} flex items-center justify-center mb-3`}>
                <s.icon className="w-5 h-5" />
              </div>
              <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">{s.label}</p>
              <div className="mt-1">{renderCardValues(commByCur, s.field)}</div>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: t("agentCommissions.potentialServiceFee"), field: "potential", icon: DollarSign, color: "text-green-500 bg-green-500/10" },
            { label: t("agentCommissions.confirmedServiceFee"), field: "confirmed", icon: DollarSign, color: "text-amber-500 bg-amber-500/10" },
            { label: t("agentCommissions.paidServiceFee"), field: "paid", icon: DollarSign, color: "text-blue-500 bg-blue-500/10" },
            { label: t("agentCommissions.pendingServiceFee"), field: "pending", icon: DollarSign, color: "text-purple-500 bg-purple-500/10" },
          ].map((s, i) => (
            <Card key={i} className="p-5 border-none shadow-md shadow-black/5 hover:-translate-y-1 transition-transform">
              <div className={`w-10 h-10 rounded-xl ${s.color} flex items-center justify-center mb-3`}>
                <s.icon className="w-5 h-5" />
              </div>
              <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider">{s.label}</p>
              <div className="mt-1">{renderCardValues(feeByCur, s.field)}</div>
            </Card>
          ))}
        </div>

        <Tabs defaultValue="commissions" className="space-y-4">
          <TabsList>
            <TabsTrigger value="commissions" className="gap-1.5"><Banknote className="w-4 h-4" /> {t("agentCommissions.commissionHistory")}</TabsTrigger>
            <TabsTrigger value="service-fees" className="gap-1.5"><Receipt className="w-4 h-4" /> {t("agentCommissions.serviceFeeHistory")}</TabsTrigger>
          </TabsList>

          <TabsContent value="commissions">
            <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
              <div className="p-5 border-b border-border/50">
                <h3 className="font-display font-bold text-lg">{t("agentCommissions.commissionHistory")}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-secondary/50 text-left">
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.student")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.university")}</th>
                      {!isSubAgent && <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.programFee")}</th>}
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.commission")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.paid")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.status")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.date")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {commLoading ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i}>
                          {[...Array(7)].map((_, j) => (
                            <td key={j} className="px-5 py-4"><div className="h-4 bg-secondary animate-pulse rounded-full" /></td>
                          ))}
                        </tr>
                      ))
                    ) : pagedComm.length === 0 ? (
                      <tr>
                        <td colSpan={isSubAgent ? 6 : 7} className="px-5 py-16 text-center">
                          <DollarSign className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
                          <p className="text-muted-foreground font-medium">{t("agentCommissions.noCommissions")}</p>
                        </td>
                      </tr>
                    ) : pagedComm.map((c: any) => {
                      const commAmt = isSubAgent ? c.subAgentCommissionAmount : c.agentCommissionAmount;
                      const commPaid = isSubAgent ? c.subAgentPaid : c.agentPaid;
                      return (
                      <tr key={c.id} className="hover:bg-secondary/30 transition-colors">
                        <td className="px-5 py-4 text-sm font-medium">{c.studentName || "—"}</td>
                        <td className="px-5 py-4 text-sm text-muted-foreground">{c.universityName || "—"}</td>
                        {!isSubAgent && <td className="px-5 py-4 text-sm font-medium">{c.programFee ? formatMoney(c.programFee, c.currency, { maximumFractionDigits: 2 }) : "—"}</td>}
                        <td className="px-5 py-4 text-sm font-bold text-primary">{commAmt ? formatMoney(commAmt, c.currency, { maximumFractionDigits: 2 }) : "—"}</td>
                        <td className="px-5 py-4 text-sm font-medium text-green-600">{commPaid && Number(commPaid) > 0 ? formatMoney(commPaid, c.currency, { maximumFractionDigits: 2 }) : "—"}</td>
                        <td className="px-5 py-4">
                          <Badge className={
                            c.status === "potential" ? "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50" :
                            c.status === "confirmed" ? "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700/60" :
                            c.status === "collected_partial" ? "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60" :
                            c.status === "collected_full" ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60" :
                            "bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50"
                          }>
                            {c.status?.replace(/_/g, " ")}
                          </Badge>
                        </td>
                        <td className="px-5 py-4 text-sm text-muted-foreground">
                          {formatDate(lang, c.createdAt, { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <TablePagination
                currentPage={pgComm.page}
                totalItems={totalComm}
                pageSize={pgComm.pageSize}
                onPageChange={pgComm.setPage}
                onPageSizeChange={pgComm.setPageSize}
              />
            </Card>
          </TabsContent>

          <TabsContent value="service-fees">
            <Card className="border-none shadow-lg shadow-black/5 overflow-hidden">
              <div className="p-5 border-b border-border/50">
                <h3 className="font-display font-bold text-lg">{t("agentCommissions.serviceFeeHistory")}</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-secondary/50 text-left">
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.student")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.university")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.total")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.firstInstallment")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.secondInstallment")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.status")}</th>
                      <th className="px-5 py-4 text-xs font-bold text-muted-foreground uppercase tracking-wider">{t("agentCommissions.date")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {feeLoading ? (
                      [...Array(4)].map((_, i) => (
                        <tr key={i}>
                          {[...Array(7)].map((_, j) => (
                            <td key={j} className="px-5 py-4"><div className="h-4 bg-secondary animate-pulse rounded-full" /></td>
                          ))}
                        </tr>
                      ))
                    ) : pagedFees.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-5 py-16 text-center">
                          <Receipt className="w-12 h-12 text-muted-foreground/20 mx-auto mb-3" />
                          <p className="text-muted-foreground font-medium">{t("agentCommissions.noServiceFees")}</p>
                        </td>
                      </tr>
                    ) : pagedFees.map((f: any) => (
                      <tr key={f.id} className="hover:bg-secondary/30 transition-colors">
                        <td className="px-5 py-4 text-sm font-medium">{f.studentName || "—"}</td>
                        <td className="px-5 py-4 text-sm text-muted-foreground">{f.universityName || "—"}</td>
                        <td className="px-5 py-4 text-sm font-bold text-primary">{formatMoney(f.totalAmount, f.currency, { maximumFractionDigits: 2 })}</td>
                        <td className="px-5 py-4 text-sm">
                          {f.firstInstallmentAmount ? (
                            <span className={f.firstInstallmentPaidAt ? "text-green-600 font-medium" : "text-muted-foreground"}>
                              {formatMoney(f.firstInstallmentAmount, f.currency, { maximumFractionDigits: 2 })}
                              {f.firstInstallmentPaidAt && <CheckCircle className="w-3 h-3 inline ml-1" />}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-5 py-4 text-sm">
                          {f.secondInstallmentAmount ? (
                            <span className={f.secondInstallmentPaidAt ? "text-green-600 font-medium" : "text-muted-foreground"}>
                              {formatMoney(f.secondInstallmentAmount, f.currency, { maximumFractionDigits: 2 })}
                              {f.secondInstallmentPaidAt && <CheckCircle className="w-3 h-3 inline ml-1" />}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-5 py-4">
                          <Badge className={
                            f.status === "paid" ? "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-300 dark:border-green-700/60" :
                            f.status === "partial" ? "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700/60" :
                            "bg-gray-100 text-gray-600 border-gray-200 dark:bg-gray-800/50 dark:text-gray-300 dark:border-gray-600/50"
                          }>
                            {f.status}
                          </Badge>
                        </td>
                        <td className="px-5 py-4 text-sm text-muted-foreground">
                          {formatDate(lang, f.createdAt, { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <TablePagination
                currentPage={pgFee.page}
                totalItems={totalFees}
                pageSize={pgFee.pageSize}
                onPageChange={pgFee.setPage}
                onPageSizeChange={pgFee.setPageSize}
              />
            </Card>
          </TabsContent>
        </Tabs>
      </div>
  );
}
