/**
 * La console locale se recharge d'elle-même quand Oathrion a été mis à jour (10 novembre : un
 * onglet ouvert avant la mise à jour montrait encore l'ancienne console, sans ce qui venait
 * d'être ajouté, et la personne concluait que « ça ne fonctionne pas »). La version qui tourne
 * est lue toutes les 15 s (`/api/local/login`) ; si elle change, on recharge la page. Une console
 * d'équipe n'a pas de version locale : rien ne se passe.
 */
import { useEffect, useRef } from "react";

export function ConsoleUpdater() {
  const first = useRef<string | null>(null);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/local/login", { credentials: "same-origin", headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { local?: unknown; build?: unknown };
        if (body.local !== true || typeof body.build !== "string") return;
        if (first.current === null) first.current = body.build;
        else if (body.build !== first.current && !stopped) window.location.reload();
      } catch {
        /* Oathrion redémarre peut-être : on réessaie au prochain tour */
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 15_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
  return null;
}
