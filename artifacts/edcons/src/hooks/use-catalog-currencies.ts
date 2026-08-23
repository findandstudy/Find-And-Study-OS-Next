import { useQuery } from "@tanstack/react-query";
import { SUPPORTED_CURRENCIES } from "@/lib/currency";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

/**
 * Active currency codes from catalog_options (category='currency'),
 * ordered by sort_order. This is the authoritative list every currency
 * dropdown across the app should bind to. Falls back to the seeded
 * 5 base codes while the network request is in flight or if the
 * catalog is empty for any reason.
 */
export function useCatalogCurrencies(): string[] {
  const { data } = useQuery<{ grouped?: Record<string, Array<{ value: string; isActive: boolean; sortOrder: number }>> }>({
    queryKey: ["catalog-options"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/catalog-options`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    staleTime: 60_000,
  });
  const rows = data?.grouped?.currency ?? [];
  const list = rows
    .filter(r => r.isActive)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map(r => String(r.value).toUpperCase())
    .filter(c => /^[A-Z]{2,5}$/.test(c));
  return list.length > 0 ? list : [...SUPPORTED_CURRENCIES];
}
