/**
 * NOTRE FENÊTRE DE NOTIFICATION (10 novembre : « il faut que l'on atteigne le saint graal avec
 * la notification » ; 11 novembre : « elle doit être notre arme de viralité »). Le dessin :
 * `notes/DESIGN-NOTIFICATIONS.md` et `notes/design/` (la maquette, puis chaque état capturé).
 *
 * La notification du système ne sait ni mettre une mascotte à gauche, ni garder la décision, le
 * feedback et le partage dans la même bulle ; et le bureau garde les anciennes. Celle-ci est une
 * petite fenêtre à nous (GTK 3, par Python : livrés avec Ubuntu et la plupart des bureaux Linux),
 * en haut à droite de l'écran, à la couleur de la mascotte de l'agent :
 *
 *   · « alert » : la mascotte, le titre, le texte, trois boutons au plus ;
 *   · après le clic, LA MÊME fenêtre dit ce qui a été fait, demande 👍 / 👎, montre la carte à
 *     partager et « Share it » : LinkedIn, X, WhatsApp, Copy image ;
 *   · « danger » (un leurre lu) : en rouge, « See what happened » et « Share it » d'emblée.
 *
 * Partager : la carte (1200 × 630, dessinée hors écran) est copiée dans le presse-papiers, puis
 * le pivot ouvre le réseau avec le texte ; la personne colle la carte (Ctrl+V). Fermée après une
 * copie, la fenêtre reste en vie, cachée, tant que la carte est dans le presse-papiers.
 *
 * Elle parle au pivot par sa sortie (une ligne JSON par geste : choice, feedback, share, open,
 * closed) et l'écoute sur son entrée (`{"done": "…", "share": "…"}`). Elle meurt avec le pivot.
 *
 * `snapshot` : chaque état dessiné hors écran dans une image, pour la vérifier sans l'afficher.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { MARK_PATH, MARK_VIEWBOX } from "@shared/brand-mark";

export const POPUP_SCRIPT_NAME = "oathrion-notify-window.py";

export interface PopupSpec {
  /** « alert » : une décision à prendre ; « danger » : un leurre lu, en rouge. */
  kind: "alert" | "danger";
  title: string;
  body: string;
  /** La mascotte de l'agent : une image locale, son identifiant (sa couleur) et son nom. */
  mascot?: string;
  mascotId?: string;
  mascotName?: string;
  agent: string;
  /** Trois boutons au plus ; le premier est le principal. `id: "open"` ouvre la console sans décider. */
  actions: { id: string; label: string }[];
  /** La phrase à partager (rien de privé), dès l'ouverture : l'alerte « danger » ; sinon elle vient avec `done`. */
  share?: string;
  /** Le rang de la fenêtre parmi celles ouvertes (empilées sous la première). */
  slot?: number;
  /** Pour la vérifier : chaque état dessiné hors écran, dans `dir` (alert.png, decided.png, danger.png, card.png). */
  snapshot?: { dir: string; done?: string; share?: string };
}

/** Écrit la fenêtre dans le dossier du pivot ; rend son chemin. */
export function writePopupScript(dir: string): string {
  const path = join(dir, POPUP_SCRIPT_NAME);
  writeFileSync(path, POPUP_PY, { mode: 0o600 });
  return path;
}

