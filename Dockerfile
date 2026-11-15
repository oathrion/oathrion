# Oathrion — production image.
#
# ## Base image choice
#
# `node:22-bookworm-slim`, not Alpine. Node 22 because `package.json` declares
# `engines.node >= 22.0.0` — Node 20 reached end of life in April 2026 and was moved off on
# 28 October 2026 — pinned to a major rather than `latest` so a rebuild six months from now
# produces the same runtime. Debian slim rather than Alpine because
# `better-sqlite3` is a native addon: it ships prebuilt binaries for glibc, and on musl it
# must be compiled from source in every image build — slower, and dependent on a toolchain
# that then has to be kept in the image or carefully stripped. Slim is ~80 MB against
# Alpine's ~50 MB, and that is the right trade for a build that does not silently break.
#
# ## Why multiple stages
#
# The builder needs a C++ toolchain (node-gyp) and every devDependency: vite, esbuild,
# typescript, tsx. None of that belongs in a running server. The final stage copies only
# the compiled output and the production `node_modules`, so the toolchain, the source tree
# and the dev dependencies never reach the published layers.
#
# ## Secrets
#
# There are none in this image, and there is no `ARG` or `ENV` that could carry one. Every
# secret arrives at runtime through the environment, which is what `SecretProvider` reads
# (`server/secrets/provider.ts`). `.dockerignore` excludes `.env` and `data.db*` so a
# developer's local credentials and database cannot be captured into a layer by accident.
# Note that build args and env vars are both visible in the image history — that is
# precisely why neither is used for secrets here.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — dependencies, with the toolchain a native addon may need.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

# `python3 make g++` are required by node-gyp if `better-sqlite3` has no prebuilt binary
# for this platform. They exist only in this stage and are never copied forward.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the manifests, so this layer is reused whenever dependencies have not changed —
# the source changing does not force a reinstall.
COPY package.json package-lock.json ./

# `npm ci` rather than `npm install`: it installs exactly the tree in the lockfile and
# fails if the manifest and lockfile disagree, instead of quietly resolving a newer
# version. That is what makes the build reproducible.
RUN npm ci

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — build the client bundle and the server bundle.
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS build

WORKDIR /app
COPY . .

# `npm run build` (script/build.ts) emits dist/public for the client and dist/index.cjs
# for the server. `better-sqlite3` is deliberately left external by that script, so the
# runtime stage must still carry node_modules — see below.
RUN npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3 — production dependencies only.
# ─────────────────────────────────────────────────────────────────────────────
# A separate stage rather than `npm prune --production` in the build stage: pruning
# rewrites a layer that already contains the dev tree, so the removed files still occupy
# space in the image history. Installing fresh from the same lockfile produces a clean
# layer and keeps determinism.
FROM deps AS prod-deps

WORKDIR /app
RUN npm ci --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4 — runtime.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# NODE_ENV=production is not cosmetic: Express skips view caching and verbose error
# output, and Oathrion's own startup checks read it. All other configuration — PORT,
# DATABASE_URL, OATHRION_SESSION_SECRET, OATHRION_KEK, SECRET_PROVIDER — is supplied at run time
# and has no default here.
# OATHRION_HOST=0.0.0.0 : DANS le conteneur, l'écoute doit couvrir l'interface du réseau
# Docker, sinon ni le proxy ni une publication de port ne l'atteignent. Ce n'est PAS une
# exposition publique : ce qui atteint l'hôte ou Internet est décidé par `ports:` /
# `expose:` dans Compose et par le proxy. Hors conteneur, le défaut du serveur est
# 127.0.0.1.
ENV NODE_ENV=production \
    PORT=5000 \
    OATHRION_HOST=0.0.0.0

WORKDIR /app

# The `node` user (uid 1000) ships with the official image, so there is no need to create
# one. Running as root would mean a process escape starts with root in the container.
# Ownership is set at copy time via --chown rather than a later `chown -R`, which would
# duplicate every file into a new layer.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build     --chown=node:node /app/dist          ./dist
COPY --chown=node:node package.json ./

# `server/migrations/` is read at boot to apply pending migrations, and script/ holds the
# PostgreSQL migration entry point an operator may run as a one-off job.
COPY --from=build --chown=node:node /app/server/migrations ./server/migrations

USER node

EXPOSE 5000

# The probe uses node's global fetch rather than curl or wget, so no extra package is
# installed for the sole purpose of testing the process.
#
# It targets /api/ready, which answers 200 when this instance should receive traffic and
# 503 while draining or when the database is unreachable (server/routes.ts). A non-2xx
# exits 1, so a container whose database has gone away is reported unhealthy rather than
# merely alive — the distinction a load balancer acts on.
#
# Was /api/health, which behaves identically and is kept as an alias. Pointed at the
# explicit name because "health" is the ambiguous word that led to liveness and
# readiness being conflated in the first place: a reader of this file should be able to
# tell which of the two questions is being asked without opening the route.
#
# A Docker HEALTHCHECK is a readiness signal here, not a liveness one. Plain `docker run`
# does not restart an unhealthy container; Swarm replaces it, and Compose's
# `depends_on: condition: service_healthy` gates startup on it. If you are on Kubernetes,
# do NOT point livenessProbe at this — use /api/live. See DEPLOYMENT.md §14.
#
# start-period gives migrations time to run at boot before a slow start counts as a
# failure. The interval is deliberately unaggressive: this endpoint touches the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly. This matters: Oathrion installs
# a SIGTERM handler that drains connections and reports `degraded` before closing the
# listener (server/index.ts). Wrapped in a shell, the signal would reach the shell instead
# and the drain would never run — every deploy would reset in-flight requests.
#
# `node dist/index.cjs` rather than `npm start`, for the same reason: npm would sit
# between the init system and the process it is supposed to be signalling.
CMD ["node", "dist/index.cjs"]
