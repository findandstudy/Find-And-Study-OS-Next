import { useI18n } from "@/hooks/use-i18n";
import { Button } from "@/components/ui/button";
import { AlertCircle, LogOut } from "lucide-react";

export default function ContractExpired() {
  const { t } = useI18n();
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center bg-card border border-border/50 rounded-2xl shadow-xl shadow-black/5 p-8 space-y-4">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto">
          <AlertCircle className="w-8 h-8 text-amber-600 dark:text-amber-400" />
        </div>
        <h1 className="text-2xl font-display font-bold">{t("agentOnboarding.expired.title") || "Contract signing window expired"}</h1>
        <p className="text-sm text-muted-foreground">
          {t("agentOnboarding.expired.body") || "Your onboarding contract was not signed in time. Please contact your administrator to have a new signing link issued."}
        </p>
        <Button variant="outline" asChild className="w-full">
          <a href="/api/auth/logout"><LogOut className="w-4 h-4 mr-2" /> {t("common.signOut") || "Sign out"}</a>
        </Button>
      </div>
    </div>
  );
}
