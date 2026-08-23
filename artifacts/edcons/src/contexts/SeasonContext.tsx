import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const STORAGE_KEY = "edcons_selected_season";
const currentYear = String(new Date().getFullYear());
const BASE_URL = (typeof import.meta !== "undefined" && import.meta.env?.BASE_URL?.replace(/\/$/, "")) || "";

const defaultYears = Array.from({ length: 6 }, (_, i) =>
  String(new Date().getFullYear() - 2 + i)
);

type SeasonContextType = {
  season: string;
  setSeason: (s: string) => void;
  availableYears: string[];
};

const SeasonContext = createContext<SeasonContextType>({
  season: currentYear,
  setSeason: () => {},
  availableYears: defaultYears,
});

export function SeasonProvider({ children }: { children: ReactNode }) {
  const [season, setSeasonState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || currentYear;
    } catch {
      return currentYear;
    }
  });

  const [availableYears, setAvailableYears] = useState<string[]>(defaultYears);

  useEffect(() => {
    fetch(`${BASE_URL}/api/settings/available-years`)
      .then(res => res.json())
      .then(data => {
        if (data.years && Array.isArray(data.years) && data.years.length > 0) {
          setAvailableYears(data.years.map(String));
        }
      })
      .catch(() => {});
  }, []);

  const setSeason = (s: string) => {
    setSeasonState(s);
    try {
      localStorage.setItem(STORAGE_KEY, s);
    } catch {}
  };

  return (
    <SeasonContext.Provider value={{ season, setSeason, availableYears }}>
      {children}
    </SeasonContext.Provider>
  );
}

export function useSeason() {
  return useContext(SeasonContext);
}
