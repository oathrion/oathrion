/** Le cœur de `qrcode` (`cli/wrap/qr.ts`) : le paquet ne déclare pas de types pour ce chemin. */
declare module "qrcode/lib/core/qrcode" {
  export function create(
    text: string,
    options?: { errorCorrectionLevel?: "L" | "M" | "Q" | "H" },
  ): { modules: { size: number; get(row: number, col: number): number | boolean } };
}
