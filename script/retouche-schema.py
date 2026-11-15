"""
Réparer l'image fournie.

Elle porte trois défauts qu'aucun cadrage ne corrige : le nom du produit est mal
orthographié (le A de OATHRION n'a pas de barre, cela se lit « PLΛCET »), le libellé
« AI AGENT » apparaît trois fois, et trois des contrôles nommés autour du noyau sont
des doublons. Un visuel de page d'accueil qui écrit mal le nom du produit est un défaut
factuel, pas une question de goût.

La réparation ne repeint pas une approximation : le mot-marque est recomposé dans
Bricolage Grotesque, la vraie fonte d'affichage du site, donc l'image et la page
finissent par dire le nom de la même façon.
"""

import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

SRC, FONT, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
im = Image.open(SRC).convert("RGB")
W, H = im.size


def inpaint(box, margin=14, blur=3.0):
    """
    Effacer une zone en PROLONGEANT le dégradé qui l'entoure, pas en la remplissant.

    Un aplat de couleur moyenne laisse un rectangle visible dès que le fond varie — et
    ici il varie partout. Pour chaque pixel on interpole entre les quatre bords d'une
    boîte élargie : horizontalement depuis les colonnes voisines, verticalement depuis
    les lignes voisines, puis on mélange les deux. Un flou léger absorbe la couture.
    """
    x0, y0, x1, y1 = box
    ex0, ey0 = max(0, x0 - margin), max(0, y0 - margin)
    ex1, ey1 = min(W - 1, x1 + margin), min(H - 1, y1 + margin)
    px = im.load()

    left = {y: px[ex0, y] for y in range(ey0, ey1 + 1)}
    right = {y: px[ex1, y] for y in range(ey0, ey1 + 1)}
    top = {x: px[x, ey0] for x in range(ex0, ex1 + 1)}
    bottom = {x: px[x, ey1] for x in range(ex0, ex1 + 1)}

    patch = Image.new("RGB", (ex1 - ex0 + 1, ey1 - ey0 + 1))
    pp = patch.load()
    for y in range(ey0, ey1 + 1):
        fy = (y - ey0) / max(1, ey1 - ey0)
        for x in range(ex0, ex1 + 1):
            fx = (x - ex0) / max(1, ex1 - ex0)
            h = [left[y][i] * (1 - fx) + right[y][i] * fx for i in range(3)]
            v = [top[x][i] * (1 - fy) + bottom[x][i] * fy for i in range(3)]
            pp[x - ex0, y - ey0] = tuple(round((h[i] + v[i]) / 2) for i in range(3))
    patch = patch.filter(ImageFilter.GaussianBlur(blur))

    # Un masque adouci : plein au centre, nul sur le bord, pour que la greffe n'ait
    # pas d'arête. C'est la marge qui sert de zone de fondu.
    #
    # Le masque doit être PLEIN sur toute la zone à effacer, et ne s'adoucir que dans la
    # marge. Un simple flou centre le dégradé sur le bord du rectangle : les dernières
    # dizaines de pixels de texte ne sont alors remplacées qu'à moitié, et il reste un
    # fantôme — dix niveaux sur deux cent cinquante-cinq, invisible dans les valeurs,
    # parfaitement visible à l'oeil sur un fond sombre et plat. On pousse donc le
    # plateau au-delà du rectangle, et la pente va vivre dans la marge, sur du fond.
    #
    mask = Image.new("L", patch.size, 0)
    ImageDraw.Draw(mask).rectangle(
        [x0 - ex0, y0 - ey0, x1 - ex0, y1 - ey0], fill=255
    )
    mask = mask.filter(ImageFilter.GaussianBlur(margin / 2.2))
    mask = mask.point(lambda v: min(255, int(v * 2.6)))
    im.paste(patch, (ex0, ey0), mask)


def fitted(text, font_path, cap_height, width):
    """La taille qui donne EXACTEMENT cette hauteur de capitale, et l'interlettrage
    qui fait tenir le mot dans cette largeur. Mesuré, pas estimé."""
    size = cap_height
    for _ in range(40):
        f = ImageFont.truetype(font_path, size)
        got = f.getbbox("H")[3] - f.getbbox("H")[1]
        if got == 0:
            break
        size = max(1, round(size * cap_height / got))
        f = ImageFont.truetype(font_path, size)
        if abs((f.getbbox("H")[3] - f.getbbox("H")[1]) - cap_height) <= 1:
            break
    widths = [f.getbbox(c)[2] - f.getbbox(c)[0] for c in text]
    advances = [f.getlength(c) for c in text]
    track = (width - sum(advances)) / max(1, len(text) - 1)
    return f, track, widths, advances


# ------------------------------------------------------------- 1. le mot-marque
MARK = (552, 90, 822, 139)
inpaint((MARK[0] - 10, MARK[1] - 14, MARK[2] + 12, MARK[3] + 14), margin=26, blur=4.5)

font, track, _, advances = fitted("OATHRION", FONT, MARK[3] - MARK[1] + 1, MARK[2] - MARK[0] + 1)
layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
ld = ImageDraw.Draw(layer)
x = MARK[0]
top_of_caps = font.getbbox("H")[1]
for i, ch in enumerate(" OATHRION".strip()):
    ld.text((x, MARK[1] - top_of_caps), ch, font=font, fill=(199, 208, 222, 255))
    x += advances[i] + track
