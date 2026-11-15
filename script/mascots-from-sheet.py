#!/usr/bin/env python3
"""
Découpe une planche de mascottes (une grille, une mascotte par case) en images PNG à fond
transparent, 256 × 256, pour `client/public/mascots/` (11 novembre 2026 : la planche générée
pour l'utilisateur ; les packs suivants passeront par ici aussi).

    python3 -I script/mascots-from-sheet.py <planche> <dossier> <colonnes> <lignes> <id> <id> …

Le fond est retiré en partant des BORDS de chaque case (remplissage des pixels presque blancs
et peu colorés) : les reflets blancs dans les yeux, entourés de couleur, restent intacts. Les
pixels de contour gardent une transparence partielle, pour ne pas laisser de liseré blanc.
"""
import sys
from collections import deque

from PIL import Image

sheet_path, out_dir, cols, rows, *ids = sys.argv[1:]
cols, rows = int(cols), int(rows)
sheet = Image.open(sheet_path).convert("RGBA")
width, height = sheet.size
if len(ids) != cols * rows:
    sys.exit(f"{cols * rows} ids expected, {len(ids)} given")


def background_like(pixel):
    r, g, b, a = pixel
    return a < 16 or (min(r, g, b) >= 222 and max(r, g, b) - min(r, g, b) <= 28)


for index, mascot_id in enumerate(ids):
    col, row = index % cols, index // cols
    box = (round(col * width / cols), round(row * height / rows), round((col + 1) * width / cols), round((row + 1) * height / rows))
    cell = sheet.crop(box)
    w, h = cell.size
    px = cell.load()
    removed = [[False] * w for _ in range(h)]
    queue = deque((x, y) for x in range(w) for y in (0, h - 1))
    queue.extend((x, y) for y in range(h) for x in (0, w - 1))
    while queue:
        x, y = queue.popleft()
        if removed[y][x] or not background_like(px[x, y]):
            continue
        removed[y][x] = True
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not removed[ny][nx]:
                queue.append((nx, ny))
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if removed[y][x]:
                px[x, y] = (r, g, b, 0)
                continue
            near = any(0 <= x + dx < w and 0 <= y + dy < h and removed[y + dy][x + dx] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)))
            if near:
                whiteness = max(0.0, (min(r, g, b) - 170) / 85)
                px[x, y] = (r, g, b, round(a * (1 - 0.8 * whiteness)))
    bbox = cell.getbbox()
    if not bbox:
        sys.exit(f"{mascot_id}: nothing left after removing the background")
    figure = cell.crop(bbox)
    side = round(max(figure.size) * 1.08)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(figure, ((side - figure.size[0]) // 2, (side - figure.size[1]) // 2), figure)
    canvas.resize((256, 256), Image.LANCZOS).save(f"{out_dir}/{mascot_id}.png", optimize=True)
    print(f"{mascot_id}: {figure.size[0]}×{figure.size[1]} → 256×256")
