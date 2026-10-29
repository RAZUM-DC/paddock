# Образ — только рантайм. Исходники приходят томом /src (их правит codex), сборки живут в /build.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash rsync curl ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /build /data /home/node/.npm \
 && chown -R node:node /build /data /home/node

COPY --chown=node:node supervisor.sh /usr/local/bin/supervisor.sh

USER node
ENV NODE_ENV=production PORT=3000 AUTH_DB=/data/auth.db TOKENS_DIR=/run/secrets/tokens
EXPOSE 3000
CMD ["bash", "/usr/local/bin/supervisor.sh"]
