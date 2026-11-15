/**
 * Ce qui a le droit de sortir du dépôt — et ce qui n'en a pas le droit.
 *
 * ## POURQUOI CE FICHIER EXISTE
 *
 * L'archive livrée contenait un `.env` réel : la clé de signature des sessions, cinq
 * mots de passe de console et trois clés d'API. Le `.gitignore` était correct et l'est
 * toujours ; **la fuite n'est pas venue du dépôt, elle est venue de l'empaquetage**,
 * fait à la main par un `tar` sur le répertoire de travail. Un `.gitignore` ne protège
 * que `git`.
 *
 * La correction n'est donc pas une règle d'ignorance supplémentaire : c'est de faire de
 * l'empaquetage une commande vérifiable, avec une **liste d'autorisation** (les fichiers
 * suivis par git) doublée d'une **liste de refus** explicite. La liste d'autorisation
 * suffirait dans le cas normal ; la liste de refus existe pour le cas anormal —
 * `git add -f .env`, qui rend un secret « suivi » et donc éligible.
 *
 * ## POURQUOI LA LOGIQUE EST ISOLÉE ICI
 *
 * Pour être testée. `script/package-release.ts` invoque `git` et `tar` : le vérifier
 * suppose un dépôt et une archive. La décision « ce chemin peut-il sortir ? » est une
 * fonction pure d'une chaîne de caractères, et c'est la partie dont une erreur coûte un
 * secret publié.
 */

/**
 * Un gabarit versionné : un fichier dont le nom annonce qu'il ne contient aucune valeur.
 *
 * `.env.example` bénéficiait d'une exception écrite en dur. La convention méritait d'être
 * nommée une fois et réutilisée : sans cela, chaque nouvelle règle de refus doit
 * redécouvrir l'exception, et celle qui l'oublie refuse un fichier légitime — par exemple
 * un `service-account.example.json` servant de fixture. Une règle qui bloque le travail
 * légitime finit contournée, et un contournement protège moins bien qu'une exception
 * explicite.
 *
 * L'exception porte sur le nom, donc elle est déclarative : elle n'affirme pas que le
 * fichier est vide de secret, elle affirme que son auteur l'a déclaré tel. C'est
 * `npm run scan:secrets`, qui lit le contenu, qui vérifie cette déclaration.
 */
function isTemplateName(path: string): boolean {
  return (
    /\.(example|sample|template)$/.test(path) ||
    /\.(example|sample|template)\.[^./]+$/.test(path)
  );
}

/**
 * Motifs refusés, avec la raison affichée à l'opérateur.
 *
 * Les raisons sont dans la structure et non dans un message générique : un refus qui
 * dit seulement « fichier interdit » pousse à contourner la règle, un refus qui dit
 * quel secret serait publié pousse à la respecter.
 */
