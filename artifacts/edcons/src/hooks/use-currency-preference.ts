import { useEffect, useState, useCallback } from "react";
import { isSupportedCurrency, type CurrencyCode } from "@/lib/currency";

const STORAGE_PREFIX = "edcons_currency_pref_";

export type CurrencyFilter = CurrencyCode | "all";

export function useCurrencyPreference(scope: string, defaultCurrency: CurrencyCode | "all" = "USD") {
  const key = STORAGE_PREFIX + scope;
  const [currency, setCurrencyState] = useState<CurrencyFilter>(() => {
    if (typeof window === "undefined") return defaultCurrency;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === "all") return "all";
      if (isSupportedCurrency(stored)) return stored;
    } catch {}
    return defaultCurrency;
  });

  const setCurrency = useCallback((c: CurrencyFilter) => {
    setCurrencyState(c);
    try { window.localStorage.setItem(key, c); } catch {}
  }, [key]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) {
        window.localStorage.setItem(key, currency);
      }
    } catch {}
  }, [key]);

  return { currency, setCurrency };
}
