import { useEffect, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { customFetch } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import VerifyEmail from "@/pages/agent/VerifyEmail";
import SignContract from "@/pages/agent/SignContract";
import ContractExpired from "@/pages/agent/ContractExpired";
import SetPasswordStep from "@/components/auth/SetPasswordStep";

import { AGENT_ROLES as _AGENT_ROLES_ARR } from "@workspace/roles";
const AGENT_ROLES = new Set<string>(_AGENT_ROLES_ARR);

type Status = {
  requiresOnboarding: boolean;
  emailVerified: boolean;
  passwordSet?: boolean;
  email: string | null;
  contractStatus: "none" | "pending" | "signed" | "expired" | "revoked" | "n/a";
  contractMandatory?: boolean;
  sessionId: number | null;
  expiresAt: string | null;
  isPrimaryOnboarding: boolean;
};

interface Props { children: React.ReactNode }

/**
 * Gate every Agent route. Hits /api/agents/me/onboarding-status once per
 * mount, then renders the appropriate lock screen — VerifyEmail, SignContract
 * or ContractExpired — until the agent has completed both steps.
 */
export function AgentOnboardingGuard({ children }: Props) {
  const { user } = useAuth(false);
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-mount dismissal: when the contract is not yet mandatory the agent can
  // postpone signing ("Later") and use the portal. The reminder re-appears on
  // the next login because this state resets on a fresh mount.
  const [dismissed, setDismissed] = useState(false);
  const fetched = useRef(false);

  async function reload() {
    setLoading(true);
    try {
      const r: any = await customFetch("/api/agents/me/onboarding-status");
      setStatus(r);
    } catch (err) {
      console.warn("[AgentOnboardingGuard] status fetch failed", err);
      setStatus(null);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!user || !AGENT_ROLES.has(user.role)) { setLoading(false); return; }
    if (fetched.current) return;
    fetched.current = true;
    void reload();
  }, [user?.id, user?.role]);

  if (!user || !AGENT_ROLES.has(user.role)) return <>{children}</>;
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }
  if (!status || !status.requiresOnboarding) return <>{children}</>;
  if (!status.emailVerified) {
    return <VerifyEmail email={status.email || user.email || ""} onVerified={() => { fetched.current = false; void reload(); }} />;
  }
  if (status.passwordSet === false) {
    return <SetPasswordStep onComplete={() => { fetched.current = false; void reload(); }} />;
  }
  if (status.contractStatus === "pending") {
    // Before the deadline day the contract is non-mandatory: render the portal
    // underneath and overlay a dismissible reminder the agent can postpone with
    // "Later". On/after the deadline day it becomes mandatory and the dialog is
    // non-dismissible, so the agent must sign before doing anything else.
    const mandatory = !!status.contractMandatory;
    return (
      <>
        {children}
        {(mandatory || !dismissed) && (
          <SignContract
            asModal
            onSigned={() => {
              setDismissed(false);
              fetched.current = false;
              void reload();
              void qc.invalidateQueries({ queryKey: ["/api/agents/me/onboarding-status"] });
              void qc.invalidateQueries({ queryKey: ["/api/contracts/me"] });
              void qc.invalidateQueries({ queryKey: ["agent-me"] });
            }}
            onClose={mandatory ? undefined : () => setDismissed(true)}
          />
        )}
      </>
    );
  }
  if (status.contractStatus === "expired" || status.contractStatus === "revoked") {
    return <ContractExpired />;
  }
  return <>{children}</>;
}
