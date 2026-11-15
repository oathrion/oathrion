/**
 * LE REFUS IMMÉDIAT QUAND OATHRION EST DÉBORDÉ — un plafond de requêtes en cours.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Sous la charge, Oathrion ne refusait jamais : il faisait attendre. À 1 024 agents
 * simultanés (`verify:load`, journal §5.27), le p99 d'un cycle « autoriser puis
 * exécuter » atteignait 20 s et celui d'une décision 10 s — au-delà du délai de
 * nombreux clients HTTP, qui abandonnent alors une requête qu'Oathrion finira peut-être
 * par traiter. Le seul garde-fou était accidentel : une requête qui attendait plus de 5 s
 * une connexion à la base recevait un 503. Un agent ne peut rien faire d'une attente
 * sans fin ; il peut faire quelque chose d'un refus net.
 *
 * ## Ce que fait le plafond
 *
 * Au-delà de `OATHRION_MAX_IN_FLIGHT` requêtes `/api` en cours sur CETTE instance, la
 * suivante reçoit aussitôt **503 `overloaded`** avec un `Retry-After` qui croît avec le
 * débordement (`retryAfterSeconds`), AVANT
 * l'authentification et avant toute base : refuser ne coûte presque rien, ce qui est le
 * but quand on est débordé. Rien n'a été décidé ni exécuté, donc le réessai est sûr.
 *
 * Pas comptées : les sondes (`/api/live`, `/api/ready`, `/api/health`, `/api/metrics`).
 * Un orchestrateur qui voit sa sonde refusée sous la charge retire l'instance, et
 * reporte la charge sur les autres — l'effondrement en cascade.
 *
 * ## Le défaut par défaut
 *
 * 256. Choisi sur la mesure, pas au jugé : au-delà, sur la machine du banc (2 cœurs),
 * le cycle complet dépassait 5 s de p99 et la décision 2 s. Une machine plus grosse le
 * relève ; `0` coupe le plafond (le comportement d'avant). Le plafond est par instance :
 * plusieurs instances derrière un répartiteur ont chacune le leur.
 *
 * ## Ce qu'il ne fait pas
 *
 * Il n'est pas équitable entre organisations : une organisation très active peut
 * occuper le plafond. Le limiteur de débit par clé reste la protection par locataire ;
 * ce plafond protège le PROCESSUS. Une réponse en flux (relais `stream`) occupe sa place
 * jusqu'à la fin du flux.
 */
import type { NextFunction, Request, Response } from "express";

import { ERROR_CODES } from "@shared/error-codes";
import { sendApiError } from "./api-error";
import { unversionedPath } from "@shared/api-version";
import { increment } from "./observability/metrics";
import { surfaceOf } from "./observability/route";

export const DEFAULT_MAX_IN_FLIGHT = 256;

const PROBES = new Set(["/api/live", "/api/ready", "/api/health", "/api/metrics"]);

/** Le plafond demandé. `0` le coupe ; une valeur illisible ou négative garde le défaut. */
export function maxInFlight(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OATHRION_MAX_IN_FLIGHT?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_IN_FLIGHT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_MAX_IN_FLIGHT;
  return Math.floor(value);
}

export interface Admission {
  (req: Request, res: Response, next: NextFunction): void;
  /** Les requêtes en cours, pour les tests et la supervision. */
  inFlight(): number;
}

/**
 * Le délai annoncé dans `Retry-After`, PROPORTIONNEL au débordement.
 *
 * Il valait 1 s fixe. Mesuré à 1 024 clients pour un plafond de 256 (journal §5.28) :
 * les ~770 refusés revenaient chaque seconde, soit ~700 refus par seconde, et ce flot de
 * refus — si bon marché soit chacun — prenait au processus le temps des requêtes admises.
 * Le débit UTILE tombait de moitié. Un délai qui croît avec le nombre de refus de la
 * seconde écoulée étale les retours : un refus par place disponible et par seconde
 * reste à 1 s, au-delà chaque multiple ajoute une seconde, jusqu'à 30 s.
 */
export function retryAfterSeconds(refusedLastSecond: number, limit: number): number {
  if (limit <= 0) return 1;
  return Math.min(30, 1 + Math.floor(refusedLastSecond / limit));
}

export function admissionControl(limit: number = maxInFlight()): Admission {
  let inFlight = 0;
  /* Les refus de la seconde en cours et de la précédente : de quoi régler `Retry-After`. */
  let windowStart = Date.now();
  let refusedThisSecond = 0;
  let refusedLastSecond = 0;
  const middleware = ((req: Request, res: Response, next: NextFunction): void => {
    /* Le chemin sans préfixe de version : `/api/v1/live` est une sonde comme `/api/live`. */
    const path = unversionedPath(req.path);
    if (limit <= 0 || !path.startsWith("/api") || PROBES.has(path)) return next();
    if (inFlight >= limit) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        refusedLastSecond = now - windowStart >= 2000 ? 0 : refusedThisSecond;
        refusedThisSecond = 0;
        windowStart = now;
      }
      refusedThisSecond += 1;
      increment("oathrion_admission_shed_total", { surface: surfaceOf(path) });
      res.setHeader("Retry-After", String(retryAfterSeconds(Math.max(refusedLastSecond, refusedThisSecond), limit)));
      return sendApiError(
        res,
        503,
        "Oathrion is overloaded: the request was not processed, nothing was decided or executed. Try again in a moment.",
        ERROR_CODES.overloaded,
        { limit },
      );
    }
    inFlight += 1;
    let released = false;
    /*
     * `finish` quand la réponse est partie, `close` quand le client a coupé avant : l'un
     * ou l'autre, une seule fois. Sans `close`, chaque client qui abandonne laisserait une
     * place occupée pour toujours, et le plafond finirait par tout refuser.
     */
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  }) as Admission;
  middleware.inFlight = () => inFlight;
  return middleware;
}
