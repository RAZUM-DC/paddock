---
node_type: report
title: G-017 pilot — SSO login, harness on demand, a network per user
description: "What the razum/g017-pilot branch changes in Paddock, the env vars, how to run it, what was and was not verified, and which commits can go upstream as separate PRs."
service: _platform
status: active
updated: 2026-10-29
links:
  documents: [../../web/lib/oidc.ts, ../../web/lib/identity.ts, ../../web/lib/provision.ts, ../../provisioner, ../../docker-compose.provisioner.yml]
  relates_to: [g017-mutation.md, ../reference/architecture.md, ../services/provisioner/README.md]
---

# G-017 pilot: SSO login, harness on demand, a network per user

Goal: a user signs in with the corporate IdP and gets a working agent without typing anything; every user's harness
lives in its own network. Branch `razum/g017-pilot`, based on upstream `e7bd2d6`. Every feature is opt-in through env
vars. With none of them set, Paddock behaves as before: password login, `add-user.sh`, a shared `core` network, and
the self-deploying web image.

## What changed

1. **User → harness mapping** (`web/lib/identity.ts`, `web/lib/auth.ts`). Before, `codexUserOf(email)` took the part
   before `@` and required `[a-z0-9-]`, so `first.last@corp` could not work. Now each user's harness id is decided
   once and stored in `harness_users` (auth db, `UNIQUE(harness_id)`). Password users keep their old name; OIDC users
   get `u-` + the first 12 hex characters of `sha256("${HARNESS_ID_SALT}:${issuer}:${sub}")`. The `u-<12 hex>` shape
   is reserved: `add-user.sh` and the legacy rule refuse it. Every call site now uses `harnessIdOf(user)` /
   `isAdminUser(user)`: WS bridge, turns, snapshots, `requireAdmin`.
2. **OIDC login** (`web/lib/oidc.ts`, login page). better-auth 1.7.14 `genericOAuth` with discovery, PKCE S256, nonce,
   and the id_token verified against the issuer's JWKS (`requireIdTokenVerification`). Groups come from the id_token
   plus userinfo; userinfo for a different `sub` is refused. `OIDC_ALLOWED_GROUPS` is checked at every login, and a
   user who has left the groups is refused **and their existing sessions are deleted**. `OIDC_ADMIN_GROUPS` grants
   admin as of the last login, alongside `ADMIN_USERS` (which now accepts harness ids or emails). Users are created
   on their first OIDC login; there is no other sign-up. There is no silent linking to an existing password account
   with the same email unless `OIDC_LINK_BY_EMAIL=1`. `LOCAL_LOGIN=0` hides the password form and switches email/password
   sign-in off on the server; it only applies when OIDC is configured, so nobody can lock themselves out.
3. **Provisioning hook in web** (`web/lib/provision.ts`, `/api/harness`, `components/workspace-status.tsx`). With
   `PROVISIONER_URL`, a missing token file or a harness that does not answer triggers
   `POST ${PROVISIONER_URL}/harness/ensure {id,email,name}`. Web then polls `GET /harness/<id>` until `{"ready":true}`,
   the token file exists and the port answers, for up to 120 s. Meanwhile the UI shows "Preparing your workspace",
   with a retry button if it fails. There is one run per id per process.
4. **Provisioner** (`provisioner/`, Node 22, no dependencies, Docker Engine API over the unix socket). It
   idempotently creates: a token (32 random bytes, hex, 644), an internal network `paddock-u-<id>` with web and egress
   attached (egress keeps the alias `egress`), the volumes, and `harness-<id>` with the same command, env and
   hardening as `users/_template.yml`. Limits come from env. The harness sits only on its own network, with alias
   `harness-<id>` and label `paddock.user=<id>`. Ids are validated strictly. An optional `USER_ENV_DIR/<id>.env`
   becomes the harness env; it cannot override the proxy vars. Optional `LLM_*` and `MCP_SERVERS_JSON` seed
   `config.toml` on first start. The provider block uses `env_key`, so the key never lands in `config.toml`. The seed
   is applied by `codex/entrypoint.sh` only when `config.toml` does not exist yet. A reconcile loop re-attaches web
   and egress after compose recreates them.
