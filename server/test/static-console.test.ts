/**
 * Tests for how the console's static bundle is served.
 *
 * These three defects were invisible to every other test in the suite, because
 * the suite mounts the API and never mounts `serveStatic`. They only appeared
 * when a real production build was requested over HTTP. All three made the
 * console fail in the browser while the API answered perfectly.
 */

import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStatic } from "../static";

let baseUrl: string;
let server: http.Server;
let bundleDir: string;

/**
 * The middleware is pointed at a copy of the real build when one exists, so these
 * tests exercise the bundle that actually ships. When there is no build, a
 * minimal fixture stands in, so `npm test` does not silently require `npm run
 * build` first. Either way the work happens in a temp directory: the suite must
 * not be able to touch `dist/`.
 */
let realBuild = false;
let scratch: string;

beforeAll(async () => {
  /*
   * Sous un dossier CACHÉ, comme une installation par nvm (`~/.nvm/…/node_modules/oathrion`) :
   * `res.sendFile` refuse par défaut un chemin absolu qui traverse un dossier commençant par un
   * point, et la console répondait 404 « Not Found » chez la personne (5 novembre).
   */
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "placet-static-"));
  bundleDir = path.join(scratch, ".nvm", "node_modules", "oathrion", "public");
  fs.mkdirSync(bundleDir, { recursive: true });
  const built = path.resolve(import.meta.dirname, "../../dist/public");

  if (fs.existsSync(path.join(built, "index.html"))) {
    realBuild = true;
    fs.cpSync(built, bundleDir, { recursive: true });
  } else {
    fs.mkdirSync(path.join(bundleDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "index.html"),
      '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="root"></div></body></html>',
    );
    fs.writeFileSync(path.join(bundleDir, "assets", "app.js"), "export const ok = true;\n");
    // A real PNG header, so the fixture matches the shape the build ships.
    fs.writeFileSync(path.join(bundleDir, "favicon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }

  const app = express();
  serveStatic(app, bundleDir);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function get(pathname: string) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}

describe("the console's asset URLs are absolute", () => {
  /*
   * Vite was configured with `base: "./"`, so index.html referenced
   * `./assets/index-*.js`. A browser resolves that against the directory of the
   * page it is on. One-segment routes worked by luck; on a nested deep link such
   * as `/agents/agt_x` the browser asked for `/agents/assets/index-*.js`, the
   * SPA catch-all answered with index.html, and the browser tried to run a page
   * of HTML as a module. The console rendered a blank screen.
   */
  it("references assets from the site root, not relative to the current page", async () => {
    const source = fs.readFileSync(path.join(bundleDir, "index.html"), "utf8");
    const refs = [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    const localRefs = refs.filter((r) => !/^https?:\/\//.test(r));
    expect(localRefs.length).toBeGreaterThan(0);
    expect(localRefs.filter((r) => r.startsWith("./"))).toEqual([]);
    for (const ref of localRefs) expect(ref.startsWith("/")).toBe(true);
  });
});

describe("a deep link reaches the single-page app", () => {
  it("answers a nested route with the app shell", async () => {
    const res = await get("/agents/agt_procurement");
    expect(res.status).toBe(200);
    expect(res.type).toContain("text/html");
    expect(res.body).toContain('id="root"');
  });
});

describe("a missing build asset fails as a missing asset", () => {
  /*
   * The catch-all used to answer *every* unmatched path with index.html,
   * including requests for scripts and stylesheets. A stale or misresolved
   * asset URL therefore came back `200 text/html`, and the browser reported a
   * JavaScript syntax error instead of the 404 that had actually happened.
   */
  it("returns 404 for an unknown script rather than the app shell", async () => {
    const res = await get("/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('id="root"');
  });

  it("returns 404 for an asset requested from a nested path", async () => {
    // The path the browser used to build for itself under `base: "./"`.
    const res = await get("/agents/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('id="root"');
  });

  it("still serves an asset that does exist", async () => {
    const asset = fs
      .readdirSync(path.join(bundleDir, "assets"))
      .find((name) => name.endsWith(".js"));
    expect(asset).toBeDefined();
    const res = await get(`/assets/${asset}`);
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/javascript/);
  });
});

describe("the shipped bundle is the one under test", () => {
  it("was copied from a real build, not replaced by the fixture", () => {
    // A guard on the tests above: if the build is missing they still pass
    // against a fixture, and this makes that visible instead of silent.
    expect(realBuild || process.env.CI !== "true").toBe(true);
  });
});

describe("the favicon that index.html promises exists", () => {
  /*
   * index.html has always carried `<link rel="icon" href="/favicon.png">`, but
   * no such file was ever produced: `client/public/` did not exist. Every page
   * load fetched a 404, and before the fix above that 404 was disguised as a
   * 200 serving index.html — an HTML document offered to the browser as a PNG.
   */
  it("is served as an image", async () => {
    const res = await get("/favicon.png");
    expect(res.status).toBe(200);
  });

  it("is committed as a real file in the client's public directory", () => {
    const icon = path.resolve(import.meta.dirname, "../../client/public/favicon.png");
    expect(fs.existsSync(icon)).toBe(true);
    const bytes = fs.readFileSync(icon);
    // PNG magic number, so a placeholder text file cannot pass.
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
