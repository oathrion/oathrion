/**
 * La forme canonique d'une valeur JSON : clés triées, sans espace. La MÊME chaîne partout où on
 * la recalcule — le serveur (`node:crypto`), le navigateur (WebCrypto), une contrepartie — pour
 * que les signatures des reçus et des mandats portent sur exactement les mêmes octets.
 *
 * Sans aucune dépendance, pour que la console puisse l'importer.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}
