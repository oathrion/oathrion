/**
 * LE CORPS BRUT EST UNE SUITE D'OCTETS, PAS DU TEXTE.
 *
 * ## Le défaut que ce fichier ferme
 *
 * Le relais portait le corps brut dans un `string` et le transport l'écrivait en UTF-8.
 * Pour du JSON et du form-encoded, ça marche. Pour un téléversement `multipart` contenant
 * un PNG, non : chaque octet au-dessus de 0x7F devient DEUX octets à l'écriture.
 *
 * Mesuré par `intercept-multipart.test.ts` : 288 octets envoyés, **293 reçus**, et 2 Mio
 * d'aléatoire devenaient 3 Mio. Un fichier systématiquement corrompu, sans erreur nulle
 * part — le fournisseur reçoit un `multipart` bien formé dont la pièce est illisible, et
 * personne ne le sait avant de l'ouvrir.
 *
 * ## LA CONVENTION, ÉCRITE UNE FOIS
 *
 * Un corps brut voyage en **latin1** : un octet, un point de code, dans les deux sens.
 * C'est la seule correspondance 1:1 entre octets et caractères que JavaScript offre, donc
 * la seule qui survive à un aller-retour pour des octets ARBITRAIRES.
 *
 * Pourquoi pas un `Buffer` partout, qui serait le type honnête : parce que le corps est
 * aussi **scellé dans le sas d'approbation**, où une valeur chiffrée est une chaîne. Le
 * porter en `Buffer` demanderait un encodage base64 dans la table, donc une colonne de
 * plus et une migration, pour un gain de typage. La convention latin1 coûte une fonction
 * et un test qui la garde.
 *
 * Ce que ce fichier existe pour empêcher : que cette convention soit un souvenir réparti
 * dans cinq fichiers. Qui lit ou écrit un corps brut passe par ici.
 */

/**
 * L'encodage du corps brut sur tout son trajet : capture, scellement, relais, hachage.
 *
 * `latin1` et non `binary` : les deux sont le même encodage pour Node, et `latin1` est le
 * nom que la documentation emploie — un alias moins connu dans un endroit qui décide de
 * l'intégrité d'un fichier n'aide personne.
 */
export const RAW_BODY_ENCODING = "latin1" as const;

/** Les octets réels d'un corps brut porté en chaîne. */
export function rawBytes(body: string): Buffer {
  return Buffer.from(body, RAW_BODY_ENCODING);
}

/** Un corps brut, porté en chaîne sans perte. */
export function rawString(bytes: Buffer): string {
  return bytes.toString(RAW_BODY_ENCODING);
}
