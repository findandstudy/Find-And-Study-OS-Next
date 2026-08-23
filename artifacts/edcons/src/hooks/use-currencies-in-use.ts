import { useQuery } from "@tanstack/react-query";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/currency";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export function useCurrenciesInUse(): { list: CurrencyCode[]; isReady: boolean } {
  const { data, isFetched } = useQuery<{ currencies: string[] }>({
    queryKey: ["currencies-in-use"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/currencies-in-use`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    staleTime: 60_000,
  });
  if (!isFetched) {
    return { list: [...SUPPORTED_CURRENCIES] as CurrencyCode[], isReady: false };
  }
  // Trust the backend: it returns the intersection of the configured
  // currency catalog and the codes actually present in data, already
  // ordered by sort_order. We just uppercase + de-dupe defensively.
  const seen = new Set<string>();
  const list: CurrencyCode[] = [];
  for (const raw of data?.currencies ?? []) {
    const c = String(raw ?? "").toUpperCase().trim();
    if (!/^[A-Z]{2,5}$/.test(c)) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    list.push(c);
  }
  return { list: list.length > 0 ? list : (["USD"] as CurrencyCode[]), isReady: true };
}
