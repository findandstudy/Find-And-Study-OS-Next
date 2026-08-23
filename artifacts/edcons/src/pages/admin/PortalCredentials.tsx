/**
 * PortalCredentials.tsx — Admin: Üniversite portal kimlik bilgisi yönetimi
 *
 * Her üniversite için username + password kaydeder.
 * Şifre asla geri gösterilmez (sadece "••••• kayıtlı" placeholder).
 */

import { useState } from "react";
import {
  useGetUniversityPortals,
  useSetPortalCredentials,
} from "@workspace/api-client-react";
import type { UniversityPortal } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { useI18n } from "@/hooks/use-i18n";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import {
  PortalEmptyState, PortalErrorState,
} from "@/components/admin/PortalTabStates";

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PortalCredentials() {
  const { t } = useI18n();

  useAuth(true, ["super_admin", "admin"]);

  const {
    data: portalsRaw,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useGetUniversityPortals();

  const portals: UniversityPortal[] = Array.isArray(portalsRaw) ? portalsRaw : [];

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("portalAutomation.credentials.pageTitle")}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          {t("portalAutomation.credentials.description")}
        </p>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <PortalErrorState onRetry={() => void refetch()} retrying={isFetching} />
      ) : portals.length === 0 ? (
        <PortalEmptyState
          icon={KeyRound}
          title={t("portalAutomation.credentials.emptyTitle")}
          description={t("portalAutomation.credentials.noPortals")}
        />
      ) : (
        <div className="space-y-4">
          {portals.map((portal) => (
            <PortalCredentialCard
              key={portal.key}
              portal={portal}
              onSaved={() => void refetch()}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-portal credential card
// ---------------------------------------------------------------------------

function PortalCredentialCard({
  portal,
  onSaved,
}: {
  portal: UniversityPortal;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const setCredsMutation = useSetPortalCredentials({
    mutation: {
      onSuccess: () => {
        toast({ title: t("portalAutomation.credentials.saved") });
        setUsername("");
        setPassword("");
        onSaved();
      },
      onError: () => {
        toast({ title: t("common.saveFailed"), variant: "destructive" });
      },
    },
  });

  function handleSave() {
    if (!username.trim() || !password.trim()) return;
    setCredsMutation.mutate({
      portalKey: portal.key,
      data: { username: username.trim(), password: password.trim() },
    });
  }

  const hasSet = portal.hasCredentials;

  return (
    <Card className="rounded-xl">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
            <div>
              <CardTitle className="text-base">{portal.label}</CardTitle>
              <CardDescription className="text-xs font-mono">
                {portal.key}
              </CardDescription>
            </div>
          </div>
          <Badge
            className={
              hasSet
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0"
                : "bg-muted text-muted-foreground shrink-0"
            }
          >
            {hasSet ? (
              <>
                <ShieldCheck className="w-3 h-3 mr-1" />
                {t("portalAutomation.credentials.credentialsSet")}
              </>
            ) : (
              <>
                <ShieldOff className="w-3 h-3 mr-1" />
                {t("portalAutomation.credentials.noCredentials")}
              </>
            )}
          </Badge>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">
              {t("portalAutomation.credentials.usernameLabel")}
            </Label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={
                hasSet
                  ? t("portalAutomation.credentials.usernameSetPlaceholder")
                  : t("portalAutomation.credentials.usernameLabel")
              }
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              {t("portalAutomation.credentials.passwordLabel")}
            </Label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                hasSet
                  ? t("portalAutomation.credentials.passwordSetPlaceholder")
                  : t("portalAutomation.credentials.passwordLabel")
              }
              autoComplete="new-password"
            />
          </div>
        </div>

        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={
              !username.trim() || !password.trim() || setCredsMutation.isPending
            }
          >
            {setCredsMutation.isPending
              ? t("portalAutomation.credentials.saving")
              : t("portalAutomation.credentials.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
