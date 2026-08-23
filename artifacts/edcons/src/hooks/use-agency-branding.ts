import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { setActiveAgencyBusinessName } from "@/lib/agency-branding-store";

import { AGENT_ROLES as _AGENT_ROLES_ARR } from "@workspace/roles";
const AGENT_ROLES = new Set<string>(_AGENT_ROLES_ARR);
const STATIC_FAVICON = "/favicon.svg";
const STATIC_TITLE = "Find And Study";
const BASE_URL = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

function setIcon(href: string, type?: string) {
  document.querySelectorAll<HTMLLinkElement>(
    'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
  ).forEach((el) => el.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  if (type) link.type = type;
  link.href = href;
  document.head.appendChild(link);
  const apple = document.createElement("link");
  apple.rel = "apple-touch-icon";
  apple.href = href;
  document.head.appendChild(apple);
}

/**
 * Browser tab branding (favicon + title) by role:
 *
 * - **Agent roles** (agent / sub_agent / agent_staff): show the agent's own
 *   uploaded logo and business name. This is per-account white-labeling so
 *   each agency sees their own brand on their tab.
 * - **Everyone else** (super_admin / admin / staff / student / public visitor):
 *   show the main tenant brand — the logo/favicon configured by the portal
 *   admin in Settings → Branding, falling back to the static `/favicon.svg`
 *   shipped with the app and the static base title.
 *
 * Defaults are *never* read from the live DOM: doing so would let one
 * session's agent logo leak in as the "default" for the next session
 * (e.g. after switching accounts without a hard reload).
 */
export function useAgencyBranding() {
  const { user } = useAuth();
  const role = (user as any)?.role as string | undefined;
  const isAgent = !!role && AGENT_ROLES.has(role);

  // Tenant branding (public endpoint, safe for any role and even logged out).
  const { data: tenantBranding } = useQuery({
    queryKey: ["settings", "branding", "tab"],
    queryFn: () => customFetch<any>("/api/settings/branding"),
    staleTime: 5 * 60_000,
  });

  // Agent's own profile only when the logged-in user is an agent role.
  const { data: agentProfile } = useQuery({
    queryKey: ["agent-me", "branding"],
    queryFn: () => customFetch<any>("/api/agents/me"),
    enabled: isAgent,
    staleTime: 30_000,
  });

  useEffect(() => {
    // Tenant defaults — same for super_admin, admin, staff, student, public.
    const tenantTitle = (tenantBranding?.publicBrandName || tenantBranding?.companyName || "").trim() || STATIC_TITLE;
    const tenantFaviconRaw =
      tenantBranding?.faviconUrl ||
      tenantBranding?.logoSquareUrl ||
      tenantBranding?.appleTouchIconUrl ||
      tenantBranding?.logoUrl ||
      "";
    const tenantFavicon = tenantFaviconRaw || STATIC_FAVICON;
    const tenantFaviconType = tenantFaviconRaw ? undefined : "image/svg+xml";

    if (!isAgent) {
      setActiveAgencyBusinessName(null);
      document.title = tenantTitle;
      setIcon(tenantFavicon, tenantFaviconType);
      return;
    }

    // Agent role — wait until we know their profile before swapping anything,
    // so we don't briefly show tenant branding then flicker to the agent's.
    if (!agentProfile) return;
    const businessName = (agentProfile.businessName || "").trim();
    if (businessName) {
      setActiveAgencyBusinessName(businessName);
      document.title = businessName;
    } else {
      setActiveAgencyBusinessName(null);
      document.title = tenantTitle;
    }
    if (agentProfile.logoUrl) {
      setIcon(agentProfile.logoUrl);
    } else {
      setIcon(tenantFavicon, tenantFaviconType);
    }
  }, [
    isAgent,
    agentProfile?.businessName,
    agentProfile?.logoUrl,
    tenantBranding?.publicBrandName,
    tenantBranding?.companyName,
    tenantBranding?.faviconUrl,
    tenantBranding?.logoSquareUrl,
    tenantBranding?.appleTouchIconUrl,
    tenantBranding?.logoUrl,
  ]);

  // On full app teardown, restore the static defaults so a stale agent logo
  // never persists into a fresh session.
  useEffect(() => {
    return () => {
      setActiveAgencyBusinessName(null);
      document.title = STATIC_TITLE;
      setIcon(STATIC_FAVICON, "image/svg+xml");
    };
  }, []);
}
