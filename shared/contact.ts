/**
 * Où joindre l'équipe d'Oathrion : UNE source, pour la commande (`oathrion retour`) et pour la
 * console (« Votre équipe »).
 *
 * Les deux valeurs sont des emplacements tant que l'adresse dédiée et le dépôt public
 * n'existent pas (`notes/PUBLICATION-10-NOVEMBRE.md`, U1 et U3). `npm run public:prepare` les
 * remplace (`--contact`, `--repo`) et refuse de produire l'arbre public tant qu'ils restent ;
 * `npm run pack:oathrion` fait de même pour le paquet npm.
 */
export const CONTACT_EMAIL = "contact@oathrion.com";
export const REPOSITORY_URL = "https://github.com/oathrion/oathrion";

/**
 * Les emplacements sont-ils remplacés ? (La commande et la console le disent au lieu d'envoyer
 * nulle part.) Le test ne recopie pas le texte des emplacements : le garde-fou du paquet le
 * chercherait, et le trouverait ici.
 */
export function contactReady(): boolean {
  return CONTACT_EMAIL.includes("@") && !/\/OWNER\//.test(REPOSITORY_URL);
}
