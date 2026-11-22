# Les VRAIS hooks concurrents, devant le corpus du banc, dans une machine jetable.
#
# Le contexte de construction est `script/bench` SEUL : rien d'autre du dépôt n'entre dans l'image.
# Le code des concurrents est pris aux versions lues le 18 novembre 2026 (`juges.ts`, SOURCES).
#
#   docker build --build-arg UID=$(id -u) --build-arg GID=$(id -g) -f script/bench/concurrents.Dockerfile -t oathrion-bench-concurrents script/bench
#   mkdir -p ../stress-runs/bench-concurrents
#   docker run --rm --network none -v "$PWD/../stress-runs/bench-concurrents:/out" oathrion-bench-concurrents
#
# `--network none` : pendant la mesure, ni les hooks ni rien d'autre ne parle au réseau. Seul
# `/out` est partagé avec la machine, pour les relevés.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git jq ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g tsx@4.23.11

RUN git clone -q https://github.com/dooly6276/claude-bulkhead /opt/bulkhead \
 && git -C /opt/bulkhead checkout -q 366f4a4ef0af2f92caad1bb2c9d3add9cf3bd9c7 \
 && git clone -q https://github.com/dwarvesf/claude-guardrails /opt/guardrails \
 && git -C /opt/guardrails checkout -q 39440d99715d67166e73d2765a347ca0bce1a877 \
 && git clone -q https://github.com/karanb192/claude-code-hooks /opt/karanb192 \
 && git -C /opt/karanb192 checkout -q 4b03f99be3df83773b1c4ae699c30195b6f716bf

# La personne `dev` du corpus : son dossier est /home/dev, le projet /home/dev/app. Elle porte le
# numéro de la personne qui lance le banc (`--build-arg UID=$(id -u)`), pour écrire dans /out ;
# l'utilisateur `node` de l'image, qui prend souvent ce numéro, est retiré.
ARG UID=1000
ARG GID=1000
RUN userdel -r node 2>/dev/null; groupdel node 2>/dev/null; \
    groupadd -g "$GID" dev \
 && useradd -m -u "$UID" -g "$GID" -d /home/dev -s /bin/bash dev \
 && mkdir -p /home/dev/.claude/hooks/scan-commit \
 && cp /opt/guardrails/full/scan-commit.sh /home/dev/.claude/hooks/scan-commit/scan-commit.sh \
 && chmod +x /home/dev/.claude/hooks/scan-commit/scan-commit.sh \
 && chown -R dev:dev /home/dev

COPY . /bench/script/bench
RUN echo '{ "type": "module" }' > /bench/package.json
USER dev
WORKDIR /home/dev
ENTRYPOINT ["bash", "/bench/script/bench/concurrents.sh"]
