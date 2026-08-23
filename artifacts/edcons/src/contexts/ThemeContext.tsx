import { createContext, useContext, useEffect, useLayoutEffect, useState, useCallback, type ReactNode } from "react";

type ThemeMode = "light" | "dark" | "system";

interface ThemeSettings {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  logoSquareUrl: string | null;
  faviconUrl: string | null;
  appleTouchIconUrl: string | null;
  themePrimary: string | null;
  themeButton: string | null;
  themeHover: string | null;
  companyName: string | null;
  publicBrandName: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  companyAddress: string | null;
  companyCity: string | null;
  companyCountry: string | null;
  companyWebsite: string | null;
  whatsappNumber: string | null;
  workingHours: string | null;
  footerDescription: string | null;
  footerCopyright: string | null;
  contactCtaText: string | null;
  socialInstagram: string | null;
  socialFacebook: string | null;
  socialLinkedin: string | null;
  socialTwitter: string | null;
  socialYoutube: string | null;
  socialTiktok: string | null;
}

interface ThemeContextType {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  resolvedTheme: "light" | "dark";
  settings: ThemeSettings;
  refreshSettings: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

function hexToHsl(hex: string, minimumLightness?: number): string | null {
  hex = hex.replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  if (hex.length !== 6) return null;
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  const lightness = minimumLightness == null
    ? Math.round(l * 100)
    : Math.max(Math.round(l * 100), minimumLightness);
  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${lightness}%`;
}

function getSystemTheme(): "light" | "dark" {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

let themeTransitionLockVersion = 0;

function lockThemeTransitions() {
  const root = document.documentElement;
  const lockVersion = ++themeTransitionLockVersion;
  root.classList.add("theme-switching");

  // Keep the lock through the frame in which React applies the new theme and
  // release it only after the browser has painted the complete theme once.
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (lockVersion === themeTransitionLockVersion) {
        root.classList.remove("theme-switching");
      }
    });
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "light";
    return (localStorage.getItem("edcons_theme") as ThemeMode) || "light";
  });

  const [resolvedTheme, setResolved] = useState<"light" | "dark">(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem("edcons_theme") as ThemeMode : "light";
    const m = stored || "light";
    return m === "system" ? getSystemTheme() : m;
  });

  const SETTINGS_DEFAULTS: ThemeSettings = {
    logoUrl: null, logoDarkUrl: null, logoSquareUrl: null, faviconUrl: null, appleTouchIconUrl: null,
    themePrimary: null, themeButton: null, themeHover: null,
    companyName: null, publicBrandName: null, companyEmail: null, companyPhone: null,
    companyAddress: null, companyCity: null, companyCountry: null, companyWebsite: null,
    whatsappNumber: null, workingHours: null, footerDescription: null, footerCopyright: null,
    contactCtaText: null, socialInstagram: null, socialFacebook: null, socialLinkedin: null,
    socialTwitter: null, socialYoutube: null, socialTiktok: null,
  };

  const [settings, setSettings] = useState<ThemeSettings>(() => {
    if (typeof window === "undefined") return SETTINGS_DEFAULTS;
    try {
      const cached = localStorage.getItem("edcons_branding");
      if (cached) return { ...SETTINGS_DEFAULTS, ...JSON.parse(cached) };
    } catch {}
    return SETTINGS_DEFAULTS;
  });

  const setMode = useCallback((m: ThemeMode) => {
    lockThemeTransitions();
    setModeState(m);
    localStorage.setItem("edcons_theme", m);
  }, []);

  useLayoutEffect(() => {
    const resolved = mode === "system" ? getSystemTheme() : mode;
    setResolved(resolved);
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;

    if (mode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = (e: MediaQueryListEvent) => {
        lockThemeTransitions();
        setResolved(e.matches ? "dark" : "light");
        document.documentElement.classList.toggle("dark", e.matches);
        document.documentElement.style.colorScheme = e.matches ? "dark" : "light";
      };
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    return undefined;
  }, [mode]);

  const applyThemeColors = useCallback((s: ThemeSettings) => {
    const root = document.documentElement;
    if (s.themePrimary) {
      // A brand navy that works well on white can become nearly invisible on
      // the dark dashboard. Preserve its hue/saturation while lifting only the
      // dark-mode lightness to an accessible interactive colour.
      const hsl = hexToHsl(s.themePrimary, resolvedTheme === "dark" ? 62 : undefined);
      if (hsl) {
        root.style.setProperty("--primary", hsl);
        root.style.setProperty("--ring", hsl);
        root.style.setProperty("--sidebar-primary", hsl);
        root.style.setProperty("--sidebar-ring", hsl);
      }
    } else {
      root.style.removeProperty("--primary");
      root.style.removeProperty("--ring");
      root.style.removeProperty("--sidebar-primary");
      root.style.removeProperty("--sidebar-ring");
    }
    if (s.themeButton) {
      const hsl = hexToHsl(s.themeButton, resolvedTheme === "dark" ? 58 : undefined);
      if (hsl) root.style.setProperty("--button", hsl);
      else root.style.removeProperty("--button");
    } else {
      root.style.removeProperty("--button");
    }
    if (s.themeHover) {
      const hsl = hexToHsl(s.themeHover, resolvedTheme === "dark" ? 66 : undefined);
      if (hsl) root.style.setProperty("--hover", hsl);
      else root.style.removeProperty("--hover");
    } else {
      root.style.removeProperty("--hover");
    }
  }, [resolvedTheme]);

  const refreshSettings = useCallback(async () => {
    try {
      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
      const res = await fetch(`${BASE}/api/settings/branding`);
      if (!res.ok) return;
      const data = await res.json();
      const s: ThemeSettings = {
        logoUrl: data.logoUrl || null,
        logoDarkUrl: data.logoDarkUrl || null,
        logoSquareUrl: data.logoSquareUrl || null,
        faviconUrl: data.faviconUrl || null,
        appleTouchIconUrl: data.appleTouchIconUrl || null,
        themePrimary: data.themePrimary || null,
        themeButton: data.themeButton || null,
        themeHover: data.themeHover || null,
        companyName: data.companyName || null,
        publicBrandName: data.publicBrandName || null,
        companyEmail: data.companyEmail || null,
        companyPhone: data.companyPhone || null,
        companyAddress: data.companyAddress || null,
        companyCity: data.companyCity || null,
        companyCountry: data.companyCountry || null,
        companyWebsite: data.companyWebsite || null,
        whatsappNumber: data.whatsappNumber || null,
        workingHours: data.workingHours || null,
        footerDescription: data.footerDescription || null,
        footerCopyright: data.footerCopyright || null,
        contactCtaText: data.contactCtaText || null,
        socialInstagram: data.socialInstagram || null,
        socialFacebook: data.socialFacebook || null,
        socialLinkedin: data.socialLinkedin || null,
        socialTwitter: data.socialTwitter || null,
        socialYoutube: data.socialYoutube || null,
        socialTiktok: data.socialTiktok || null,
      };
      setSettings(s);
      try { localStorage.setItem("edcons_branding", JSON.stringify(s)); } catch {}
    } catch {}
  }, []);

  useLayoutEffect(() => {
    applyThemeColors(settings);
  }, [applyThemeColors, settings]);

  useEffect(() => {
    const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";
    const sources = [
      settings.logoUrl ? `${BASE}/api/settings/branding/logo` : null,
      settings.logoDarkUrl ? `${BASE}/api/settings/branding/logo?variant=dark` : null,
      settings.logoSquareUrl ? `${BASE}/api/settings/branding/logo?variant=square` : null,
    ].filter((source): source is string => Boolean(source));

    // Warm every configured logo variant once. Route changes and theme
    // switches can then reuse the decoded browser image instead of briefly
    // showing an empty logo slot while another request completes.
    for (const source of sources) {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
      void image.decode?.().catch(() => undefined);
    }
  }, [settings.logoUrl, settings.logoDarkUrl, settings.logoSquareUrl]);

  useEffect(() => {
    refreshSettings();
  }, [refreshSettings]);

  return (
    <ThemeContext.Provider value={{ mode, setMode, resolvedTheme, settings, refreshSettings }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
