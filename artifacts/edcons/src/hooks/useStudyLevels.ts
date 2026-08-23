import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@workspace/api-client-react";

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, "") || "";

export interface StudyLevel {
  id: number;
  key: string;
  label: string;
  sortOrder: number;
  enabled: boolean;
  isDefault: boolean;
}

export const FALLBACK_STUDY_LEVELS: StudyLevel[] = [
  { id: -1, key: "Bachelor", label: "Bachelor", sortOrder: 1, enabled: true, isDefault: true },
  { id: -2, key: "Master", label: "Master", sortOrder: 2, enabled: true, isDefault: true },
  { id: -3, key: "Ph.D", label: "Ph.D", sortOrder: 3, enabled: true, isDefault: true },
  { id: -4, key: "Associate", label: "Associate", sortOrder: 4, enabled: true, isDefault: true },
];

interface CatalogOptionRaw {
  id: number;
  category: string;
  value: string;
  sortOrder: number;
  isActive: boolean;
}

export function useStudyLevels(opts?: { onlyEnabled?: boolean }) {
  const onlyEnabled = opts?.onlyEnabled !== false;
  const query = useQuery<CatalogOptionRaw[]>({
    queryKey: ["catalog-options", "degree"],
    queryFn: async () => {
      const res: any = await customFetch(`${BASE_URL}/api/catalog-options`);
      const grouped = res?.grouped || {};
      return Array.isArray(grouped.degree) ? (grouped.degree as CatalogOptionRaw[]) : [];
    },
    staleTime: 60_000,
  });

  const levels = useMemo<StudyLevel[]>(() => {
    const data: StudyLevel[] = (query.data && query.data.length > 0)
      ? query.data.map(o => ({
          id: o.id,
          key: o.value,
          label: o.value,
          sortOrder: o.sortOrder,
          enabled: o.isActive,
          isDefault: false,
        }))
      : FALLBACK_STUDY_LEVELS;
    const filtered = onlyEnabled ? data.filter(l => l.enabled) : data;
    return [...filtered].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }, [query.data, onlyEnabled]);

  const labelOf = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of levels) m[l.key] = l.label;
    return (key: string | null | undefined) => (key ? (m[key] ?? key) : "");
  }, [levels]);

  const hasCatalogData = Array.isArray(query.data) && query.data.length > 0;

  return {
    levels,
    labelOf,
    isLoading: query.isLoading,
    isError: query.isError,
    hasCatalogData,
    refetch: query.refetch,
  };
}
