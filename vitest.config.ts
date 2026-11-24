import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
    },
  },
  test: {
    environment: "node",
    // `client/**` was absent, so every display rule in the console was unrunnable by
    // the suite — the frontend gate could only ever be asserted by reading the code.
    // Only pure `.ts` modules are picked up (no `.tsx`): the display decisions live in
    // plain functions precisely so they can be tested here without a DOM.
    // `sdk/**` and `cli/**` are Phase 8 surfaces. They are listed here for the
    // same reason `client/**` was added: code the runner does not collect is
    // code the gate cannot fail on, and a published SDK that no test executes
    // is the worst place in the tree to have that blind spot.
    include: [
      "shared/**/*.test.ts",
      "server/**/*.test.ts",
      "client/**/*.test.ts",
      "sdk/**/*.test.ts",
      "cli/**/*.test.ts",
      // The framework adapter ships as an example, but its guarantees are the
      // product’s: a wrapped tool must not run without an ALLOW. Untested
      // example code that people copy is worse than no example at all.
      "examples/**/*.test.ts",
      // Le relais du téléphone (`relay/`) : il porte les décisions prises sur le téléphone.
      "relay/test/**/*.test.ts",
    ],
    setupFiles: ["server/test/setup.ts"],
    // The integration suite shares one SQLite file; run suites serially.
    fileParallelism: false,
  },
});
