import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  /*
   * Absolute, not "./".
   *
   * The console is a single-page app whose deep links are nested
   * (`/agents/agt_x`, `/executions/exe_x`), and the server answers any unmatched
   * path with `index.html`. With a relative base the browser resolved
   * `./assets/index-*.js` against the *current* directory, so opening or
   * reloading `/agents/agt_x` requested `/agents/assets/index-*.js` — which the
   * catch-all happily answered with `index.html`. The browser then tried to
   * execute a page of HTML as JavaScript and the console rendered blank. Every
   * one-segment route worked, which is why it survived casual testing.
   */
  base: "/",
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    /*
     * DEUX ENTRÉES : la console et le site public.
     *
     * Elles n'ont ni le même public, ni les mêmes dépendances, ni la même durée de vie.
     * Les fondre en une seule application aurait fait télécharger la console entière à un
     * visiteur venu lire une page — et inversement. Deux entrées, deux bundles, des
     * `assets/` partagés : React et le routeur ne sont téléchargés qu'une fois par
     * quelqu'un qui visite les deux.
     *
     * `console` reste `dist/public/index.html` pour que rien de son chaînage d'actifs ne
     * change ; `server/static.ts` décide ensuite quel document répond à quel chemin.
     */
    // The console shipped as one 890 kB JavaScript file, so the sign-in screen
    // could not paint until the charting library, every Radix primitive and the
    // whole icon set had downloaded and parsed. Splitting the stable vendor code
    // into its own chunks also means a release that only touches application
    // code no longer invalidates the vendor cache.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      /*
       * Les deux entrées, dans le MÊME `rollupOptions` que `output`.
       *
       * Un second objet `rollupOptions` écraserait silencieusement le premier : le
       * découpage en chunks de la console aurait disparu sans qu'aucune erreur ne le
       * dise, et la régression — une console qui redevient un seul fichier de 890 ko —
       * ne se serait vue qu'au chargement.
       */
      input: {
        console: path.resolve(import.meta.dirname, "client", "index.html"),
        site: path.resolve(import.meta.dirname, "client", "site", "index.html"),
      },
      output: {
        /*
         * Only the four heavy, self-contained libraries are named. Everything
         * else is left to Rollup.
         *
         * An earlier version added a catch-all `vendor` group and folded the
         * router in with React. That produced circular chunks
         * (`vendor -> react -> vendor`), because a package assigned to `vendor`
         * imported one assigned to `react` and vice versa — a cycle between
         * chunks forces the browser to fetch both before either can evaluate,
         * which is the opposite of what splitting is for.
         */
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          /*
           * React d'abord, et dans SON propre chunk.
           *
           * Depuis que le build a deux entrées, `manualChunks` s'applique au graphe des
           * DEUX : sans cette ligne, Rollup fondait React dans le chunk `query` (parce
           * que @tanstack en dépend) et hissait un import Radix dans le préambule
           * partagé. Résultat mesuré : le document du site préchargeait 248 ko de Radix
           * et 44 ko de react-query qu'il n'utilise pas — pour un bundle propre de 87 ko.
           *
           * React isolé, la base partagée entre la console et le site ne contient plus
           * que React : chaque entrée ne tire que ce qu'elle importe vraiment.
           */
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
          if (id.includes("@radix-ui")) return "radix";
          if (id.includes("lucide-react")) return "icons";
          if (id.includes("@tanstack")) return "query";
          return undefined;
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
