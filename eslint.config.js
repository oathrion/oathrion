import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    // shadcn/ui primitives are vendored verbatim; build output is generated.
    ignores: ["dist/**", "dist-npm/**", "dist-public/**", "node_modules/**", "client/src/components/ui/**", "client/src/hooks/use-mobile.tsx", "client/src/hooks/use-toast.ts", "*.config.*", "script/**", ".local-annonce/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /*
     * PHASE 12. Le worker d'identité est volontairement en CommonJS : il est exécuté par
     * `worker_threads` depuis un fichier sur disque, à côté du bundle, dans un projet
     * `type: module` — un `.mjs` ne pourrait pas résoudre `pg` depuis le node_modules du
     * déploiement de la même manière. Il est donc linté comme du CJS Node plutôt
     * qu'exclu du lint.
     */
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    /*
     * La page du téléphone, servie par le relais (`relay/public/`) : du JavaScript de navigateur
     * et de service worker, sans module. `common.js` y définit `OATH`, que les autres lisent.
     */
    files: ["relay/public/**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^OATH$" }] },
  },
  {
    files: ["relay/public/**/*.js"],
    ignores: ["relay/public/common.js"],
    languageOptions: { globals: { OATH: "readonly" } },
  },
);