export const POPUP_PY = String.raw`#!/usr/bin/env python3
# Oathrion: its own notification window (server/notifications/popup.ts). One JSON line per gesture
# on stdout; {"done": "...", "share": "..."} on stdin after a decision; {"settled": "..."} when
# it was decided elsewhere (the phone, the console).
# The design: notes/DESIGN-NOTIFICATIONS.md (version 1.0, 11 November 2026).
import json, os, sys, datetime
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gtk, Gdk, GdkPixbuf, GLib

spec = json.loads(sys.argv[1])

# The accent of each mascot: main, highlight, deep, glow.
THEMES = {
    "ember": ("#FF812E", "#FFB45C", "#D94D22", "rgba(255,129,46,.32)"),
    "pixel": ("#398BFF", "#65D8FF", "#2546D8", "rgba(57,139,255,.32)"),
    "nova": ("#963EFF", "#DF64FF", "#5935D9", "rgba(150,62,255,.34)"),
    "bolt": ("#43D66B", "#B8F45A", "#168B56", "rgba(67,214,107,.30)"),
    "echo": ("#19CFCB", "#76F5F0", "#087E97", "rgba(25,207,203,.32)"),
    "orbit": ("#FFC343", "#FFE98C", "#DE8B20", "rgba(255,195,67,.32)"),
    "shade": ("#A7B0C5", "#E0E4F0", "#697389", "rgba(167,176,197,.25)"),
    "warden": ("#505CFF", "#7AABFF", "#272D9C", "rgba(80,92,255,.34)"),
}
DANGER = ("#FF334F", "#FF6679", "#B91E3B", "rgba(255,52,79,.30)")
danger = spec.get("kind") == "danger"
MAIN, HIGH, DEEP, GLOW = DANGER if danger else THEMES.get(spec.get("mascotId") or "", THEMES["warden"])
CARD_BG = "linear-gradient(135deg, #250D1A 0%, #18101F 55%, #0C0D1D 100%)" if danger else "linear-gradient(135deg, #1C1235 0%, #11152D 54%, #090F20 100%)"
BORDER = "#FF526B" if danger else MAIN
FONT = "Inter, 'Noto Sans', Cantarell, sans-serif"
HEADLINE_FONT = "'Space Grotesk', Inter, 'Noto Sans', sans-serif"

CSS = """
window { background: transparent; padding: 0; margin: 0; border: none; box-shadow: none; min-height: 0; min-width: 0; }
.oath-card { background-image: %(card)s; border: 1px solid %(border)s; border-radius: 20px;
  box-shadow: 0 12px 35px rgba(0,0,0,.42), 0 0 28px %(glow)s, inset 0 1px 0 rgba(255,255,255,.045); }
.oath-card label { font-family: %(font)s; }
.oath-brand { color: #F7F5FF; font-size: 14px; font-weight: 600; }
.oath-title { color: %(title)s; font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.oath-body { color: %(body)s; font-size: 14px; }
.oath-ask { color: #AAA9C5; font-size: 15px; font-weight: 500; }
.oath-hint { color: #AAA9C5; font-size: 12px; }
button { background-image: none; box-shadow: none; text-shadow: none; -gtk-icon-shadow: none; outline: none; }
button.oath-btn { background-color: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.12); border-radius: 18px;
  min-height: 34px; padding: 0 10px; }
button.oath-btn label { color: #F5F3FF; font-size: 12px; font-weight: 600; }
button.oath-btn:hover { background-color: rgba(255,255,255,.11); }
button.oath-primary { background-image: linear-gradient(110deg, %(main)s 0%%, %(deep)s 100%%); border: 1px solid rgba(255,255,255,.18);
  box-shadow: 0 4px 16px %(glow)s; }
button.oath-primary label { color: #FFFFFF; }
button.oath-primary:hover { background-image: linear-gradient(110deg, %(high)s 0%%, %(main)s 100%%); }
button.oath-round { background-color: #201A3A; border: 1px solid #49366F; border-radius: 19px; min-width: 36px; min-height: 36px; padding: 0; }
button.oath-round:hover { background-color: #2C2450; }
button.oath-round-on { background-image: linear-gradient(110deg, %(main)s, %(deep)s); border-color: %(high)s; }
button.oath-close { background: transparent; border: none; padding: 0; min-width: 24px; min-height: 24px; }
button.oath-close:hover { background-color: rgba(255,255,255,.08); border-radius: 12px; }
.oath-share { background-color: rgba(255,255,255,.035); border: 1px solid rgba(255,255,255,.07); border-radius: 14px; }
.oath-share-title { color: #F7F5FF; font-size: 15px; font-weight: 600; }
.oath-divider { background-color: #292747; min-width: 1px; }
.oath-preview { border: 1px solid %(main)s; border-radius: 8px; padding: 2px; background-color: #0B0A1C; }
""" % {"card": CARD_BG, "border": BORDER, "glow": GLOW, "font": FONT, "main": MAIN, "high": HIGH, "deep": DEEP,
       "title": "#FFF4F5" if danger else "#F8F5FF", "body": "#C5AAB5" if danger else "#AAA9C5"}

# Our icons (paths: Material icons, Apache 2.0; the ring is ours, shared/brand-mark.ts).
ICONS = {
    "close": "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    "up": "M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z",
    "down": "M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z",
    "share": "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z",
    "copy": "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    "check": "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm4.59-12.42L10 14.17l-2.59-2.58L6 13l4 4 8-8z",
    "calendar": "M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zm0-12H5V6h14v2z",
}

def svg_pixbuf(svg, width, height):
    try:
        loader = GdkPixbuf.PixbufLoader.new_with_type("svg")
        loader.set_size(width, height)
        loader.write(svg.encode())
        loader.close()
        return loader.get_pixbuf()
    except Exception:
        return None

def icon(name, color, size):
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="%d" height="%d"><path fill="%s" d="%s"/></svg>' % (size, size, color, ICONS[name])
    pixbuf = svg_pixbuf(svg, size, size)
    return Gtk.Image.new_from_pixbuf(pixbuf) if pixbuf else Gtk.Label(label="")

def shield(width, height):
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK_VIEWBOX}" width="%d" height="%d">'
           '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs>'
           '<path fill="url(#g)" fill-rule="evenodd" d="${MARK_PATH}"/></svg>') % (width, height, HIGH if not danger else "#6E8BFF", "#5B3BFF" if not danger else "#4636D8")
    pixbuf = svg_pixbuf(svg, width, height)
    return Gtk.Image.new_from_pixbuf(pixbuf) if pixbuf else Gtk.Label(label="")

def mascot_image(size):
    try:
        return Gtk.Image.new_from_pixbuf(GdkPixbuf.Pixbuf.new_from_file_at_size(spec.get("mascot") or "", size, size))
    except Exception:
        return Gtk.Label(label="")

def label(text, css, width=None, markup=False):
    widget = Gtk.Label(xalign=0)
    if markup:
        widget.set_markup(text)
    else:
        widget.set_text(text)
    widget.get_style_context().add_class(css)
    if width:
        widget.set_line_wrap(True)
        widget.set_max_width_chars(1)
        widget.set_size_request(width, -1)
    return widget

def button(text, css, on_click, image=None):
    widget = Gtk.Button()
    inside = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=7)
    if image:
        inside.pack_start(image, False, False, 0)
    if text:
        inside.pack_start(Gtk.Label(label=text), False, False, 0)
    inside.set_halign(Gtk.Align.CENTER)
    widget.add(inside)
    for name in css.split():
        widget.get_style_context().add_class(name)
    if on_click:
        widget.connect("clicked", on_click)
    return widget

def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()

def headline_markup(sentence):
    # The last clause in the accent color: "…, and I stopped it in one click."
    text = GLib.markup_escape_text(sentence)
    for cut in (", and ", "; ", ": "):
        at = text.rfind(cut)
        if at > 0:
            keep = at + (2 if cut == ", and " else len(cut))
            return '%s<span foreground="%s">%s</span>' % (text[:keep], HIGH, text[keep:])
    return text

def today():
    now = datetime.date.today()
    months = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")
    return "%d %s %d" % (now.day, months[now.month - 1], now.year)

def render(widget, width, height):
    window = Gtk.OffscreenWindow()
    window.set_size_request(width, height)
    window.add(widget)
    window.show_all()
    for _ in range(30):
        while Gtk.events_pending():
            Gtk.main_iteration()
    pixbuf = window.get_pixbuf()
    window.destroy()
    if pixbuf.get_width() > width or pixbuf.get_height() > height:
        pixbuf = pixbuf.new_subpixbuf(0, 0, min(width, pixbuf.get_width()), min(height, pixbuf.get_height())).copy()
    return pixbuf

CARD_CSS = """
.oath-sharecard { background-image: radial-gradient(ellipse at 17%% 55%%, %(glow)s 0%%, transparent 42%%),
  radial-gradient(ellipse at 88%% 18%%, rgba(49,65,164,.17) 0%%, transparent 45%%),
  linear-gradient(130deg, #080718 0%%, #090D20 55%%, #050713 100%%); }
.oath-sharecard label { font-family: %(font)s; }
.oath-headline { color: #F8F6FF; font-size: 44px; font-weight: 700; letter-spacing: -1.2px; font-family: %(headline)s; }
.oath-date { color: #B6B4D1; font-size: 17px; }
.oath-foot { color: #B7B5D0; font-size: 14px; font-weight: 500; }
.oath-rule { background-color: #2D2850; min-height: 1px; }
.oath-halo { background-image: radial-gradient(circle closest-side, %(halo)s 0%%, transparent 100%%); }
""" % {"glow": GLOW.replace(".3", ".4") if not danger else "rgba(255,52,79,.30)", "font": FONT, "headline": HEADLINE_FONT,
       "halo": GLOW.replace(".34", ".55").replace(".32", ".5").replace(".30", ".5").replace(".25", ".45")}

def share_card(sentence):
    # The image people post: 1200 x 630, the mascot big on the left, the sentence, the date, Oathrion.
    # A Gtk.Fixed draws no background: the card's own box does.
    back = Gtk.Box()
    back.get_style_context().add_class("oath-sharecard")
    card = Gtk.Fixed()
    card.set_size_request(1200, 630)
    back.add(card)
    halo = Gtk.Box()
    halo.get_style_context().add_class("oath-halo")
    halo.set_size_request(520, 520)
    card.put(halo, -20, 55)
    card.put(mascot_image(440), 20, 95)
    words = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=26)
    words.set_size_request(670, 470)
    head = Gtk.Label(xalign=0)
    head.set_markup('<span line_height="1.25">%s</span>' % headline_markup(sentence))
    head.set_line_wrap(True)
    head.set_max_width_chars(1)
    head.set_size_request(670, -1)
    head.get_style_context().add_class("oath-headline")
    date = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    date.pack_start(icon("calendar", "#B6B4D1", 19), False, False, 0)
    date.pack_start(label(today(), "oath-date"), False, False, 0)
    words.set_valign(Gtk.Align.CENTER)
    middle = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=26)
    middle.pack_start(head, False, False, 0)
    middle.pack_start(date, False, False, 0)
    words.pack_start(middle, True, False, 0)
    middle.set_valign(Gtk.Align.CENTER)
    card.put(words, 480, 50)
    rule = Gtk.Box()
    rule.get_style_context().add_class("oath-rule")
    rule.set_size_request(675, 1)
    card.put(rule, 480, 548)
    foot = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
    foot.pack_start(shield(20, 20), False, False, 0)
    foot.pack_start(label('Protected by Oathrion · the guard for AI agents · <span foreground="%s" weight="bold">npx oathrion</span>' % HIGH, "oath-foot", markup=True), False, False, 0)
    card.put(foot, 482, 566)
    return render(back, 1200, 630)

class Card:
    def __init__(self, window):
        self.window = window
        self.decided = None
        self.feedback = None
        self.sentence = spec.get("share") if danger else None
        self.card = None
        self.shared = False
        for css in (CSS, CARD_CSS):
            provider = Gtk.CssProvider()
            provider.load_from_data(css.encode())
            Gtk.StyleContext.add_provider_for_screen(Gdk.Screen.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        # The card: the top, then "Share it" under it when there is one. The top is the text column
        # (its height follows the text); the brand, the close button and the mascot float over it,
        # placed as in the design.
        self.frame = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.frame.get_style_context().add_class("oath-card")
        # GTK 3 may give the window more height than the card needs: the card keeps its own height,
        # the rest stays transparent.
        self.frame.set_valign(Gtk.Align.START)
        # Room around the card for its glow and shadow.
        for side in ("start", "end", "top", "bottom"):
            getattr(self.frame, "set_margin_" + side)(20)
        top = Gtk.Overlay()
        base = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL)
        base.set_size_request(420, 220)
        top.add(base)
        self.frame.pack_start(top, False, False, 0)
        window.add(self.frame)

        def place(widget, x, y):
            widget.set_halign(Gtk.Align.START)
            widget.set_valign(Gtk.Align.START)
            widget.set_margin_start(x)
            widget.set_margin_top(y)
            top.add_overlay(widget)
        place(mascot_image(162), 2, 58)
        place(shield(24, 24), 16, 15)
        place(label("Oathrion", "oath-brand"), 47, 17)
        place(button(None, "oath-close", self.close, icon("close", "#9698BC", 18)), 379, 13)
        self.title = label(spec.get("title", ""), "oath-title", 232)
        self.body = label(spec.get("body", ""), "oath-body", 232)
        # The text and the buttons in one column: a longer title pushes the buttons, never covers them.
        self.text = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        self.text.pack_start(self.title, False, False, 0)
        self.text.pack_start(self.body, False, False, 0)
        # Spacers rather than margins: GTK 3 measures a wrapped label badly through margins.
        column = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=20)
        column.set_size_request(232, -1)
        above = Gtk.Box()
        above.set_size_request(1, 32)
        column.pack_start(above, False, False, 0)
        column.pack_start(self.text, False, False, 0)
        left = Gtk.Box()
        left.set_size_request(169, 1)
        base.pack_start(left, False, False, 0)
        base.pack_start(column, False, False, 0)
        self.buttons = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        for index, action in enumerate(spec.get("actions", [])[:3]):
            self.buttons.pack_start(button(action["label"], "oath-btn oath-primary" if index == 0 else "oath-btn", self.choose, None), False, False, 0)
            self.buttons.get_children()[-1].action = action
        column.pack_start(self.buttons, False, False, 0)
        if self.sentence:
            self.share_panel()

    def share_panel(self):
        # "Share it": the card copied, then the network opened, from the notification itself.
        panel = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        panel.get_style_context().add_class("oath-share")
        panel.set_border_width(12)
        panel.set_margin_start(12)
        panel.set_margin_end(12)
        panel.set_margin_bottom(14)
        head = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        head.pack_start(icon("share", "#F7F5FF", 18), False, False, 0)
        head.pack_start(label("Share it", "oath-share-title"), False, False, 0)
        panel.pack_start(head, False, False, 0)
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        for network, name in (("linkedin", "LinkedIn"), ("x", "X"), ("whatsapp", "WhatsApp")):
            row.pack_start(button(name, "oath-btn", lambda _b, n=network: self.share(n), None), True, True, 0)
        row.pack_start(button("Copy image", "oath-btn oath-primary", lambda _b: self.share("copy"), icon("copy", "#FFFFFF", 15)), True, True, 0)
        panel.pack_start(row, False, False, 0)
        hint = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        hint.set_halign(Gtk.Align.CENTER)
        hint.pack_start(icon("check", "#AAA9C5", 14), False, False, 0)
        # Wrapped: the hint grows to two lines after a share, never wider than the card.
        self.hint = label("One click: the card is copied, paste it in your post", "oath-hint", 330)
        self.hint.set_justify(Gtk.Justification.CENTER)
        self.hint.set_xalign(0.5)
        hint.pack_start(self.hint, False, False, 0)
        panel.pack_start(hint, False, False, 0)
        self.frame.pack_start(panel, False, False, 0)

    def picture(self):
        if self.card is None and self.sentence:
            self.card = share_card(self.sentence)
        return self.card

    def share(self, network):
        picture = self.picture()
        copied = False
        if picture is not None:
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.set_image(picture)
            clipboard.store()
            copied = True
            self.shared = True
        # Also saved as an image (essai réel du 11 novembre : un site peut refuser le collage) : la
        # personne la joint avec le bouton image du réseau. Dans Images/Oathrion.
        saved = self.save_card(picture) if picture is not None else None
        names = {"linkedin": "LinkedIn", "x": "X", "whatsapp": "WhatsApp"}
        where = (" Also in Images/Oathrion." if saved else "")
        if network == "copy":
            self.hint.set_text(("The card is copied: paste it anywhere with Ctrl+V." if copied else "The card could not be copied.") + where)
        else:
            # The browser copies the card itself, on the page that opens (X11 to Wayland lost it).
            self.hint.set_text("Your card opens in your browser: one click copies it and opens %s." % names[network] + where)
            emit({"share": network})

    def save_card(self, picture):
        if getattr(self, "saved", None):
            return self.saved
        try:
            pictures = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) or os.path.join(os.path.expanduser("~"), "Pictures")
            folder = os.path.join(pictures, "Oathrion")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, "oathrion-%s-%s.png" % (spec.get("mascotId") or "card", datetime.datetime.now().strftime("%Y-%m-%d-%H%M%S")))
            picture.savev(path, "png", [], [])
            self.saved = path
            # First under "Recent" in the file picker of the network's image button.
            try:
                Gtk.RecentManager.get_default().add_item(GLib.filename_to_uri(path, None))
            except Exception:
                pass
            return path
        except Exception:
            return None

    def choose(self, clicked):
        action = clicked.action
        if action["id"] == "open":
            emit({"open": True})
            return
        if self.decided:
            return
        self.decided = action["id"]
        for child in self.buttons.get_children():
            child.set_sensitive(False)
        self.body.set_text(action["label"] + "…")
        emit({"choice": action["id"]})

    def done(self, text, sentence=None):
        for child in self.buttons.get_children():
            self.buttons.remove(child)
        self.title.set_text(text or "Done")
        self.body.get_style_context().remove_class("oath-body")
        self.body.get_style_context().add_class("oath-ask")
        self.body.set_text("Was this right?")
        thumbs = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=11)
        thumbs.set_valign(Gtk.Align.CENTER)
        for verdict, name in (("right", "up"), ("wrong", "down")):
            thumb = button(None, "oath-round", None, icon(name, "#FFFFFF", 17))
            thumb.connect("clicked", self.judge, verdict)
            thumbs.pack_start(thumb, False, False, 0)
        self.buttons.pack_start(thumbs, False, False, 0)
        self.sentence = sentence
        if sentence:
            divider = Gtk.Box()
            divider.get_style_context().add_class("oath-divider")
            divider.set_size_request(1, 38)
            self.buttons.pack_start(divider, False, False, 6)
            picture = self.picture()
            if picture is not None:
                preview = Gtk.Box()
                preview.get_style_context().add_class("oath-preview")
                preview.add(Gtk.Image.new_from_pixbuf(picture.scale_simple(112, 59, GdkPixbuf.InterpType.BILINEAR)))
                self.buttons.pack_start(preview, False, False, 0)
            self.share_panel()
        self.buttons.show_all()
        self.window.show_all()
        self.window.resize(1, 1)
        GLib.timeout_add_seconds(120, self.expire)

    def settled(self, text):
        # Decided elsewhere (the phone, the console): the buttons go, nothing more is asked here.
        if self.decided:
            return
        self.decided = "elsewhere"
        for child in self.buttons.get_children():
            self.buttons.remove(child)
        self.title.set_text(text or "Decided")
        self.body.set_text("Nothing more to do here.")
        self.window.show_all()
        self.window.resize(1, 1)
        GLib.timeout_add_seconds(6, self.quit)

    def judge(self, clicked, verdict):
        if self.feedback:
            return
        self.feedback = verdict
        clicked.get_style_context().add_class("oath-round-on")
        self.body.set_text("Thank you: noted on this machine.")
        emit({"feedback": verdict})

    def expire(self):
        if not self.shared:
            self.quit()
        return False

    def close(self, *_args):
        emit({"closed": True})
        if self.shared:
            # The card stays in the clipboard as long as this window lives: hidden, until it is
            # replaced by another copy, or ten minutes.
            self.window.hide()
            Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).connect("owner-change", lambda *_a: GLib.timeout_add(500, self.quit))
            GLib.timeout_add_seconds(600, self.quit)
            return
        self.quit()

    def quit(self, *_args):
        Gtk.main_quit()
        return False

def read_hub(source, _condition):
    line = source.readline()
    if not line:
        return False
    try:
        message = json.loads(line)
        if "done" in message:
            card.done(message["done"], message.get("share"))
        elif "settled" in message:
            card.settled(message["settled"])
    except Exception:
        pass
    return True

def save(window, path):
    for _ in range(30):
        while Gtk.events_pending():
            Gtk.main_iteration()
    window.get_pixbuf().savev(path, "png", [], [])

shot = spec.get("snapshot")
if shot:
    # Checked without showing anything: each state drawn offscreen, in its own image.
    window = Gtk.OffscreenWindow()
    card = Card(window)
    window.show_all()
    save(window, shot["dir"] + "/" + ("danger" if danger else "alert") + ".png")
    if danger:
        card.picture().savev(shot["dir"] + "/card.png", "png", [], [])
    else:
        window.destroy()
        window = Gtk.OffscreenWindow()
        card = Card(window)
        first = (spec.get("actions") or [{"id": "x", "label": "x"}])[0]
        card.decided = first["id"]
        window.show_all()
        card.done(shot["done"], shot.get("share"))
        save(window, shot["dir"] + "/decided.png")
        if card.picture() is not None:
            card.picture().savev(shot["dir"] + "/card.png", "png", [], [])
    sys.exit(0)

window = Gtk.Window(type=Gtk.WindowType.POPUP)
screen = window.get_screen()
if screen.get_rgba_visual() is not None and screen.is_composited():
    window.set_visual(screen.get_rgba_visual())
window.set_app_paintable(True)
window.set_keep_above(True)
card = Card(window)
window.set_opacity(0)
window.show_all()
display = Gdk.Display.get_default()
monitor = display.get_primary_monitor() or display.get_monitor(0)
area = monitor.get_workarea()
width, height = window.get_size()
slot = int(spec.get("slot") or 0)
window.move(area.x + area.width - width - 4, area.y + 4 + slot * (height - 24))

def fade(step=[0]):
    step[0] += 1
    window.set_opacity(min(1.0, step[0] / 8.0))
    return step[0] < 8
GLib.timeout_add(30, fade)
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, read_hub)
Gtk.main()
`;
