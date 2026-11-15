/**
 * Un QR code dans le terminal (12 novembre 2026) : l'appareil photo du téléphone ouvre Telegram
 * sur le robot, prêt à appairer (`phone.ts`). Le calcul vient de `qrcode` (son cœur seulement, du
 * JavaScript pur, intégré à `oathrion.mjs` à la construction) ; le dessin est ici.
 *
 * Noir sur blanc, forcé par les couleurs du terminal : un QR inversé (blanc sur noir, ce que
 * donnerait un terminal sombre) n'est pas lu par tous les téléphones. Deux lignes du code par
 * ligne de texte (les demi-blocs ▀ ▄), pour qu'il tienne dans une fenêtre.
 */
import { create } from "qrcode/lib/core/qrcode";

const WHITE_ON = "\x1b[47m\x1b[30m";
const RESET = "\x1b[0m";

export function terminalQr(text: string): string[] {
  const { modules } = create(text, { errorCorrectionLevel: "M" });
  const quiet = 2;
  const size = modules.size + quiet * 2;
  const dark = (row: number, col: number) => {
    const r = row - quiet;
    const c = col - quiet;
    return r >= 0 && c >= 0 && r < modules.size && c < modules.size && modules.get(r, c);
  };
  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col += 1) {
      const top = dark(row, col);
      const bottom = row + 1 < size && dark(row + 1, col);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(`${WHITE_ON}${line}${RESET}`);
  }
  return lines;
}
