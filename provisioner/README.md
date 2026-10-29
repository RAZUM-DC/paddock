# Paddock provisioner

Creates a user's harness on demand, each in its own `internal` Docker network. The web UI calls it when a user
connects and their harness is missing (`PROVISIONER_URL` in `secrets/web.env`). It is the only Paddock container
with the Docker socket, and it listens only on the `control` network it shares with web.

Run it with the compose override: `docker compose -f docker-compose.yml -f docker-compose.provisioner.yml up -d`.
Full description, env vars and the isolation model: [docs/services/provisioner/README.md](../docs/services/provisioner/README.md).

```
GET  /health                                → {"ok":true}
POST /harness/ensure {"id","email","name"}  → 202 {"id","ready","state"}   (Authorization: Bearer $PROVISIONER_TOKEN)
GET  /harness/<id>                          → 200 {"id","ready","state"}
```

Tests (no Docker needed, a fake Engine API on a unix socket): `npm test`.
