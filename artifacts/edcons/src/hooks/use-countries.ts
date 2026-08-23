import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiFetch";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

/** Generic debounce so server-side (AJAX) searches don't fire on every keystroke. */
export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export interface DialCodeCountry {
  id: number;
  name: string;
  code: string; // ISO alpha-2
  flagEmoji?: string | null;
  dialCode: string; // e.g. "+90"
}

/**
 * Server-side (AJAX) debounced search over the country catalog, restricted to
 * countries that actually carry a dial code. Used by every phone-code dropdown.
 * Hits the public (no-auth) endpoint so it works in public widgets and authed
 * pages alike. Returns active, dial-coded countries ordered by name.
 */
export function useDialCodeCountries(search: string) {
  const debounced = useDebouncedValue(search.trim(), 250);
  return useQuery<DialCodeCountry[]>({
    queryKey: ["dial-code-countries", debounced],
    queryFn: async () => {
      const params = new URLSearchParams({ withDialCode: "1" });
      if (debounced) params.set("search", debounced);
      const res = await apiFetch(`${BASE_URL}/api/public/countries?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.data ?? json ?? []) as DialCodeCountry[];
    },
    staleTime: 5 * 60_000,
  });
}

export interface CountryOption {
  id: number;
  name: string;
  code: string;
  flagEmoji?: string | null;
  dialCode?: string | null;
}

/**
 * Server-side (AJAX) debounced search over active countries (no dial-code
 * filter) for nationality / country selectors. Public endpoint so it is usable
 * everywhere.
 */
export function useCountrySearch(search: string) {
  const debounced = useDebouncedValue(search.trim(), 250);
  return useQuery<CountryOption[]>({
    queryKey: ["country-search", debounced],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debounced) params.set("search", debounced);
      const res = await apiFetch(`${BASE_URL}/api/public/countries?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.data ?? json ?? []) as CountryOption[];
    },
    staleTime: 5 * 60_000,
  });
}
