import { createContext, useContext } from "react";
import { type Language } from "./index";

export interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
  dir: "ltr" | "rtl";
  isRTL: boolean;
  localePath: (path: string) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18nContext(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18nContext must be used within I18nProvider");
  return ctx;
}
