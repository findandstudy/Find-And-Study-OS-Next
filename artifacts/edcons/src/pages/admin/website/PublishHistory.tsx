import { History } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";

export default function WebsitePublishHistory() {
  const { t } = useI18n();
  return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <History className="w-12 h-12 text-muted-foreground mb-4" />
        <h1 className="text-2xl font-bold mb-2">{t("publishHistory.title")}</h1>
        <p className="text-muted-foreground">{t("publishHistory.desc")}</p>
      </div>
  );
}
