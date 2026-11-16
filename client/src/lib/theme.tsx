import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type Theme = "light" | "dark";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "light",
  toggle: () => {},
});

/*
 * Nouvelle clé le 16 novembre : l'ancienne gardait « dark » même sans choix de la personne
 * (l'effet ci-dessous l'écrit à chaque chargement), ce qui aurait caché le passage au clair.
 */
const STORED = "oathrion-theme-2";

/*
 * Clair d'abord (16 novembre : la console prend l'allure du site) ; le choix de la personne,
 * s'il y en a un, est gardé dans ce navigateur.
 */
function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(STORED);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* stockage indisponible : le défaut */
  }
  return "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (typeof window !== "undefined" ? initialTheme() : "light"));

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    try {
      window.localStorage.setItem(STORED, theme);
    } catch {
      /* stockage indisponible : le thème vaut pour cette page */
    }
  }, [theme]);

  const value = useMemo(
    () => ({ theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) }),
    [theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
