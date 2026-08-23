import { useEffect, useState } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Search, IdCard, MapPin, Loader2 } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";

type StaffRow = {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  avatarUrl: string | null;
  isActive: boolean;
  locationCountry: string | null;
  locationCity: string | null;
  timezone: string | null;
};

export default function StaffCardsPage() {
  const { t } = useI18n();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const q = search ? `?search=${encodeURIComponent(search)}` : "";
    customFetch<{ data: StaffRow[] }>(`/api/staff-cards${q}`)
      .then((data) => { if (!cancelled) setRows(data.data || []); })
      .catch((err: any) => { if (!cancelled) setError(String(err?.message || err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [search]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <IdCard className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">{t("staffCards.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("staffCards.subtitle")}</p>
          </div>
        </div>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t("staffCards.searchPlaceholder")}
          className="pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-8 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-destructive">{error}</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">{t("staffCards.empty")}</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider">
              <tr>
                <th className="p-3">{t("staffCards.col.name")}</th>
                <th className="p-3">{t("staffCards.col.email")}</th>
                <th className="p-3">{t("staffCards.col.role")}</th>
                <th className="p-3">{t("staffCards.col.location")}</th>
                <th className="p-3">{t("staffCards.col.timezone")}</th>
                <th className="p-3">{t("staffCards.col.status")}</th>
                <th className="p-3 text-right">{t("staffCards.col.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/20">
                  <td className="p-3 font-medium">{[r.firstName, r.lastName].filter(Boolean).join(" ") || "—"}</td>
                  <td className="p-3 text-muted-foreground">{r.email}</td>
                  <td className="p-3"><Badge variant="secondary">{r.role}</Badge></td>
                  <td className="p-3 text-muted-foreground">
                    {r.locationCity || r.locationCountry ? (
                      <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{[r.locationCity, r.locationCountry].filter(Boolean).join(", ")}</span>
                    ) : "—"}
                  </td>
                  <td className="p-3 text-muted-foreground">{r.timezone || "—"}</td>
                  <td className="p-3">
                    <Badge variant={r.isActive ? "default" : "outline"}>
                      {r.isActive ? t("staffCards.active") : t("staffCards.inactive")}
                    </Badge>
                  </td>
                  <td className="p-3 text-right">
                    <Link href={`/admin/staff-cards/${r.id}`}>
                      <Button size="sm" variant="outline">{t("staffCards.openCard")}</Button>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