#
# La lueur est mesurée, pas décorative : le texte d'origine en porte une très faible.
# Un halo plus fort que celui du texte voisin signale au premier coup d'oeil que ce
# mot-là a été rapporté — exactement ce qu'une retouche doit éviter.
#
glow = layer.filter(ImageFilter.GaussianBlur(9))
glow.putalpha(glow.split()[3].point(lambda v: int(v * 0.34)))
#
# Composer SUR l'image, pas sur rien.
#
# `merged.convert("RGB")` aplatit un calque semi-transparent contre du noir : chaque
# pixel de lueur à 30 % devenait un pixel sombre, et les lettres se retrouvaient
# cernées d'un halo noir — le contraire de l'effet voulu. Il faut passer l'image elle-
# même en RGBA et l'empiler dessous.
#
base = im.convert("RGBA")
base = Image.alpha_composite(base, glow)
base = Image.alpha_composite(base, layer)
im = base.convert("RGB")

# ------------------------------------------------- 2. les libellés en double
inpaint((44, 270, 136, 304), margin=16, blur=2.5)     # « AI AGENT » minuscule
inpaint((120, 540, 242, 590), margin=20, blur=3.5)    # « AI AGENT » répété en bas

im.save(OUT, quality=94)
print("écrit :", OUT, im.size)

# ------------------------------------------------- 3. les contrôles en double
#
# Trois des sept pastilles autour du noyau répétaient POLICY, MANDATE et RISK. Sur une
# page qui affirme « huit contrôles, dans cet ordre », montrer quatre contrôles dont
# trois en double est une imprécision que le produit ne se permet nulle part ailleurs.
#
# Elles ne sont pas supprimées mais RENOMMÉES, avec les quatre noms qui manquaient. Le
# visuel nomme alors sept des huit contrôles — le huitième, DECISION, est déjà écrit à
# droite comme résultat. L'image dit enfin la même chose que la page.
#
# Le style n'est pas inventé : remplissage, bord, taille de capitale et couleurs ont été
# relevés au pixel sur les pastilles d'origine, et le texte est composé en Geist, la
# fonte de texte du site.

PILL_H = 27
PILL_R = 8
GREEN = {"fill": ((24, 32, 52), (17, 24, 41)), "edge": (44, 54, 76),
         "ink": (226, 238, 252), "sign": (112, 198, 156)}
AMBER = {"fill": ((48, 31, 35), (36, 24, 28)), "edge": (76, 49, 51),
         "ink": (228, 198, 192), "sign": (208, 120, 98)}


def pill(anchor, side, label, style, font_path, cap=11):
    """Une pastille, ancrée par le bord qui ne doit pas bouger.

    Les pastilles de gauche grandissent vers la gauche et celles de droite vers la
    droite : ancrer par le centre les ferait grandir VERS l'anneau, et un nom plus long
    que l'ancien viendrait mordre dessus."""
    ax, cy = anchor
    f = ImageFont.truetype(font_path, cap)
    for _ in range(30):
        got = f.getbbox("H")[3] - f.getbbox("H")[1]
        if got >= cap:
            break
        f = ImageFont.truetype(font_path, f.size + 1)
    tw = round(f.getlength(label))
    w = tw + 12 + 14 + 10 + 11          # marge, texte, espace, signe, marge
    x0 = ax - w if side == "right" else ax
    y0, y1 = cy - PILL_H // 2, cy + PILL_H // 2

    card = Image.new("RGBA", (w, PILL_H + 1), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    top, bot = style["fill"]
    for y in range(PILL_H + 1):
        t = y / PILL_H
        cd.line([(0, y), (w, y)],
                fill=tuple(round(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
    corners = Image.new("L", card.size, 0)
    ImageDraw.Draw(corners).rounded_rectangle([0, 0, w - 1, PILL_H], PILL_R, fill=255)
    card.putalpha(corners)
    cd.rounded_rectangle([0, 0, w - 1, PILL_H], PILL_R, outline=style["edge"] + (255,), width=1)

    bx = f.getbbox("H")
    cd.text((11, (PILL_H - cap) // 2 - bx[1]), label, font=f, fill=style["ink"] + (255,))

    sx, sy = 11 + tw + 10, PILL_H // 2
    if style is GREEN:   # la coche
        cd.line([(sx, sy + 1), (sx + 4, sy + 5), (sx + 12, sy - 5)],
                fill=style["sign"] + (255,), width=2, joint="curve")
    else:                # le triangle d'alerte
        cd.polygon([(sx + 6, sy - 6), (sx + 13, sy + 5), (sx - 1, sy + 5)],
                   outline=style["sign"] + (255,))
        cd.line([(sx + 6, sy - 2), (sx + 6, sy + 1)], fill=style["sign"] + (255,))
        cd.point((sx + 6, sy + 3), fill=style["sign"] + (255,))

    halo = card.filter(ImageFilter.GaussianBlur(6))
    halo.putalpha(halo.split()[3].point(lambda v: int(v * 0.22)))
    base = im.convert("RGBA")
    base.alpha_composite(halo, (x0, y0))
    base.alpha_composite(card, (x0, y0))
    return base.convert("RGB")


#
# Les boîtes couvrent la LUEUR, pas seulement la pastille. Chaque pastille d'origine
# porte un halo diffus qui déborde d'une vingtaine de pixels ; une boîte serrée sur le
# contour laisse ce halo en place, et il reste une tache lumineuse sans rien dedans.
#
for box in [(466, 500, 588, 564), (786, 500, 892, 564), (612, 556, 758, 616)]:
    inpaint(box, margin=20, blur=3.2)

GEIST = FONT.replace("bricolage-400", "geist-500")
im = pill((570, 531), "right", "EXECUTION", GREEN, GEIST)
im = pill((803, 531), "left", "APPROVAL", AMBER, GEIST)
im = pill((641, 584), "left", "AUDIT", GREEN, GEIST)

im.save(OUT, quality=94)
print("pastilles renommees")
