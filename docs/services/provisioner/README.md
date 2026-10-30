---
node_type: service
title: provisioner — harness on demand, one network per user
description: "Optional service: creates harness-<id> with its own internal network, volumes and token when a user first connects; the only container with the Docker socket."
service: provisioner
status: active
updated: 2026-10-30
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
2. Network `paddock-u-<id>`: bridge, `internal: true`, labels `paddock.user=<id>`, Linux bridge name
   `pu<12 hex>` (the id without `u-`), so host firewall rules can match every user network as `pu*`. `paddock-web` and `paddock-egress`
   (`WEB_CONTAINER`, `EGRESS_CONTAINER`) are connected to it; egress gets the alias `egress` there, so the harness's
   `HTTPS_PROXY=http://egress:8080` works unchanged, and web gets the alias `web` (`WEB_ALIAS`), so the git credential
   helper and the `secrets` tool reach `http://web:3000` as on `core`. A container that is already on the network
   without its alias (attached before the alias existed) is disconnected and reconnected with it, on ensure and in
   the reconcile loop. New harnesses also get `PADDOCK_WEB_URL=http://<WEB_CONTAINER>:<WEB_PORT>` in their env (the
   container name always resolves); a per-user env file cannot override it.
3. Volumes `harness-home-<id>`, `workspace-<id>`.
4. Container `harness-<id>` from `HARNESS_IMAGE`: the same command, env, `cap_drop: ALL`, `no-new-privileges`, restart
   `unless-stopped` as `users/_template.yml`; limits `HARNESS_MEMORY` (swap: none beyond it) / `HARNESS_CPUS` /
   `HARNESS_PIDS_LIMIT` (defaults 4g / 2 / 512), json-file logs capped at 3 × 10 MB; attached **only** to
   `paddock-u-<id>` with the DNS alias `harness-<id>`. With `MAX_HARNESSES=N`, a new harness beyond N managed
   containers is refused with 409 (existing ones are still ensured; creates are serialised, so the cap holds under
   concurrent logins).

Every `RECONCILE_INTERVAL_MS` (default 60 s, `0` = off) it re-attaches web and egress to every network it made:
`docker compose up` recreates them and they lose the networks that were attached at runtime.

`GET /harness/<id>` answers `{"ready": true}` once the container is running and its token exists.
Ids are checked strictly: only `^u-[0-9a-f]{12}$` (SSO users). Legacy names (`add-user.sh` harnesses on `core`) are
refused with 400 before Docker is touched, and web never asks for them (their state is `unmanaged`).

**Networks made before fixed bridge names** (Docker named them `br-<hex>`) are kept as they are and logged once with
`WARNING … is not on bridge pu…`; the host firewall's `pu*` rules do not see them. To move one (volumes stay):
`docker rm -f harness-<id> && docker network rm paddock-u-<id>` (disconnect web/egress first if Docker refuses:
`docker network disconnect -f paddock-u-<id> paddock-web`, same for `paddock-egress`); the next login recreates both.

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
| `WEB_ALIAS` | `web` | web's name on user networks |
| `EGRESS_MAC` | `02:00:00:00:00:e1` | egress's MAC on every user network, so a host firewall can drop connections egress opens there (DNS rebinding through the proxy); `""` = Docker's own. An egress attached with another MAC is reconnected once |
| `WEB_PORT` | `3000` | web's port, for the harness's `PADDOCK_WEB_URL` |
| `HARNESS_MEMORY` / `HARNESS_CPUS` / `HARNESS_PIDS_LIMIT` | `4g` / `2` / `512` | swap is set equal to memory (no swap) |
| `MAX_HARNESSES` | `0` (no cap) | cap on managed harness containers; a new one beyond it gets 409 |
| `DOCKER_API_VERSION` | `v1.44` | Engine API version in request paths (`v1.NN`); 1.44 = Engine 25+, works on newer engines |
| `USER_ENV_DIR` | — | per-user env files |
| `RECONCILE_INTERVAL_MS` | `60000` | re-attach web/egress to user networks; `0` = off |
| `LLM_*`, `MCP_SERVERS_JSON` | — | see above |

## Security notes

- The Docker socket is root on the host. The provisioner is reachable only from web, on `control` (internal), and
  every call but `/health` needs the bearer token. It only creates objects named after a validated id and refuses to
  touch a `harness-<id>` container that is not labelled `paddock.user=<id>`.
- Containers it creates are never deleted by it. Offboarding (removing a user's container, network and volumes) is a
  manual step today.
