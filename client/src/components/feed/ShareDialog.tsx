/**
 * PARTAGER CE QU'OATHRION A FAIT (11 novembre : « un bouton partage, pour montrer sur les
 * réseaux, à leurs amis ou collaborateurs »). Une carte au format des réseaux (1200 × 630) : la
 * mascotte de l'agent, la phrase À PARTAGER de l'élément du fil (`share`, sans rien de privé :
 * ni chemin, ni fichier, ni commande, ni numéro de processus), la date, « Protected by
 * Oathrion ». La personne la télécharge, copie le texte, ou l'envoie sur X, LinkedIn, WhatsApp
 * (le texte part dans l'adresse ; l'image, elle l'ajoute). Rien n'est envoyé sans son clic.
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Download, Image as ImageIcon, Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { FeedItem } from "@/lib/api";
import { DANGER_ACCENT, MASCOT_ACCENTS, type MascotId } from "@shared/mascots";
import { shareText as shareWords, shareUrl, type ShareNetwork } from "@shared/share";

const CARD = { width: 1200, height: 630 };

/** Le texte du message : la phrase, et de quoi trouver Oathrion (le même que depuis la notification). */
export const shareText = (item: FeedItem) => shareWords(item.share);

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (context.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Où commence la fin de la phrase, mise en couleur (« …, and I stopped it in one click. »). */
function accentFrom(sentence: string): number {
  for (const cut of [", and ", "; ", ": "]) {
    const at = sentence.lastIndexOf(cut);
    if (at > 0) return at + (cut === ", and " ? 2 : cut.length);
  }
  return sentence.length;
}

const FONT = "Inter, 'Noto Sans', system-ui, sans-serif";
const HEADLINE = "'Space Grotesk', Inter, 'Noto Sans', system-ui, sans-serif";
const SHIELD = new Path2D("M12 1 2.5 5v7c0 6.2 4.1 11.9 9.5 13.5 5.4-1.6 9.5-7.3 9.5-13.5V5L12 1z");
const SPARK = new Path2D("M12 7.5l1.4 4 4 1.4-4 1.4-1.4 4-1.4-4-4-1.4 4-1.4z");

/**
 * Dessine la carte, comme celle de la notification (la maquette du 11 novembre) : la mascotte
 * en grand sur son halo, la phrase avec sa fin en couleur, la date, la signature ; rend une
 * promesse résolue quand la mascotte est chargée.
 */
export async function drawCard(canvas: HTMLCanvasElement, item: FeedItem): Promise<void> {
  canvas.width = CARD.width;
  canvas.height = CARD.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const accent = item.agent === "decoy" ? DANGER_ACCENT : MASCOT_ACCENTS[item.mascot.id as MascotId] ?? MASCOT_ACCENTS.warden;
  const base = context.createLinearGradient(0, 0, CARD.width, CARD.height);
  base.addColorStop(0, "#080718");
  base.addColorStop(0.55, "#090D20");
  base.addColorStop(1, "#050713");
  context.fillStyle = base;
  context.fillRect(0, 0, CARD.width, CARD.height);
  const corner = context.createRadialGradient(1056, 113, 0, 1056, 113, 420);
  corner.addColorStop(0, "rgba(49,65,164,.17)");
  corner.addColorStop(1, "rgba(49,65,164,0)");
  context.fillStyle = corner;
  context.fillRect(0, 0, CARD.width, CARD.height);
  /* La mascotte, à gauche, sur un halo de sa couleur. */
  const halo = context.createRadialGradient(240, 315, 0, 240, 315, 270);
  halo.addColorStop(0, accent.glow);
  halo.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = halo;
  context.fillRect(0, 0, 560, CARD.height);
  const image = new Image();
  image.src = `/mascots/${item.mascot.id}.png`;
  await new Promise<void>((done) => {
    image.onload = () => done();
    image.onerror = () => done();
  });
  if (image.complete && image.naturalWidth > 0) context.drawImage(image, 20, 95, 440, 440);
  /* La phrase, à droite, centrée en hauteur ; sa fin dans la couleur de la mascotte. */
  context.font = `700 44px ${HEADLINE}`;
  const lines = wrap(context, item.share, 670).slice(0, 6);
  const top = Math.max(70, 290 - (lines.length * 57) / 2);
  const cut = accentFrom(item.share);
  let seen = 0;
  lines.forEach((line, index) => {
    const y = top + index * 57 + 44;
    const from = Math.max(0, Math.min(line.length, cut - seen));
    context.fillStyle = "#F8F6FF";
    context.fillText(line.slice(0, from), 480, y);
    context.fillStyle = accent.highlight;
    context.fillText(line.slice(from), 480 + context.measureText(line.slice(0, from)).width, y);
    seen += line.length + 1;
  });
  context.fillStyle = "#B6B4D1";
  context.font = `400 17px ${FONT}`;
  context.fillText(new Date(item.at).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), 480, top + lines.length * 57 + 40);
  /* La signature, sous un filet. */
  context.fillStyle = "#2D2850";
  context.fillRect(480, 548, 675, 1);
  context.save();
  context.translate(482, 562);
  context.scale(0.75, 0.75);
  context.fillStyle = accent.main;
  context.fill(SHIELD);
  context.fillStyle = "#FFFFFF";
  context.fill(SPARK);
  context.restore();
  context.font = `500 14px ${FONT}`;
  const signed = "Protected by Oathrion · the guard for AI agents · ";
  context.fillStyle = "#B7B5D0";
  context.fillText(signed, 510, 580);
  const after = 510 + context.measureText(signed).width;
  context.font = `700 14px ${FONT}`;
  context.fillStyle = accent.highlight;
  context.fillText("npx oathrion", after, 580);
}

