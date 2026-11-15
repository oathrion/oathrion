/**
 * La console est-elle celle d'`oathrion wrap`, sur la machine de la personne ? Elle n'y propose
 * pas le parcours d'équipe (créer, brancher un agent) : en local, un agent est un client MCP, et
 * on en ajoute un en branchant ce client (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`).
 */
import { useQuery } from "@tanstack/react-query";

import { sessionInfo } from "@/lib/api";

export function useLocalMode(): boolean {
  const session = useQuery({ queryKey: ["/api/auth/session", "mode"], queryFn: sessionInfo, staleTime: Infinity });
  return session.data?.localMode === true;
}