5. **Compose override** `docker-compose.provisioner.yml`. It adds the provisioner, fixes the container names
   `paddock-web` / `paddock-egress`, and adds an internal `control` network shared only by web and the provisioner.
   It also adds an internal `egress-api` network with a fixed subnet, so web reaches the gost API there and the API
   can admit only that subnet. It also adds a build-only `harness-image` service.
6. **Egress example** `docs/services/egress/gost.example.yaml`: direct outbound, private targets refused, admission
   for private clients, an API block with a placeholder password, and a hardened API variant (marked to verify).
7. **Image build option** `web/Dockerfile.prod`: the app is built at image build time and the container runs
   `tsx server.ts`, with no supervisor and no `/src`. Separately, `SELF_DEPLOY=0` makes the supervisor build once
   and ignore deploy requests.
8. **Settings UI**: a provider that `config.toml` makes active (e.g. one seeded by the provisioner) appears in the
   model picker under its own name, and the Codex tab shows it. Saving writes only the changed keys, so the
   provider block is never overwritten. The NeuralDeep tab is unchanged. The provider's *other* models are not
   listed, because web cannot see the key (it lives only in the harness env).

## Env vars

| where | var | default | meaning |
|---|---|---|---|
| web | `OIDC_ISSUER` | — | turns OIDC on; discovery at `${OIDC_ISSUER}/.well-known/openid-configuration` |
| web | `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | confidential client; redirect URI below |
| web | `OIDC_SCOPES` | `openid profile email groups` | |
| web | `OIDC_GROUPS_CLAIM` | `groups` | claim with the group list (array or space/comma separated string) |
| web | `OIDC_ALLOWED_GROUPS` | empty = any user of the IdP | comma list |
| web | `OIDC_ADMIN_GROUPS` | empty | comma list |
| web | `OIDC_PROVIDER_LABEL` | `SSO` | button text "Sign in with …" |
| web | `OIDC_LINK_BY_EMAIL` | `0` | `1` lets an OIDC login attach to an existing password user with the same (verified) email |
| web | `LOCAL_LOGIN` | `1` | `0` = SSO only (form hidden, server refuses email/password) |
| web | `HARNESS_ID_SALT` | empty (warns) | set once, never change: it is part of every OIDC user's harness id |
| web | `PROVISIONER_URL` / `PROVISIONER_TOKEN` | — | turn the provisioning hook on |
| web | `PROVISION_TIMEOUT_MS` | `120000` | |
| web | `SELF_DEPLOY` | `1` | `0` = the supervisor ignores deploy requests |
| web | `NODE_USE_ENV_PROXY` | — | set to `1` if the IdP is reachable only through egress (Node 22 fetch then honours `HTTPS_PROXY`; harness connections are excluded) |
| provisioner | `PROVISIONER_TOKEN` | — (required) | |
| provisioner | `HARNESS_IMAGE`, `HARNESS_MEMORY`, `HARNESS_CPUS`, `HARNESS_PIDS_LIMIT` | `paddock-harness-codex`, `4g`, `2`, `1024` | |
| provisioner | `TOKENS_DIR`, `HOST_TOKENS_DIR`, `USER_ENV_DIR`, `WEB_CONTAINER`, `EGRESS_CONTAINER`, `RECONCILE_INTERVAL_MS`, `PULL_MISSING_IMAGE` | see `docs/services/provisioner/README.md` | |
| provisioner | `LLM_PROVIDER_NAME`, `LLM_PROVIDER_LABEL`, `LLM_BASE_URL`, `LLM_WIRE_API` (`responses`), `LLM_DEFAULT_MODEL`, `LLM_API_KEY_ENV` (`LLM_API_KEY`) | — | seed `[model_providers.<name>]` with `env_key` |
| provisioner | `MCP_SERVERS_JSON` | — | `[{"id","url","bearer_env"}]` → `[mcp_servers.<id>] url, bearer_token_env_var` |
| compose | `PADDOCK_EGRESS_API_SUBNET` | `10.254.254.0/29` | |

**Redirect URI to register at the IdP:** `${PUBLIC_URL}/api/auth/callback/oidc`. better-auth 1.7 routes generic
OAuth providers through the core `/callback/:id` endpoint (verified in the mock-IdP run below). Post-logout: none,
because signing out of Paddock does not end the IdP session.

## How to run

```bash
# secrets/web.env (in addition to the existing BETTER_AUTH_SECRET, PUBLIC_URL, GOST_API_*):
#   OIDC_ISSUER=https://idp.example/o  OIDC_CLIENT_ID=…  OIDC_CLIENT_SECRET=…
#   OIDC_ALLOWED_GROUPS=paddock-users  OIDC_ADMIN_GROUPS=paddock-admins  OIDC_PROVIDER_LABEL=Company SSO
#   HARNESS_ID_SALT=<openssl rand -hex 16>  LOCAL_LOGIN=0
#   PROVISIONER_URL=http://provisioner:8080  PROVISIONER_TOKEN=<openssl rand -hex 32>
# secrets/provisioner.env: PROVISIONER_TOKEN=<same>  [LLM_PROVIDER_NAME=… LLM_BASE_URL=… LLM_DEFAULT_MODEL=…]
# secrets/user-env/<id>.env: LLM_API_KEY=…   (written by whatever issues per-user keys)
# secrets/egress/gost.yaml: from docs/services/egress/gost.example.yaml (or your chain + its bypass)
mkdir -p secrets/user-env
docker compose -f docker-compose.yml -f docker-compose.provisioner.yml --profile images build
docker compose -f docker-compose.yml -f docker-compose.provisioner.yml up -d
```

Without any `users/*.yml` the base compose file still works; `add-user.sh` users can coexist.

## Verified here

- `cd web && npx tsc --noEmit -p . && node scripts/check-i18n.mjs && npx next build` passes. The build logs
  "Database schema mismatch" during page-data collection on an empty database; upstream `e7bd2d6` logs the same.
- Unit tests: `web` 23 (`npm test`), `provisioner` 29 (`npm test`, including server.mjs against a fake Docker Engine API
  on a unix socket: auth, validation, idempotency, concurrency, missing image, reconcile, recreate).
- Mutation testing: see [g017-mutation.md](g017-mutation.md).
- **OIDC end to end against a mock IdP** (local HTTP server with discovery, JWKS, RS256 id_tokens, PKCE check,
  userinfo), using the real better-auth handler from `lib/auth.ts` (scratch script, not committed). 17/17 checks
  passed: redirect URI `${PUBLIC_URL}/api/auth/callback/oidc`, PKCE S256 and nonce sent, first login creates the user and derives the harness id, admin group applied on
  the next login, the harness id is stable, a user removed from the groups is refused with `not_allowed` and their
  old session is revoked, `LOCAL_LOGIN=0` makes `/sign-in/email` answer 400, a second person gets a different
  harness, and an id_token signed with the wrong key is refused.
- Legacy regression with no OIDC env: password login 200, harness id = email local part, `ADMIN_USERS` works, and
  the `oidc` provider is absent.
- Provisioning hook against a fake provisioner: one `ensure` for concurrent callers, the bearer token is sent,
  the state goes preparing → ready, an unreachable provisioner → failed → retry, and without `PROVISIONER_URL` the
  state is unmanaged.
- `codex/entrypoint.sh` seed: the generated `config.toml` parses as TOML, and without the seed it is byte-identical
  to the base config.
- `docker compose -f docker-compose.yml -f docker-compose.provisioner.yml config` is valid; the base file alone too.
- Codex `env_key` in `model_providers`: checked in the codex `rust-v0.165.0` source (`ModelProviderInfo.env_key`,
  read from the process environment).
- `web/Dockerfile.prod` steps replayed outside Docker: `npm ci`, `next build`, `npm prune --omit=dev`, then
  `tsx server.ts` answers `/login` 200.

## Not verified (needs a live IdP, Docker or LLM)

- A real IdP: claim names, whether `groups` arrives in the id_token or only in userinfo, the `iss` in the callback,
  the token endpoint auth method (better-auth defaults to `client_secret_post`; set `tokenEndpointAuth` in
  `lib/oidc.ts` if the IdP wants basic), and the `email_verified` semantics.
- Any Docker behaviour: image builds (`provisioner/Dockerfile`, `web/Dockerfile.prod`), the provisioner against a real
  Engine API (API version `v1.43` is hard-coded in `provisioner/docker.mjs`), and whether bind mounts of token files
  work with the host path discovered from the provisioner's own mount. Also that internal networks really isolate
  harnesses from each other through the shared web/egress, `DAC_OVERRIDE` being enough to write tokens into a
  host-owned `secrets/tokens`, and the reconcile loop after `docker compose up`.
- gost: `gost.example.yaml` was not run; the docker sandbox here had no daemon and downloading the gost binary was
  not permitted. The bypass is matched before DNS, so a public name resolving to a private address (DNS rebinding)
  is not caught.
- An LLM behind the seeded provider (that Codex reaches it with the key from `env_key`), and MCP seeding.
- The UI overlay and the login page in a real browser (only typechecked, i18n-checked and built; `tests/*.mjs` need a
  running instance and were not run).

## Open points / known limits

- Offboarding: the provisioner never deletes containers, networks or volumes; a user removed from the IdP group
  cannot log in, but their harness keeps running until removed by hand.
- Admin rights from `OIDC_ADMIN_GROUPS` are taken from the last login and stay valid for the session lifetime
  (30 days) unless the user logs in again or is removed from the allowed groups.
- The egress proxy port is shared by all users (web and egress sit on every user network). Without a bypass for
  private targets, it is a bridge between user networks (harnesses still require their own token). The gost API is
  password-only unless the hardened variant is used. Probe ports (`:18100+`, only when a proxy chain is configured)
  have no bypass.
- Web's HTTP port is reachable from every harness (same as from the browser: cookie session and Origin checks).
- With `PROVISIONER_URL` set, the admin's `add-user.sh --admin` source mount is not reproduced by the provisioner.

## Commits and upstream PRs

| commit | subject | upstream as |
|---|---|---|
| 7f009fc | store the user → harness mapping | PR 1 (prerequisite for SSO; useful alone for `first.last@` logins once create-user allows them) |
| 4de2c6f | OpenID Connect login (SSO) with group policy | PR 2 (needs PR 1) |
| ed94f89 | own auth-db tables after better-auth's migrations | squash into PR 1/2 |
| 72d3802 | reserve `u-<12 hex>` ids for SSO users | squash into PR 2 |
| f544186 | provisioner service | PR 3 |
| 1f5db9b | provisioner reconcile loop | PR 3 |
| 3a041dc | provisioner recreate test | PR 3 |
| e26be89 | web provisioning hook (`PROVISIONER_URL`) | PR 4 (needs PR 3 for anything to answer, but is inert without it) |
| 0c133c6 | compose override with per-user networks | PR 4 or 5 (with architecture doc changes) |
| d41b952 | egress example config | PR 6 (independent, docs only; verify on a real gost first) |
| 63984cc | `web/Dockerfile.prod` and `SELF_DEPLOY=0` | PR 7 (independent) |
| 39a5664 | provider from `config.toml` shown as active | PR 8 (independent) |

None of the commits contain company names, domains or secrets. `docs/razum/` is fork-only and should not go upstream.
