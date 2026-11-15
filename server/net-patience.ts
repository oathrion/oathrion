/**
 * LA PATIENCE DU RÉSEAU (essai réel du 10 novembre, au Sénégal).
 *
 * Node essaie les adresses d'un hôte l'une après l'autre (IPv4, IPv6), et n'accorde par défaut
 * que 250 ms à chacune. Sur une connexion où joindre Google prend parfois plus de 250 ms, l'essai
 * IPv4 était abandonné, l'IPv6 échouait (pas d'IPv6 sur la machine), et la connexion tombait :
 * 3 échecs sur 8, tous à 252 ms ; avec 2,5 s par adresse, 8 sur 8. Vu par la personne : `agy`
 * enfermé, déconnecté (« Bad Gateway » du mandataire de la prison). Importé en premier par les
 * points d'entrée : toutes les connexions sortantes d'Oathrion en profitent.
 */
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

export const ADDRESS_ATTEMPT_MS = 2_500;

setDefaultAutoSelectFamilyAttemptTimeout(ADDRESS_ATTEMPT_MS);