const NETWORK_NAMES: Record<ShareNetwork, string> = { linkedin: "LinkedIn", x: "X", whatsapp: "WhatsApp" };

/**
 * `network` : ouverte depuis la notification pour CE réseau (`/share`) ; un seul grand bouton
 * copie la carte puis ouvre le post. Le navigateur copie lui-même : rien ne se perd en route.
 */
export function ShareDialog({ item, onClose, network }: { item: FeedItem | null; onClose: () => void; network?: ShareNetwork }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  /* La carte de QUEL élément est dessinée (prête à télécharger). */
  const [drawnFor, setDrawnFor] = useState<string | null>(null);
  const ready = item !== null && drawnFor === item.id;
  const { toast } = useToast();

  useEffect(() => {
    if (!item) return;
    const frame = requestAnimationFrame(() => {
      if (canvas.current) void drawCard(canvas.current, item).then(() => setDrawnFor(item.id));
    });
    return () => cancelAnimationFrame(frame);
  }, [item]);

  if (!item) return null;
  const text = shareText(item);
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const blob = () => new Promise<Blob | null>((done) => canvas.current?.toBlob(done, "image/png") ?? done(null));

  const download = async () => {
    const png = await blob();
    if (!png) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(png);
    link.download = `oathrion-${item.mascot.id}-${item.at.slice(0, 10)}.png`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  /*
   * LinkedIn, X et WhatsApp ne prennent que du TEXTE dans un lien de partage : un site ne peut pas
   * y joindre une image (essai réel du 11 novembre : le post partait sans la mascotte). La carte
   * est donc copiée dans le presse-papiers AVANT d'ouvrir le réseau ; la personne la colle dans sa
   * publication (Ctrl+V). La copie d'abord : une fois le nouvel onglet ouvert, la console n'a plus
   * la main, et le presse-papiers refuse.
   */
  const copyImage = async (): Promise<boolean> => {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return false;
    try {
      /* L'image promise, pas attendue : l'écriture part pendant le clic lui-même (Safari l'exige). */
      const png = blob().then((made) => made ?? Promise.reject(new Error("no image")));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    } catch {
      return false;
    }
  };
  const toNetwork = async (name: string, url: string) => {
    const copied = await copyImage();
    /* Sans presse-papiers (refusé, navigateur ancien) : la carte est enregistrée, à joindre au post. */
    if (!copied) await download();
    open(url);
    toast({
      title: copied ? `The card is copied: paste it into your ${name} post` : `The card is saved: attach it to your ${name} post`,
      description: copied
        ? "In the post, press Ctrl+V (Cmd+V on a Mac): the card with the mascot appears under the text."
        : "It is in your downloads folder; add it to the post as an image.",
    });
  };
  const copyCard = async () => {
    const copied = await copyImage();
    toast(copied ? { title: "The card is copied", description: "Paste it anywhere: a post, a message, an email (Ctrl+V)." } : { title: "The card could not be copied", description: "Download it instead.", variant: "destructive" });
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Text copied", description: "Paste it where you share; add the image you downloaded." });
    } catch {
      toast({ title: "The text could not be copied", variant: "destructive" });
    }
  };
  /* Le partage du système (téléphone, certains navigateurs) : l'image ET le texte, d'un geste. */
  const native = async () => {
    const png = await blob();
    const file = png ? new File([png], `oathrion-${item.mascot.id}.png`, { type: "image/png" }) : null;
    try {
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text });
      else await navigator.share({ text });
    } catch {
      /* fermé par la personne */
    }
  };

  return (
    <Dialog open onOpenChange={(value) => (value ? undefined : onClose())}>
      <DialogContent className="max-w-2xl" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share what Oathrion did</DialogTitle>
          <DialogDescription>Nothing private is on it: no path, no file name, no command, no process number. Nothing leaves your computer until you click.</DialogDescription>
        </DialogHeader>
        <canvas ref={canvas} className="w-full rounded-lg border" style={{ aspectRatio: `${String(CARD.width)} / ${String(CARD.height)}` }} data-testid="share-card" />
        {network ? (
          <Button
            size="lg"
            className="h-12 w-full rounded-xl text-[15px] font-semibold"
            disabled={!ready}
            onClick={() => void toNetwork(NETWORK_NAMES[network], shareUrl(network, item.share))}
            data-testid="button-share-main"
          >
            <ImageIcon className="mr-2 h-5 w-5" aria-hidden="true" /> Copy the card & open {NETWORK_NAMES[network]}
          </Button>
        ) : null}
        <p className="whitespace-pre-line rounded-md bg-muted p-3 text-sm text-muted-foreground">{text}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!ready} onClick={() => void download()} data-testid="button-share-download">
            <Download className="mr-1.5 h-4 w-4" aria-hidden="true" /> Download the image
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => void copyCard()} data-testid="button-share-copy-image">
            <ImageIcon className="mr-1.5 h-4 w-4" aria-hidden="true" /> Copy the image
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copy()} data-testid="button-share-copy">
            <Copy className="mr-1.5 h-4 w-4" aria-hidden="true" /> Copy the text
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => void toNetwork("X", shareUrl("x", item.share))} data-testid="button-share-x">
            X
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => void toNetwork("LinkedIn", shareUrl("linkedin", item.share))} data-testid="button-share-linkedin">
            LinkedIn
          </Button>
          <Button size="sm" variant="outline" disabled={!ready} onClick={() => void toNetwork("WhatsApp", shareUrl("whatsapp", item.share))} data-testid="button-share-whatsapp">
            WhatsApp
          </Button>
          {typeof navigator !== "undefined" && typeof navigator.share === "function" ? (
            <Button size="sm" variant="outline" disabled={!ready} onClick={() => void native()} data-testid="button-share-native">
              <Share2 className="mr-1.5 h-4 w-4" aria-hidden="true" /> More…
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          LinkedIn, X and WhatsApp take only text from a link: Oathrion copies the card for you, then opens the post. Paste the card into it with Ctrl+V.
        </p>
      </DialogContent>
    </Dialog>
  );
}
