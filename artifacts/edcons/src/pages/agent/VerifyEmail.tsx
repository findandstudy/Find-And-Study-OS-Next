import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { MailCheck, Loader2, CheckCircle2, AlertCircle, RefreshCw, LogOut } from "lucide-react";

interface Props {
  email: string;
  onVerified: () => void;
}

export default function VerifyEmail({ email, onVerified }: Props) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code.trim().length !== 6) {
      setError(t("agentOnboarding.verifyEmail.invalidCode") || "Please enter the 6-digit code.");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await customFetch("/api/agents/me/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      onVerified();
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t("agentOnboarding.verifyEmail.failed") || "Verification failed.");
    }
    setSubmitting(false);
  }

  async function resend() {
    setResending(true); setError(""); setResent(false);
    try {
      await customFetch("/api/agents/me/resend-verification", { method: "POST" });
      setResent(true);
      setResendCooldown(60);
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t("agentOnboarding.verifyEmail.resendFailed") || "Could not resend code.");
    }
    setResending(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-background p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-card rounded-2xl border border-border/50 shadow-xl shadow-black/5 p-8 space-y-5">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-4">
            <MailCheck className="w-8 h-8 text-amber-600 dark:text-amber-400" />
          </div>
          <h1 className="text-2xl font-display font-bold mb-2">{t("agentOnboarding.verifyEmail.title") || "Verify your email"}</h1>
          <p className="text-sm text-muted-foreground">
            {t("agentOnboarding.verifyEmail.subtitle") || "We sent a 6-digit code to"} <strong className="text-foreground">{email}</strong>
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="code">{t("agentOnboarding.verifyEmail.codeLabel") || "Verification code"}</Label>
          <Input
            id="code"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            inputMode="numeric"
            autoComplete="one-time-code"
            className="text-center tracking-widest text-2xl font-mono"
            maxLength={6}
            autoFocus
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
          </div>
        )}
        {resent && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" /> <span>{t("agentOnboarding.verifyEmail.resent") || "New code sent. Check your inbox."}</span>
          </div>
        )}

        <Button type="submit" disabled={submitting || code.trim().length !== 6} className="w-full">
          {submitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          {t("agentOnboarding.verifyEmail.submit") || "Verify and continue"}
        </Button>

        <div className="flex justify-between gap-2 pt-2">
          <Button type="button" variant="outline" onClick={resend} disabled={resending || resendCooldown > 0}>
            {resending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            {resendCooldown > 0 ? `${t("agentOnboarding.verifyEmail.resendIn") || "Resend in"} ${resendCooldown}s` : (t("agentOnboarding.verifyEmail.resend") || "Resend code")}
          </Button>
          <Button type="button" variant="ghost" asChild>
            <a href="/api/auth/logout"><LogOut className="w-4 h-4 mr-2" /> {t("common.signOut") || "Sign out"}</a>
          </Button>
        </div>
      </form>
    </div>
  );
}
