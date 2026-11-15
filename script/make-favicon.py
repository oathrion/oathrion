"""Generates client/public/favicon.png: the shield the console's brand uses.

index.html has always referenced /favicon.png, but no file existed, so every page
load fetched a 404. Written as code rather than pasted as a binary so the shape
and the brand colour stay reviewable.

Run from the project root: `python3 script/make-favicon.py`. Needs Pillow, which
is deliberately not a project dependency — the icon is committed, so this only
needs to run when the mark itself changes.
"""

from PIL import Image, ImageDraw

# --primary: hsl(245 72% 58%) — the console's brand indigo.
BRAND = (99, 91, 232, 255)
WHITE = (255, 255, 255, 255)

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded square plate in the brand colour.
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=112, fill=BRAND)

# A shield: the control-plane metaphor the product is built on.
cx = SIZE / 2
# The shield fills most of the plate on purpose: at a 16x16 favicon a mark with
# generous padding shrinks to a few grey pixels and reads as nothing at all.
top, bottom = 84, 448
half = 150
shield = [
    (cx - half, top),
    (cx + half, top),
    (cx + half, top + 168),
    (cx, bottom),
    (cx - half, top + 168),
]
d.polygon(shield, fill=WHITE)

# Check mark inside the shield, punched back out in the brand colour.
# Kept clear of the shield outline on every side so the mark still reads as
# enclosed at 16x16, where a stroke touching the edge just looks like noise.
d.line([(cx - 68, top + 152), (cx - 18, top + 206), (cx + 70, top + 86)], fill=BRAND, width=40, joint="curve")

img.save("client/public/favicon.png")
print("written")
