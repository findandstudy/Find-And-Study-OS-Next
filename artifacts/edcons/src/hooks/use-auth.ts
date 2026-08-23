import { useGetMe } from "@workspace/api-client-react";
import { useEffect, useMemo, startTransition } from "react";
import { useLocation } from "wouter";
import { getAuthCache, getStickyUser, setAuthCache, setStickyUser } from "@/lib/auth-cache";

export function useAuth(requireAuth = false, allowedRoles?: readonly string[]) {
  const initialUser = useMemo(() => getStickyUser() ?? getAuthCache(), []);

  const { data: liveUser, isLoading, error } = useGetMe({
    query: {
      retry: false,
      staleTime: 30_000,
      // Agent staff permissions are edited by their managing agent from a
      // different session. Poll /auth/me every 5s for agent_staff so a
      // permission change (sidebar links + route guards) reflects without a
      // manual page refresh. Other roles don't poll. Refetch on focus too.
      refetchInterval: (query: any) =>
        (query?.state?.data as any)?.role === "agent_staff" ? 5_000 : false,
      refetchOnWindowFocus: true,
      ...(initialUser !== undefined
        ? {
            initialData: initialUser as any,
            // Mark initial data as fresh right now so TanStack Query doesn't
            // immediately schedule a background refetch on every component mount.
            // The data will be considered stale after staleTime (30s).
            initialDataUpdatedAt: Date.now(),
          }
        : {}),
    } as any,
  });

  // Keep sticky + localStorage caches updated whenever live data is
  // available. Mirroring into localStorage here as well as in AuthPrefetch
  // closes the window where a freshly logged-in user can navigate to a
  // ProtectedRoute before AuthPrefetch has had a chance to write the cache.
  if (liveUser) {
    setStickyUser(liveUser);
    setAuthCache(liveUser);
  }

  // Use live user first, then fall back to module-level sticky, then to
  // the persisted localStorage cache. The third layer matters during the
  // brief render where a SPA navigation has reset the closure-captured
  // `initialUser` to undefined but `/api/auth/me` hasn't resolved yet —
  // without it the redirect effect below would fire and bounce the user
  // back to /login even though they are clearly authenticated.
  const user = (liveUser ?? getStickyUser() ?? getAuthCache()) as typeof liveUser;

  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && requireAuth) {
      const status = (error as any)?.status as number | undefined;
      const isHardAuthError = status === 401 || status === 403;

      if (!user) {
        // Genuinely unauthenticated — redirect to login.
        const returnTo = encodeURIComponent(
          window.location.pathname + window.location.search
        );
        // Wrap in startTransition so any in-flight Suspense navigation
        // resolves before the login redirect replaces the tree.
        startTransition(() => setLocation(`/login?returnTo=${returnTo}`));
        return;
      }

      if (isHardAuthError && !getStickyUser()) {
        // Session expired AND sticky user is gone (cleared after confirmed 401
        // in AuthPrefetch) — redirect to login.
        const returnTo = encodeURIComponent(
          window.location.pathname + window.location.search
        );
        startTransition(() => setLocation(`/login?returnTo=${returnTo}`));
        return;
      }

      if (
        user.role !== "pending" &&
        allowedRoles &&
        !allowedRoles.includes(user.role)
      ) {
        startTransition(() => setLocation("/"));
      }
    }
  }, [user, isLoading, error, requireAuth, allowedRoles, setLocation]);

  const role = user?.role;
  const permissions = (((user as any)?.permissions) as string[] | undefined) ?? [];

  // Only Super Admin bypasses configured permissions. Admin and every other
  // role use the effective permission projection returned by /auth/me.
  const hasPermission = (key: string): boolean => {
    if (!role) return false;
    if (role === "super_admin") return true;
    return permissions.includes(key);
  };

  // Agent-staff granular permissions (leads, students, applications, documents,
  // course_finder, messages, commissions) are stored on the user as
  // `agentStaffPermissions`. Only the agent_staff role is restricted by this
  // layer; every other role is unaffected here (their access is governed by
  // role/hasPermission instead).
  const agentStaffPermissions = (user?.agentStaffPermissions as string[] | undefined) ?? [];
  const hasAgentStaffPermission = (key: string): boolean => {
    if (role !== "agent_staff") return true;
    return agentStaffPermissions.includes(key);
  };

  return { user, isLoading, isAuthenticated: !!user, hasPermission, hasAgentStaffPermission };
}
