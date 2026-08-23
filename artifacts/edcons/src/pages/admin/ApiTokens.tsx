import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle
} from "@/components/ui/alert-dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from "@/components/ui/table";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle
} from "@/components/ui/card";
import { Plus, Copy, Trash2, KeyRound, Check } from "lucide-react";
import { useI18n } from "@/hooks/use-i18n";

const BASE_URL = import.meta.env.BASE_URL || "/";
const API_BASE = `${BASE_URL}api`.replace(/\/+/g, "/");

type ApiToken = {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

type CreatedToken = ApiToken & { token: string };

const SCOPE_LABEL_KEY: Record<string, string> = {
  "applications:read": "apiTokens.scopeApplicationsRead",
  "applications:write": "apiTokens.scopeApplicationsWrite",
  "applications:patch": "apiTokens.scopeApplicationsPatch",
  "documents:read": "apiTokens.scopeDocumentsRead",
  "documents:write": "apiTokens.scopeDocumentsWrite",
  "students:read": "apiTokens.scopeStudentsRead",
  "universities:read": "apiTokens.scopeUniversitiesRead",
};

function tokenStatus(t: ApiToken): "revoked" | "expired" | "active" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now()) return "expired";
  return "active";
}

export function ApiTokensManager({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState<CreatedToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  const tokensQuery = useQuery({
    queryKey: ["api-tokens"],
    queryFn: () =>
      customFetch<{ data: ApiToken[] }>(`${API_BASE}/api-tokens`).then((r) => r.data),
  });

  const scopesQuery = useQuery({
    queryKey: ["api-token-scopes"],
    queryFn: () =>
      customFetch<{ data: string[] }>(`${API_BASE}/api-tokens/scopes`).then((r) => r.data),
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; scopes: string[]; expiresAt?: string }) =>
      customFetch<CreatedToken>(`${API_BASE}/api-tokens`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (created) => {
      setCreatedToken(created);
      setCreateOpen(false);
      setName("");
      setExpiresAt("");
      setSelectedScopes([]);
      setCopied(false);
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: () => {
      toast({ title: t("apiTokens.createError"), variant: "destructive" });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) =>
      customFetch(`${API_BASE}/api-tokens/${id}/revoke`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("apiTokens.revoked") });
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: ["api-tokens"] });
    },
    onError: () => {
      toast({ title: t("apiTokens.revokeError"), variant: "destructive" });
    },
  });

  function toggleScope(scope: string) {
    setSelectedScopes((cur) =>
      cur.includes(scope) ? cur.filter((s) => s !== scope) : [...cur, scope]
    );
  }

  function submitCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast({ title: t("apiTokens.nameRequired"), variant: "destructive" });
      return;
    }
    if (selectedScopes.length === 0) {
      toast({ title: t("apiTokens.scopesRequired"), variant: "destructive" });
      return;
    }
    createMutation.mutate({
      name: trimmed,
      scopes: selectedScopes,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    });
  }

  async function copyToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken.token);
      setCopied(true);
      toast({ title: t("apiTokens.copied") });
    } catch {
      setCopied(false);
    }
  }

  function fmtDate(value: string | null): string {
    if (!value) return t("apiTokens.never");
    return new Date(value).toLocaleString(lang);
  }

  const scopeLabel = (scope: string) =>
    SCOPE_LABEL_KEY[scope] ? t(SCOPE_LABEL_KEY[scope]) : scope;

  const tokens = tokensQuery.data ?? [];
  const scopes = scopesQuery.data ?? [];

  return (
    <div className={embedded ? "space-y-6" : "p-4 md:p-6 space-y-6"}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        {!embedded ? (
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <KeyRound className="h-6 w-6 text-primary" />
              {t("apiTokens.title")}
            </h1>
            <p className="text-sm text-muted-foreground max-w-2xl">
              {t("apiTokens.description")}
            </p>
          </div>
        ) : (
          <div />
        )}
        <Button onClick={() => setCreateOpen(true)} data-testid="button-create-token">
          <Plus className="h-4 w-4 me-2" />
          {t("apiTokens.createButton")}
        </Button>
      </div>

      <Card className="rounded-xl border-border/50">
        <CardHeader>
          <CardTitle className="text-base">{t("apiTokens.title")}</CardTitle>
          <CardDescription>{t("apiTokens.listDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          {tokensQuery.isLoading ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t("apiTokens.loading")}
            </p>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t("apiTokens.empty")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("apiTokens.colName")}</TableHead>
                    <TableHead>{t("apiTokens.colPrefix")}</TableHead>
                    <TableHead>{t("apiTokens.colScopes")}</TableHead>
                    <TableHead>{t("apiTokens.colLastUsed")}</TableHead>
                    <TableHead>{t("apiTokens.colExpires")}</TableHead>
                    <TableHead>{t("apiTokens.colStatus")}</TableHead>
                    <TableHead className="text-end">{t("apiTokens.colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tokens.map((tok) => {
                    const status = tokenStatus(tok);
                    return (
                      <TableRow key={tok.id} data-testid={`row-token-${tok.id}`}>
                        <TableCell className="font-medium">{tok.name}</TableCell>
                        <TableCell>
                          <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                            {tok.prefix}…
                          </code>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-xs">
                            {tok.scopes.map((s) => (
                              <Badge key={s} variant="secondary" className="text-xs">
                                {scopeLabel(s)}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {fmtDate(tok.lastUsedAt)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {tok.expiresAt ? fmtDate(tok.expiresAt) : t("apiTokens.noExpiry")}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={status === "active" ? "default" : "outline"}
                            className={
                              status === "active"
                                ? "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/10"
                                : "text-muted-foreground"
                            }
                          >
                            {t(`apiTokens.status${status.charAt(0).toUpperCase()}${status.slice(1)}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-end">
                          {status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setRevokeTarget(tok)}
                              data-testid={`button-revoke-${tok.id}`}
                            >
                              <Trash2 className="h-4 w-4 me-1.5" />
                              {t("apiTokens.revoke")}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("apiTokens.createTitle")}</DialogTitle>
            <DialogDescription>{t("apiTokens.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="token-name">{t("apiTokens.nameLabel")}</Label>
              <Input
                id="token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("apiTokens.namePlaceholder")}
                maxLength={100}
                data-testid="input-token-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="token-expiry">{t("apiTokens.expiresLabel")}</Label>
              <Input
                id="token-expiry"
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                data-testid="input-token-expiry"
              />
            </div>
            <div className="space-y-2">
              <Label>{t("apiTokens.scopesLabel")}</Label>
              <p className="text-xs text-muted-foreground">{t("apiTokens.scopesHint")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                {scopes.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-center gap-2 rounded-lg border border-border/50 p-2.5 cursor-pointer hover:bg-secondary/30"
                  >
                    <Checkbox
                      checked={selectedScopes.includes(scope)}
                      onCheckedChange={() => toggleScope(scope)}
                      data-testid={`checkbox-scope-${scope}`}
                    />
                    <span className="text-sm">{scopeLabel(scope)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("apiTokens.cancel")}
            </Button>
            <Button
              onClick={submitCreate}
              disabled={createMutation.isPending}
              data-testid="button-submit-token"
            >
              {createMutation.isPending ? t("apiTokens.creating") : t("apiTokens.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!createdToken} onOpenChange={(open) => !open && setCreatedToken(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("apiTokens.createdTitle")}</DialogTitle>
            <DialogDescription>{t("apiTokens.createdWarning")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs break-all bg-muted px-3 py-2.5 rounded-lg font-mono">
                {createdToken?.token}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={copyToken}
                data-testid="button-copy-token"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setCreatedToken(null)} data-testid="button-done-token">
              {t("apiTokens.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("apiTokens.revokeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("apiTokens.revokeConfirmBody", { name: revokeTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("apiTokens.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-revoke"
            >
              {t("apiTokens.revokeConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function ApiTokens() {
  return <ApiTokensManager />;
}
