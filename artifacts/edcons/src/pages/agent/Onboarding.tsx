import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/hooks/use-i18n";
import { Loader2, CheckCircle2, AlertCircle, KeyRound, Mail, RotateCw } from "lucide-react";

function goToAgentDashboard() {
  if (typeof window !== "undefined") {
    window.location.href = "/agent";
  }
}

type Step = "verifying" | "manual_entry" | "set_password" | "done";

function readQueryParams(): { token: string; email: string; code: string } {
  if (typeof window === "undefined") return { token: "", email: "", code: "" };
  const sp = new URLSearchParams(window.location.search);
  return {
    token: (sp.get("token") || "").trim(),
    email: (sp.get("email") || "").trim(),
    code: (sp.get("code") || "").trim(),
  };
}

export default function AgentOnboardingPage() {
  const { t } = useI18n();
  const [, setLocation] = useLocation();
  const initial = readQueryParams();
  const [token] = useState(initial.token);

  // Manual fallback form state
  const [manualEmail, setManualEmail] = useState(initial.email);
  const [manualCode, setManualCode] = useState(initial.code);
  const [manualSubmitting, setManualSubmitting] = useState(false);
  const [manualError, setManualError] = useState("");
  const [resendBusy, setResendBusy] = useState(false);
  const [resendNotice, setResendNotice] = useState("");

  const hasAutoCredential = !!token || (!!initial.email && !!initial.code);
  const [step, setStep] = useState<Step>(hasAutoCredential ? "verifying" : "manual_entry");
  const ranVerify = useRef(false);

  // Set-password form
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pwError, setPwError] = useState("");

  async function attemptVerify(body: Record<string, string>): Promise<boolean> {
    try {
      const res: any = await customFetch("/api/agents/onboarding/verify-with-link", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res?.passwordSet) {
        setStep("done");
        setTimeout(goToAgentDashboard, 800);
      } else {
        setStep("set_password");
      }
      return true;
    } catch (err: any) {
      setManualError(err?.body?.error || err?.message || t("agentOnboarding.verifyFailed"));
      return false;
    }
  }

  // Auto-verify when arriving from the email link.
  useEffect(() => {
    if (ranVerify.current || !hasAutoCredential) return;
    ranVerify.current = true;
    (async () => {
      const body: Record<string, string> = token
        ? { token }
        : { email: initial.email, code: initial.code };
      const ok = await attemptVerify(body);
      if (!ok) setStep("manual_entry");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    setManualError("");
    setResendNotice("");
    if (!manualEmail.trim() || !manualCode.trim()) {
      setManualError(t("agentOnboarding.emailAndCodeRequired"));
      return;
    }
    setManualSubmitting(true);
    try {
      await attemptVerify({ email: manualEmail.trim(), code: manualCode.trim() });
    } finally {
      setManualSubmitting(false);
    }
  }

  async function handleResend() {
    setManualError("");
    setResendNotice("");
    if (!manualEmail.trim()) {
      setManualError(t("agentOnboarding.emailRequiredForResend"));
      return;
    }
    setResendBusy(true);
    try {
      await customFetch("/api/agents/onboarding/resend-public", {
        method: "POST",
        body: JSON.stringify({ email: manualEmail.trim() }),
      });
      setResendNotice(t("agentOnboarding.resendSuccess"));
    } catch (err: any) {
      setManualError(err?.body?.error || err?.message || t("agentOnboarding.resendFailed"));
    } finally {
      setResendBusy(false);
    }
  }

  function validateClient(): string {
    if (password.length < 8) return t("agentOnboarding.passwordMinLength");
    if (!/[A-Z]/.test(password)) return t("agentOnboarding.passwordUppercase");
    if (!/[0-9]/.test(password)) return t("agentOnboarding.passwordNumber");
    if (password !== confirm) return t("agentOnboarding.passwordsMismatch");
    return "";
  }

  async function handleSetPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    const local = validateClient();
    if (local) { setPwError(local); return; }
    setSubmitting(true);
    try {
      await customFetch("/api/agents/me/set-password", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setStep("done");
      setTimeout(goToAgentDashboard, 600);
    } catch (err: any) {
      setPwError(err?.body?.error || err?.message || t("agentOnboarding.setPasswordFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-950 p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="bg-primary px-8 py-6 text-primary-foreground">
          <h1 className="text-xl font-semibold">{t("agentOnboarding.headerTitle")}</h1>
        </div>

        <div className="p-8">
          {step === "verifying" && (
            <div className="flex flex-col items-center text-center py-6">
              <Loader2 className="w-10 h-10 text-primary animate-spin mb-4" />
              <p className="text-slate-700 dark:text-slate-300">{t("agentOnboarding.verifyingEmail")}</p>
            </div>
          )}

          {step === "manual_entry" && (
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div className="flex items-start gap-3 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 rounded-lg">
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-amber-900 dark:text-amber-200">
                    {hasAutoCredential ? t("agentOnboarding.linkInvalid") : t("agentOnboarding.linkNotFound")}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    {t("agentOnboarding.enterCodeOrRequest")}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="manual-email">{t("agentOnboarding.emailLabel")}</Label>
                <Input
                  id="manual-email"
                  type="email"
                  autoComplete="email"
                  required
                  value={manualEmail}
                  onChange={(e) => setManualEmail(e.target.value)}
                  disabled={manualSubmitting || resendBusy}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="manual-code">{t("agentOnboarding.codeLabel")}</Label>
                <Input
                  id="manual-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  required
                  value={manualCode}
                  onChange={(e) => setManualCode(e.target.value.replace(/\D/g, ""))}
                  disabled={manualSubmitting || resendBusy}
                  placeholder="123456"
                />
              </div>

              {manualError && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                  {manualError}
                </div>
              )}
              {resendNotice && (
                <div className="text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-md p-3">
                  {resendNotice}
                </div>
              )}

              <Button type="submit" disabled={manualSubmitting || resendBusy} className="w-full">
                {manualSubmitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("agentOnboarding.verifying")}</>
                ) : (
                  <><Mail className="w-4 h-4 mr-2" />{t("agentOnboarding.verify")}</>
                )}
              </Button>

              <div className="flex items-center justify-between text-xs text-slate-500 pt-1">
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={manualSubmitting || resendBusy}
                  className="inline-flex items-center gap-1 text-primary hover:underline disabled:opacity-60 disabled:no-underline"
                >
                  {resendBusy
                    ? (<><Loader2 className="w-3 h-3 animate-spin" />{t("agentOnboarding.sending")}</>)
                    : (<><RotateCw className="w-3 h-3" />{t("agentOnboarding.resendCode")}</>)}
                </button>
                <button
                  type="button"
                  onClick={() => setLocation("/login")}
                  className="hover:underline"
                >
                  {t("agentOnboarding.backToLogin")}
                </button>
              </div>
            </form>
          )}

          {step === "set_password" && (
            <form onSubmit={handleSetPassword} className="space-y-4">
              <div className="flex items-start gap-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 rounded-lg">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
                <div className="text-sm">
                  <p className="font-medium text-emerald-900 dark:text-emerald-200">{t("agentOnboarding.emailVerified")}</p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">
                    {t("agentOnboarding.setPasswordThenSign")}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">{t("agentOnboarding.newPasswordLabel")}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirm">{t("agentOnboarding.confirmPasswordLabel")}</Label>
                <Input
                  id="confirm"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <ul className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5 pl-1">
                <li>• {t("agentOnboarding.reqMinLength")}</li>
                <li>• {t("agentOnboarding.reqUppercase")}</li>
                <li>• {t("agentOnboarding.reqNumber")}</li>
              </ul>

              {pwError && (
                <div className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md p-3">
                  {pwError}
                </div>
              )}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />{t("agentOnboarding.saving")}</>
                ) : (
                  <><KeyRound className="w-4 h-4 mr-2" />{t("agentOnboarding.setPassword")}</>
                )}
              </Button>
            </form>
          )}

          {step === "done" && (
            <div className="flex flex-col items-center text-center py-6">
              <CheckCircle2 className="w-12 h-12 text-emerald-500 mb-4" />
              <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-1">
                {t("agentOnboarding.ready")}
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {t("agentOnboarding.redirectingToSigning")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