export const FORBIDDEN_RELEASE_ENTRIES: ReadonlyArray<{
  readonly test: (path: string) => boolean;
  readonly reason: string;
}> = [
  {
    // `.env.example` sort, comme tout gabarit : c'est la même exception que celle du
    // `.gitignore`, désormais portée par `isTemplateName` pour que les règles suivantes
    // en héritent au lieu de la réinventer.
    test: (path) => /(^|\/)\.env($|\.)/.test(path) && !isTemplateName(path),
    reason:
      "fichier d'environnement : contient OATHRION_SESSION_SECRET, les mots de passe de " +
      "console et les clés d'API en clair",
  },
  {
    // Phase 13 : le kit `deploy/` se remplit dans `deploy/placet.env`. La règle ci-dessus
    // ne vise que `.env` / `.env.*` ; un `<nom>.env` rempli est tout aussi secret.
    test: (path) => /(^|\/)[^/]+\.env$/.test(path) && !isTemplateName(path),
    reason:
      "fichier d'environnement rempli (`<nom>.env`) : mot de passe PostgreSQL, " +
      "OATHRION_SESSION_SECRET et mots de passe d'administration en clair",
  },
  {
    test: (path) => /(^|\/)data\.db($|-wal$|-shm$|-journal$)/.test(path),
    reason:
      "base SQLite : contient les données clients, les hachages de mots de passe et le " +
      "journal d'audit",
  },
  {
    test: (path) => path === "node_modules" || path.startsWith("node_modules/"),
    reason: "dépendances installées : reconstruites par `npm ci`, jamais livrées",
  },
  {
    test: (path) => path === "dist" || path.startsWith("dist/"),
    reason: "artefact de build : reconstruit par `npm run build`",
  },
  {
    test: (path) => path === ".mutation-backup" || path.startsWith(".mutation-backup/"),
    reason: "sauvegardes de script/mutation-audit.ts : état transitoire d'un audit",
  },
  {
    test: (path) => path.endsWith(".log"),
    reason: "journal : peut contenir des corps de requête et des en-têtes",
  },
  {
    test: (path) =>
      /(^|\/)id_(rsa|ed25519|ecdsa)($|\.)/.test(path) ||
      /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/.test(path) ||
      /^\.(ssh|gnupg)\//.test(path),
    reason: "clé privée ou magasin de clés",
  },
  {
    // `.npmrc` mérite d'être nommé séparément : c'est le fichier de credentials le plus
    // souvent livré par inadvertance, parce qu'il ressemble à de la configuration et
    // qu'on l'oublie. Il porte `//registry:_authToken=`, qui donne le droit de publier
    // sous le nom de l'organisation — donc d'exécuter du code chez tous les
    // installateurs. C'est un secret plus grave que la base de données.
    test: (path) =>
      !isTemplateName(path) &&
      (/(^|\/)\.(npmrc|netrc|pgpass|my\.cnf|htpasswd)$/.test(path) ||
        /(^|\/)kubeconfig$/.test(path) ||
        /(^|\/)(credentials|service-account[^/]*|gha-creds[^/]*)\.json$/.test(path) ||
        /^\.aws\//.test(path)),
    reason: "fichier de credentials : jeton de registre, mot de passe de base ou compte de service",
  },
  {
    // Un dump n'est pas seulement volumineux : il contient les lignes réelles — hachages
    // de mots de passe, jetons de session, journal d'audit d'autres locataires.
    //
    // Le cas `.sql` est le seul de cette liste qui demande un jugement, parce que
    // l'extension sert à deux choses opposées : une migration de schéma est du code, et
    // elle doit sortir ; un export de données ne doit pas. L'emplacement les distingue
    // de façon lisible et vérifiable — un dump ne se range pas dans `migrations/`.
    // Refuser `*.sql` sans exception bloquerait la migration PostgreSQL prévue plus
    // tard, et une règle qui bloque le travail légitime finit désactivée.
    test: (path) =>
      /\.(dump|bak\.sql)$/.test(path) ||
      /\.sql\.(gz|bz2|xz|zst|zip)$/.test(path) ||
      (path.endsWith(".sql") && !/(^|\/)(migrations?|schema|sql)\//.test(path)),
    reason:
      "export de base de données : contient les lignes réelles, hachages de mots de " +
      "passe et journal d'audit compris",
  },
  {
    // La règle `data.db` ci-dessus nomme la base du projet ; celle-ci attrape toute
    // autre base locale — `backup.db`, `prod.sqlite3`, la copie qu'on fait avant une
    // migration risquée et qu'on oublie.
    test: (path) => /\.(db|db3|sqlite|sqlite3)($|-wal$|-shm$|-journal$)/.test(path),
    reason: "base de données locale : contient des données réelles",
  },
  {
    test: (path) =>
      /^(coverage|\.nyc_output|\.cache|\.turbo|\.vite|\.next|\.parcel-cache)\//.test(path) ||
      /^(coverage|\.nyc_output|\.cache|\.turbo|\.vite)$/.test(path) ||
      path.endsWith(".tsbuildinfo"),
    reason: "cache ou rapport local : reconstruit, et parfois porteur de chemins absolus",
  },
  {
    // Les fichiers `.orig` et `.rej` sont ceux d'un conflit de fusion : ils contiennent
    // une *autre version* du fichier voisin. Livrés, ils exposent du code que personne
    // n'a relu et que le lecteur croira actif.
    test: (path) =>
      /\.(tmp|temp|bak|old|orig|rej|swp|swo)$/.test(path) ||
      path.endsWith("~") ||
      /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(path),
    reason: "fichier temporaire, sauvegarde d'éditeur ou résidu de conflit de fusion",
  },
  {
    // Dernière règle, et la plus faible : elle vise le nom, pas le contenu. Elle attrape
    // les formes courantes — `gcp-key.json`, `secrets.yaml`, `firebase-adminsdk.json` —
    // sans prétendre couvrir un nom arbitraire. Un fichier nommé `config2.json` et
    // rempli de jetons passerait ; c'est la limite de toute liste fondée sur les noms, et
    // c'est la raison d'être de `npm run scan:secrets`, qui lit le contenu.
    //
    // Comme la règle des credentials, elle laisse passer un gabarit : voir
    // `isTemplateName`.
    test: (path) =>
      !isTemplateName(path) &&
      (/(^|[-_.])(key|keys|secret|secrets|credential|credentials|token|tokens|password|passwords)\.(json|ya?ml|toml|ini|txt|env)$/.test(
        path,
      ) ||
        /(^|\/)(firebase-adminsdk|adminsdk)[^/]*\.json$/.test(path)),
    reason:
      "nom désignant un porteur de secret ; s'il ne s'agit que d'un gabarit, nommez-le " +
      "`.example` comme `.env.example`",
  },
];

/** La raison du refus, ou `null` si le chemin peut sortir. */
export function releasePathProblem(path: string): string | null {
  if (typeof path !== "string" || path.trim() === "") {
    return "chemin vide ou non textuel : refusé plutôt qu'interprété";
  }
  // Normalisé avant test : `./.env` et `.env` doivent recevoir la même réponse, sans
  // quoi la liste de refus se contourne par une écriture différente du même chemin.
  const normalised = path.replace(/^\.\//, "").replace(/\/+$/, "");
  for (const entry of FORBIDDEN_RELEASE_ENTRIES) {
    if (entry.test(normalised)) return entry.reason;
  }
  return null;
}

/**
 * Tous les problèmes d'un manifeste, pas seulement le premier.
 *
 * S'arrêter au premier laisserait croire, après correction, que l'archive est propre —
 * alors qu'un second secret attendrait la passe suivante.
 */
export function manifestProblems(paths: readonly string[]): string[] {
  const problems: string[] = [];
  for (const path of paths) {
    const problem = releasePathProblem(path);
    if (problem !== null) problems.push(`${path} — ${problem}`);
  }
  return problems;
}
