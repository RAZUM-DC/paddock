# Paddock provisioner: no dependencies, only node. Runs as root inside the container because it needs the Docker
# socket (root-equivalent on the host anyway) and writes token files that the harness (uid 1000) reads.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json lib.mjs docker.mjs server.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.mjs"]
