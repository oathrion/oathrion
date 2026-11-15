/*
 * Injecté dans les paquets CJS (`script/build.ts`) : `import.meta.url` y vaut l'adresse du
 * fichier lui-même, comme en ESM. Sans lui, la valeur était vide et esbuild avertissait.
 */
export const __oathrion_import_meta_url = require("node:url").pathToFileURL(__filename).href;
