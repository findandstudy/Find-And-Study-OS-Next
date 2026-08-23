import { useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { getStickyUser } from "@/lib/auth-cache";
import { useSeo } from "@/hooks/use-seo";
import { Button } from "@/components/ui/button";
import { ShieldX, Clock } from "lucide-react";

function AuthLoadingScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background" />
  );
}

interface Props {
  children: React.ReactNode;
  allowedRoles?: string[];
  requiredPermission?: string;
}

function PendingScreen() {
  const [, setLocation] = useLocation();
  useSeo({ title: "Account Pending", noindex: true });
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-background">
      <div className="text-center max-w-md p-8">
        <div className="w-16 h-16 rounded-full bg-amber-100 dark:bg-amber-900/40 flex items-center justify-center mx-auto mb-4">
          <Clock className="w-8 h-8 text-amber-600 dark:text-amber-400" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-2">Account Pending Activation</h1>
        <p className="text-muted-foreground mb-6">
          Your account has been registered and is awaiting approval from an administrator.
          Please contact your team to get your account activated.
        </p>
        <Button variant="outline" onClick={() => setLocation("/")}>
          Back to Home
        </Button>
      </div>
    </div>
  );
}

function AccessDeniedScreen() {
  useSeo({ title: "Access Denied", noindex: true });
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary/5 to-background">
      <div className="text-center max-w-md p-8">
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-4">
          <ShieldX className="w-8 h-8 text-destructive" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-2">Access Denied</h1>
        <p className="text-muted-foreground mb-6">
          You do not have permission to view this page. Contact your administrator if you believe this is an error.
        </p>
        <Button variant="outline" onClick={() => window.history.back()}>
          Go Back
        </Button>
      </div>
    </div>
  );
}

export function ProtectedRoute({ children, allowedRoles, requiredPermission }: Props) {
  // useAuth already applies the sticky-user fallback internally, so `user`
  // here is liveUser ?? getStickyUser(). It is non-null whenever the user
  // has ever authenticated in this page session.
  const { user, isLoading } = useAuth(true, allowedRoles);

  useEffect(() => {
    console.log("[ProtectedRoute] MOUNTED roles=" + (allowedRoles?.join(",") ?? "any"));
    return () => console.log("[ProtectedRoute] UNMOUNTED roles=" + (allowedRoles?.join(",") ?? "any"));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // prevUserRef gives an additional safety net: if somehow `user` from
  // useAuth flickers to undefined across renders, we keep the last value.
  const prevUserRef = useRef(user);
  if (user) prevUserRef.current = user;
  const effectiveUser = prevUserRef.current ?? user;

  if (!effectiveUser && isLoading) {
    // Auth check in-flight (cold start / hard reload) — show blank bg instead
    // of null so the layout doesn't flash white while we wait.
    return <AuthLoadingScreen />;
  }
  if (!effectiveUser) {
    // Genuinely unauthenticated. useAuth's effect will redirect to /login;
    // render nothing in the meantime so there's no content flash.
    return <AuthLoadingScreen />;
  }

  if (effectiveUser.role === "pending") {
    return <PendingScreen />;
  }

  if (allowedRoles && !allowedRoles.includes(effectiveUser.role)) {
    return <AccessDeniedScreen />;
  }

  if (requiredPermission && effectiveUser.role !== "super_admin" && effectiveUser.role !== "admin") {
    // The short, section-level keys on /agent routes are the granular
    // agent_staff switches. Primary agents and sub-agents own those portal
    // sections by role and must not be denied merely because role permissions
    // use dotted keys such as "applications.view".
    const isAgentOwner =
      (effectiveUser.role === "agent" || effectiveUser.role === "sub_agent") &&
      !requiredPermission.includes(".");

    const rolePermissions =
      (effectiveUser as typeof effectiveUser & { permissions?: string[] }).permissions ?? [];
    const effectivePermissions = new Set([
      ...(Array.isArray(rolePermissions) ? rolePermissions : []),
      ...(Array.isArray(effectiveUser.agentStaffPermissions)
        ? effectiveUser.agentStaffPermissions
        : []),
    ]);

    if (!isAgentOwner && !effectivePermissions.has(requiredPermission)) {
      return <AccessDeniedScreen />;
    }
  }

  return <>{children}</>;
}
