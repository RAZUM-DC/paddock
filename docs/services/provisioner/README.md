---
node_type: service
title: provisioner — harness on demand, one network per user
description: "Optional service: creates harness-<id> with its own internal network, volumes and token when a user first connects; the only container with the Docker socket."
service: provisioner
status: active
updated: 2026-10-29
links:
  documents: [../../../provisioner, ../../../docker-compose.provisioner.yml, ../../../codex/entrypoint.sh]
  relates_to: [../../reference/architecture.md, ../harness/README.md, ../web/README.md]
---

# provisioner — harness on demand, one network per user

Optional. Without it, harnesses are created by hand with `./add-user.sh` and live together on `core`, as before.
With it (`docker-compose.provisioner.yml`), a user who signs in for the first time gets a working harness without an
admin: the web UI asks the provisioner, shows "preparing your workspace", and connects when the harness answers.

## What `POST /harness/ensure {id}` does (idempotent)

1. Token `${TOKENS_DIR}/<id>.token`: 32 random bytes, hex, mode 644 (like `add-user.sh`); an existing one is kept.
2. Network `paddock-u-<id>`: bridge, `internal: true`, labels `paddock.user=<id>`. `paddock-web` and `paddock-egress`
   (`WEB_CONTAINER`, `EGRESS_CONTAINER`) are connected to it; egress gets the alias `egress` there, so the harness's
   `HTTPS_PROXY=http://egress:8080` works unchanged.
3. Volumes `harness-home-<id>`, `workspace-<id>`.
4. Container `harness-<id>` from `HARNESS_IMAGE`: the same command, env, `cap_drop: ALL`, `no-new-privileges`, restart
   `unless-stopped` as `users/_template.yml`; limits `HARNESS_MEMORY` / `HARNESS_CPUS` / `HARNESS_PIDS_LIMIT`
   (defaults 4g / 2 / 1024); attached **only** to `paddock-u-<id>` with the DNS alias `harness-<id>`.

Every `RECONCILE_INTERVAL_MS` (default 60 s, `0` = off) it re-attaches web and egress to every network it made:
`docker compose up` recreates them and they lose the networks that were attached at runtime.

`GET /harness/<id>` answers `{"ready": true}` once the container is running and its token exists.
Ids are checked strictly: `^u-[0-9a-f]{12}$` (OIDC users) or `^[a-z0-9-]{1,32}$` (legacy names).

## Per-user env and a default LLM provider

- `USER_ENV_DIR/<id>.env` (optional, `KEY=value` lines): passed to the harness as environment, e.g.
  `LLM_API_KEY=…`. `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `CODEX_HOME` cannot be overridden from it. Read when the
  container is created: after changing it, remove the container (`docker rm -f harness-<id>`) and let the next
  login recreate it (volumes stay).
- `LLM_PROVIDER_NAME`, `LLM_BASE_URL`, `LLM_WIRE_API` (default and only supported value `responses`),
  `LLM_DEFAULT_MODEL`, optional `LLM_PROVIDER_LABEL` and `LLM_API_KEY_ENV` (default `LLM_API_KEY`): on the harness's
  **first** start its `config.toml` is seeded with `model_provider`, `model` and a `[model_providers.<name>]` block with
  `env_key = "<LLM_API_KEY_ENV>"`. The key itself never lands in `config.toml`; Codex reads it from the environment.
- `MCP_SERVERS_JSON` (optional): `[{"id":"gw","url":"https://…/mcp","bearer_env":"MCP_GW_TOKEN"}]` seeds
  `[mcp_servers.<id>]` with `url` and `bearer_token_env_var`. The token comes from the user's env file too.

The seed travels as `PADDOCK_CONFIG_PREPEND` / `PADDOCK_CONFIG_APPEND` and is written by `codex/entrypoint.sh`
only when `config.toml` does not exist yet; later edits (Settings → Codex) are never overwritten.

## Env

| var | default | |
|---|---|---|
| `PROVISIONER_TOKEN` | — (required, 16+ chars) | shared with web (`secrets/web.env`) |
| `PORT` | `8080` | |
| `HARNESS_IMAGE` | `paddock-harness-codex` | must exist locally unless `PULL_MISSING_IMAGE=1` |
| `TOKENS_DIR` | `/run/secrets/tokens` | where token files are written inside the provisioner |
| `HOST_TOKENS_DIR` | from its own mount | the same directory on the host (bind source for harnesses) |
| `PROVISIONER_CONTAINER` | `paddock-provisioner` | its own name, to find the host path above |
| `WEB_CONTAINER` / `EGRESS_CONTAINER` | `paddock-web` / `paddock-egress` | |
| `HARNESS_MEMORY` / `HARNESS_CPUS` / `HARNESS_PIDS_LIMIT` | `4g` / `2` / `1024` | |
| `USER_ENV_DIR` | — | per-user env files |
| `RECONCILE_INTERVAL_MS` | `60000` | re-attach web/egress to user networks; `0` = off |
| `LLM_*`, `MCP_SERVERS_JSON` | — | see above |

## Security notes

- The Docker socket is root on the host. The provisioner is reachable only from web, on `control` (internal), and
  every call but `/health` needs the bearer token. It only creates objects named after a validated id and refuses to
  touch a `harness-<id>` container that is not labelled `paddock.user=<id>`.
- Containers it creates are never deleted by it. Offboarding (removing a user's container, network and volumes) is a
  manual step today.
