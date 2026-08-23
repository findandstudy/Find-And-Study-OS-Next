import { useEffect, useSyncExternalStore } from "react";
import { SUPPORTED_LANGUAGES, LANGUAGE_META, buildLocalizedPath, stripLanguagePrefix, type Language } from "@/lib/i18n/index";
import { getActiveAgencyBusinessName, subscribeAgencyBusinessName } from "@/lib/agency-branding-store";

interface SeoOptions {
  title: string;
  description?: string;
  canonical?: string;
  noindex?: boolean;
  ogImage?: string;
  ogType?: "website" | "article";
  lang?: Language;
}

function setMeta(name: string, content: string, isProperty = false) {
  const attr = isProperty ? "property" : "name";
  let el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  if (!el) {
    el = document.createElement("meta");
    el.setAttribute(attr, name);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setLink(rel: string, href: string, attrs?: Record<string, string>) {
  const selector = attrs
    ? `link[rel="${rel}"]${Object.entries(attrs).map(([k, v]) => `[${k}="${v}"]`).join("")}`
    : `link[rel="${rel}"]`;
  let el = document.querySelector<HTMLLinkElement>(selector);
  if (!el) {
    el = document.createElement("link");
    el.rel = rel;
    if (attrs) Object.entries(attrs).forEach(([k, v]) => el!.setAttribute(k, v));
    document.head.appendChild(el);
  }
  el.href = href;
}

function removeHreflangLinks() {
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((el) => el.remove());
}

export function useSeo({ title, description, canonical, noindex = false, ogImage, ogType = "website", lang }: SeoOptions) {
  const agencyBusinessName = useSyncExternalStore(
    subscribeAgencyBusinessName,
    getActiveAgencyBusinessName,
    () => null,
  );

  useEffect(() => {
    // White-label: when an agent / sub-agent is logged in, the browser tab
    // shows ONLY their business name — no page title, no site suffix.
    const siteName = agencyBusinessName || "Find And Study";
    const fullTitle = agencyBusinessName ? agencyBusinessName : `${title} | ${siteName}`;

    document.title = fullTitle;

    if (description) setMeta("description", description);
    setMeta("robots", noindex ? "noindex, nofollow" : "index, follow");

    const canonicalHref = canonical ?? window.location.href.split("?")[0].split("#")[0];
    setLink("canonical", canonicalHref);

    setMeta("og:title", fullTitle, true);
    setMeta("og:site_name", siteName, true);
    setMeta("og:type", ogType, true);
    setMeta("og:url", canonicalHref, true);
    if (description) setMeta("og:description", description, true);
    if (ogImage) setMeta("og:image", ogImage, true);

    setMeta("twitter:card", "summary_large_image");
    setMeta("twitter:title", fullTitle);
    if (description) setMeta("twitter:description", description);
    if (ogImage) setMeta("twitter:image", ogImage);

    removeHreflangLinks();

    if (lang && !noindex) {
      const origin = window.location.origin;
      const basePath = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const currentPath = stripLanguagePrefix(window.location.pathname.replace(basePath, ""));

      for (const code of SUPPORTED_LANGUAGES) {
        const localizedPath = buildLocalizedPath(currentPath, code);
        const href = `${origin}${basePath}${localizedPath}`;
        const linkEl = document.createElement("link");
        linkEl.rel = "alternate";
        linkEl.hreflang = code;
        linkEl.href = href;
        document.head.appendChild(linkEl);
      }

      const defaultLink = document.createElement("link");
      defaultLink.rel = "alternate";
      defaultLink.hreflang = "x-default";
      defaultLink.href = `${origin}${basePath}${buildLocalizedPath(currentPath, "en")}`;
      document.head.appendChild(defaultLink);
    }

    return () => {
      removeHreflangLinks();
    };
  }, [title, description, canonical, noindex, ogImage, ogType, lang, agencyBusinessName]);
}
