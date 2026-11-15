#!/usr/bin/env python3
"""
Regarder `dist/site/` exactement comme le fera l'hebergeur.

    python3 script/preview-site.py [port]

## Pourquoi ce script existe

L'aperçu n'a aucune raison de dependre de Node. Le dossier publie est du HTML, du
JavaScript et des images : n'importe quel serveur de fichiers suffit. Passer par
`npx serve` ajoutait une dependance a telecharger, un registre a joindre, et surtout la
bonne version de Node -- qui est precisement ce qui manque quand on publie un soir depuis
le shell qu'on avait sous la main.

## Ce qu'il reproduit, et pourquoi c'est le seul test qui compte

La regle de `_redirects` : un fichier s'il existe, sinon `index.html` en **200**.

Le site route par CHEMIN. Sans cette regle, `/pilot` tape directement dans la barre
d'adresse renvoie 404 : le navigateur demande un fichier qui n'existe pas. Le piege est
qu'on ne le voit JAMAIS en naviguant soi-meme -- depuis l'accueil, c'est le JavaScript qui
change de page, et tout marche. Il n'apparait que lorsque quelqu'un ouvre un lien direct,
c'est-a-dire exactement ce que fait tout le monde quand on partage le lien.

Un 404 ici veut dire que le site est casse en ligne. Un 200 veut dire qu'il est publiable.
"""

import http.server
import os
import pathlib
import posixpath
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "dist" / "site"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5312

if not (ROOT / "index.html").exists():
    print(f"\n  ✗ {ROOT} est vide ou absent.\n    Construisez d'abord :  npm run build:site\n")
    raise SystemExit(1)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(ROOT), **k)

    def translate_path(self, path):
        rel = posixpath.normpath(path.split("?", 1)[0].split("#", 1)[0]).lstrip("/")
        target = ROOT / rel
        return str(target) if rel and target.is_file() else str(ROOT / "index.html")

    def log_message(self, fmt, *args):  # une ligne par requete, sans l'horodatage bruyant
        sys.stderr.write(f"  {fmt % args}\n")


print(f"""
  Aperçu sur http://127.0.0.1:{PORT}

  Le test qui compte : tapez http://127.0.0.1:{PORT}/pilot DIRECTEMENT dans la
  barre d'adresse, sans passer par l'accueil. Si la page s'affiche, le site est
  publiable ; si vous obtenez une erreur, il serait casse en ligne.

  Ctrl+C pour arreter.
""")
try:
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
except KeyboardInterrupt:
    print("\n  arrete.\n")
