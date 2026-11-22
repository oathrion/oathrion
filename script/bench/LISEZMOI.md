# Le banc comparatif

Oathrion, Claude Code et les hooks concurrents, devant le même corpus figé.

| Fichier | Rôle |
|---|---|
| `corpus.ts` | Les actions et leurs étiquettes (« libre », « demander », « refuser »), écrites avant toute mesure |
| `juges.ts` | Oathrion (son vrai code), Claude Code (modélisé), les concurrents (modélisés d'après leur code source, versions notées) |
| `vrais-hooks.ts` | Envoie chaque action à un vrai hook, comme Claude Code le ferait, et note le verdict et le temps |
| `concurrents.Dockerfile`, `concurrents.sh` | Les vrais hooks concurrents, dans une machine jetable |
| `../bench-adoption.ts` | Le rapport |

## Lancer

Sans réseau, en quelques secondes :

```bash
npx tsx script/bench-adoption.ts
```

Avec le vrai hook d'Oathrion, un processus par appel (après `npm run build`) :

```bash
npx tsx script/bench-adoption.ts --hook-reel
```

## Les vrais hooks concurrents

Leur code n'est jamais lancé sur la machine de travail : seulement dans un conteneur jetable,
sans réseau pendant la mesure, qui ne partage que le dossier des relevés.

```bash
docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f script/bench/concurrents.Dockerfile -t oathrion-bench-concurrents script/bench
```

```bash
mkdir -p ../stress-runs/bench-concurrents
```

```bash
docker run --rm --network none -v "$PWD/../stress-runs/bench-concurrents:/out" oathrion-bench-concurrents
```

```bash
npx tsx script/bench-adoption.ts --hook-reel --observe ../stress-runs/bench-concurrents
```

Le rapport prend alors les verdicts OBSERVÉS à la place des modèles, et le dit.

## Les règles du jeu

- Le corpus ne se corrige pas pour faire gagner un outil. Une étiquette qui change dit pourquoi,
  dans `docs/STRESS-TEST-LOG.md`.
- Un cas où un modèle n'est pas sûr est marqué « incertain » et compté en faveur du concurrent.
- Les hooks concurrents sont posés sur le mode YOLO de Claude Code : c'est le cas où l'on compte
  sur eux. Posés sur son mode par défaut, ils héritent de ses questions.
- Avant de publier une comparaison qui nomme un concurrent : la refaire avec ses vrais hooks
  (ci-dessus), et lui proposer de relire.
