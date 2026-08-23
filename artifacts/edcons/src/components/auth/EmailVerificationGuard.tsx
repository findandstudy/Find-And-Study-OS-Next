import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { MailCheck, RefreshCw, Loader2, ShieldAlert, CheckCircle2 } from "lucide-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

interface Props {
  children: React.ReactNode;
}

export function EmailVerificationGuard({ children }: Props) {
  const { user } = useAuth(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  if (!user || user.role !== "student") return <>{children}</>;
  if (user?.emailVerified) return <>{children}</>;

  async function handleResend() {
    setSending(true);
    setError("");
    setSent(false);
    try {
      const res = await fetch(`${BASE_URL}/api/auth/resend-verification-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed to send verification email");
        return;
      }
      setSent(true);
    } catch {
      setError("Connection error. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-background p-4">
      <div className="text-center max-w-md w-full">
        <div className="bg-background rounded-2xl shadow-xl shadow-black/5 border border-border/50 p-8">
          <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mx-auto mb-6">
            <ShieldAlert className="w-8 h-8 text-amber-600 dark:text-amber-400" />
          </div>
          <h1 className="text-2xl font-display font-bold text-foreground mb-3">Verify Your Email</h1>
          <p className="text-muted-foreground mb-2">
            To access your student portal and track your applications, please verify your email address.
          </p>
          <p className="text-sm font-medium text-foreground mb-6">
            <MailCheck className="w-4 h-4 inline mr-1" />
            {user.email}
          </p>

          {sent && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300 text-sm mb-4">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              Verification email sent! Check your inbox.
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm mb-4">
              {error}
            </div>
          )}

          <Button onClick={handleResend} disabled={sending} className="w-full rounded-xl gap-2 mb-3">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {sent ? "Resend Verification Email" : "Send Verification Email"}
          </Button>

          <p className="text-xs text-muted-foreground mb-4">
            Check your inbox (and spam folder) for the verification link.
          </p>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1 rounded-xl" onClick={() => window.location.reload()}>
              I've Verified
            </Button>
            <Button variant="ghost" className="flex-1 rounded-xl" asChild>
              <a href="/api/auth/logout">Sign Out</a>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
