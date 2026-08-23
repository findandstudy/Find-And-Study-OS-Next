import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/hooks/use-i18n";
import { Loader2, Download, FileSignature } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export default function MyContract() {
  const { t } = useI18n();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r: any = await customFetch("/api/contracts/me");
        setData(r.data);
      } catch {}
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="p-12 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  if (!data) return <div className="p-6 text-sm text-muted-foreground">{t("agentOnboarding.myContract.none") || "No contract on file."}</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><FileSignature className="w-6 h-6" /> {t("agentOnboarding.myContract.title") || "My Contract"}</h1>
        <p className="text-sm text-muted-foreground mt-1">{data.template?.name}</p>
      </div>
      <Card className="p-6 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("agentOnboarding.myContract.status") || "Status"}:</span>
          {data.status === "signed" ? (
            <Badge variant="outline">{t("agentOnboarding.myContract.signed") || "Signed"}</Badge>
          ) : data.status === "expired" || data.status === "revoked" ? (
            <Badge variant="destructive">{data.status}</Badge>
          ) : (
            <Badge>{t("agentOnboarding.myContract.pending") || "Pending signature"}</Badge>
          )}
        </div>
        {data.signedAt && (
          <div className="text-sm text-muted-foreground">
            {t("agentOnboarding.myContract.signedAt") || "Signed at"}: {new Date(data.signedAt).toLocaleString()}
          </div>
        )}
        {data.signedPdfUrl && (
          <a href={`${BASE}${data.signedPdfUrl}`} target="_blank" rel="noreferrer">
            <Button><Download className="w-4 h-4 mr-2" /> {t("agentOnboarding.myContract.download") || "Download PDF"}</Button>
          </a>
        )}
      </Card>
    </div>
  );
}
