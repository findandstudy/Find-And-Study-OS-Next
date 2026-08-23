import { useCallback, useEffect, useMemo, useState } from "react";

export interface TablePrefs {
  order: string[];
  hidden: string[];
}

export interface UseTablePrefsResult {
  prefs: TablePrefs;
  visibleOrdered: string[];
  isHidden: (id: string) => boolean;
  toggleHidden: (id: string) => void;
  moveColumn: (id: string, dir: -1 | 1) => void;
  reset: () => void;
}

function storageKey(key: string, userId: string | number | undefined): string {
  return `tablePrefs:${key}:${userId ?? "anon"}`;
}

function mergeWithDefaults(stored: Partial<TablePrefs> | null, defaults: TablePrefs): TablePrefs {
  if (!stored) return { order: [...defaults.order], hidden: [...defaults.hidden] };
  const allowed = new Set(defaults.order);
  const storedOrder = Array.isArray(stored.order) ? stored.order.filter((id) => allowed.has(id)) : [];
  const order = [...storedOrder];
  for (const id of defaults.order) if (!order.includes(id)) order.push(id);
  const hidden = Array.isArray(stored.hidden) ? stored.hidden.filter((id) => allowed.has(id)) : [];
  return { order, hidden };
}

export function useTablePrefs(
  key: string,
  defaults: TablePrefs,
  userId?: string | number,
): UseTablePrefsResult {
  const sk = storageKey(key, userId);
  const [prefs, setPrefs] = useState<TablePrefs>(() => {
    if (typeof window === "undefined") return { order: [...defaults.order], hidden: [...defaults.hidden] };
    try {
      const raw = window.localStorage.getItem(sk);
      const parsed = raw ? (JSON.parse(raw) as Partial<TablePrefs>) : null;
      return mergeWithDefaults(parsed, defaults);
    } catch {
      return { order: [...defaults.order], hidden: [...defaults.hidden] };
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(sk);
      const parsed = raw ? (JSON.parse(raw) as Partial<TablePrefs>) : null;
      setPrefs(mergeWithDefaults(parsed, defaults));
    } catch {
      setPrefs({ order: [...defaults.order], hidden: [...defaults.hidden] });
    }
  }, [sk, defaults.order.join("|")]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(sk, JSON.stringify(prefs));
    } catch {
      /* quota or disabled — ignore */
    }
  }, [sk, prefs]);

  const toggleHidden = useCallback((id: string) => {
    setPrefs((p) => ({
      ...p,
      hidden: p.hidden.includes(id) ? p.hidden.filter((x) => x !== id) : [...p.hidden, id],
    }));
  }, []);

  const moveColumn = useCallback((id: string, dir: -1 | 1) => {
    setPrefs((p) => {
      const idx = p.order.indexOf(id);
      if (idx < 0) return p;
      const ni = idx + dir;
      if (ni < 0 || ni >= p.order.length) return p;
      const next = p.order.slice();
      next.splice(idx, 1);
      next.splice(ni, 0, id);
      return { ...p, order: next };
    });
  }, []);

  const reset = useCallback(() => {
    setPrefs({ order: [...defaults.order], hidden: [...defaults.hidden] });
  }, [defaults.order.join("|"), defaults.hidden.join("|")]);

  const visibleOrdered = useMemo(
    () => prefs.order.filter((id) => !prefs.hidden.includes(id)),
    [prefs.order, prefs.hidden],
  );

  const isHidden = useCallback((id: string) => prefs.hidden.includes(id), [prefs.hidden]);

  return { prefs, visibleOrdered, isHidden, toggleHidden, moveColumn, reset };
}

function filterStorageKey(key: string, field: string, userId: string | number | undefined): string {
  return `tableFilter:${key}:${field}:${userId ?? "anon"}`;
}

/**
 * Persist a single table filter value (e.g. the "Assigned to" choice) to
 * localStorage, scoped per table + field + user — mirroring the column-pref
 * persistence above. Re-reads when the storage key (user) changes so the
 * saved value is restored once auth resolves.
 */
export function usePersistedFilterValue(
  key: string,
  field: string,
  defaultValue: string,
  userId?: string | number,
): [string, (v: string) => void] {
  const sk = filterStorageKey(key, field, userId);
  const [value, setValueState] = useState<string>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const raw = window.localStorage.getItem(sk);
      return raw != null ? raw : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(sk);
      setValueState(raw != null ? raw : defaultValue);
    } catch {
      setValueState(defaultValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sk]);

  const setValue = useCallback((v: string) => {
    setValueState(v);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(sk, v);
    } catch {
      /* quota or disabled — ignore */
    }
  }, [sk]);

  return [value, setValue];
}
