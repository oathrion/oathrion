/**
 * Le QR code du terminal (`qr.ts`) : le dessin en demi-blocs redonne exactement la matrice
 * calculée, avec sa marge blanche, en noir sur blanc forcé.
 */
import { describe, expect, it } from "vitest";
import { create } from "qrcode/lib/core/qrcode";

import { terminalQr } from "./qr";

describe("le QR code du terminal", () => {
  it("redonne la matrice exacte, marge comprise, en noir sur blanc", () => {
    const text = "https://t.me/oathrion_test_bot?start=3f9a2c7e";
    const lines = terminalQr(text);
    const { modules } = create(text, { errorCorrectionLevel: "M" });
    const size = modules.size + 4;
    expect(lines).toHaveLength(Math.ceil(size / 2));
    const ESC = String.fromCharCode(27);
    const [open, close] = [`${ESC}[47m${ESC}[30m`, `${ESC}[0m`];
    for (const line of lines) expect(line.startsWith(open) && line.endsWith(close)).toBe(true);

    /* Relire les demi-blocs : deux rangées de modules par ligne. */
    const rows = lines.map((l) => [...l.slice(open.length, -close.length)]);
    const read = (r: number, c: number) => {
      const ch = rows[Math.floor(r / 2)]![c]!;
      return r % 2 === 0 ? ch === "█" || ch === "▀" : ch === "█" || ch === "▄";
    };
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const inside = r >= 2 && c >= 2 && r < modules.size + 2 && c < modules.size + 2;
        expect(read(r, c)).toBe(inside && Boolean(modules.get(r - 2, c - 2)));
      }
    }
  });
});
