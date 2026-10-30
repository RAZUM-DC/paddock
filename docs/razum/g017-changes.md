---
node_type: report
title: G-017 pilot — SSO login, harness on demand, a network per user
description: "What the razum/g017-pilot branch changes in Paddock, the env vars, how to run it, what was and was not verified, and which commits can go upstream as separate PRs."
service: _platform
status: active
updated: 2026-10-30
links:
  documents: [../../web/lib/oidc.ts, ../../web/lib/identity.ts, ../../web/lib/provision.ts, ../../provisioner, ../../docker-compose.provisioner.yml]
  relates_to: [g017-mutation.md, g017-git-secrets.md, g017-host-firewall.md, ../reference/architecture.md, ../services/provisioner/README.md]
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
   for private clients, an API block with a placeholder password. (The "hardened" API-as-a-service variant does not
   work in gost 3.3.2 and was removed; port 18080 is fenced by the host firewall instead.)
7. **Image build option** `web/Dockerfile.prod`: the app is built at image build time and the container runs
   `tsx server.ts`, with no supervisor and no `/src`. Separately, `SELF_DEPLOY=0` makes the supervisor build once
   and ignore deploy requests.
8. **Settings UI**: a provider that `config.toml` makes active (e.g. one seeded by the provisioner) appears in the
   model picker under its own name, and the Codex tab shows it. Saving writes only the changed keys, so the
   provider block is never overwritten. The NeuralDeep tab is unchanged. The provider's *other* models are not
   listed, because web cannot see the key (it lives only in the harness env).

### Provisioner and per-user network fixes (branch `razum/g017-provision-fixes`)

From an independent review ("enable with fixes"):

- **H1, legacy ids.**
  - The provisioner accepts only `^u-[0-9a-f]{12}$`. A legacy name gets 400 before Docker is touched.
  - Web (`managedHarness` in `lib/provision.ts`) asks for or reports provisioning only for SSO ids. A legacy
    (`add-user.sh`) harness is `unmanaged` everywhere, including the WS bridge's ECONNREFUSED path in `server.ts`.
    A missing legacy container is therefore never recreated by the provisioner.
- **M1, client address.**
  - `server.ts` rewrites the forwarding headers of every request except `/api/harness/*`, which still refuses any
    such header. Only peers in `TRUSTED_PROXIES` (loopback and the edge's static core address) keep their
    `X-Forwarded-For`. Everyone else's `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, `X-Forwarded-Host/Proto/Port`,
    `X-Client-IP`, `True-Client-IP` and `CF-Connecting-IP` are dropped, and `X-Forwarded-For` becomes the TCP peer.
  - better-auth's `trustedProxies` is now only `TRUSTED_PROXY_HOPS` (default none), instead of every private range.
  - A harness can no longer rotate its "client address" past the sign-in rate limit; this is tested on the real
    better-auth limiter.
- **M2.** `DOCKER_API_VERSION` (default `v1.44`, validated) instead of a hard-coded `v1.43`.
- **M4.**
  - Harness logs: json-file, 3 × 10 MB. `MemorySwap` = memory. `HARNESS_PIDS_LIMIT` defaults to 512. Same in
    `users/_template.yml`.
  - Optional `MAX_HARNESSES`: a 409 pre-check on the request, then a serialised re-check, so concurrent first logins
    cannot overshoot the cap.
- **Fixed bridge names.**
  - User networks get `pu<12 hex>`. Compose networks get `pd-core` (fixed subnet), `pd-out` and `pd-eapi`.
  - The edge has a static core address (`PADDOCK_EDGE_IP`).
  - A user network made before this change is kept and logged once as `WARNING … is not on bridge pu…`.
- **Egress / host.**
  - [gost.razum.yaml](gost.razum.yaml): a deny-list bypass with `resolver: public`, and the top-level `api:`. A
    `type: api` service accepts and closes in 3.3.2 (seen in production), so the API cannot be limited inside gost.
  - [paddock-guard.nft](paddock-guard.nft) with its namespace test.
  - The address pool, br_netfilter and the network switch procedure are in
    [g017-host-firewall.md](g017-host-firewall.md).
- **Tests added for the review's points:**
  - P06: a body over 4 KB gets 413.
  - P11: a container with a foreign `paddock.user` label is never started.
  - P15: none of the reserved env vars can be overridden.
- **After the production rollout:**
  - `control` gets a fixed subnet.
  - The gost API moves back to the top-level `api:`.
  - Egress's own connections on internal bridges are dropped: a static core IP, plus its MACs on user networks.
    This closed DNS rebinding to a legacy harness on core. The same hole existed on user bridges and is closed the
    same way.
  - The MACs are learned by the host: an nft set `egress_macs`, filled by `paddock-guard-egress-sync.sh` on
    egress's connect events and every minute. A fixed `EGRESS_MAC` set by the provisioner was tried and dropped,
    because Docker 29 ignores `MacAddress` on a network connect of a running container.
- **Mutation testing of the new lines: 47 mutants, 45 killed** (the 7 `EGRESS_MAC` mutants went with the feature).
  - Provisioner (20): id regexp, bridge name/option, swap, logs, pids default, API version (default, validation,
    passed to the client), `MAX_HARNESSES` (validation, off-by-one, pre-check, serialisation, counting stopped and
    only managed containers), the old-network warning, and the ownership label guard (P11).
  - Web (27): `isProvisionedId`/`managedHarness`, both `server.ts` ensure sites, normalisation on HTTP/WS/harness
    API, each dropped header, the trusted branch, `peerAddress`, `parseTrustList`, `ProxyTrust` resolve/refresh,
    `trustedHops`, and better-auth's `trustedProxies`.
  - Survivors Q09, Q16, Q17 and W26 got tests.
  - Two survivors are equivalent:
    - Q15: the re-inspect inside the serialised create is redundant because ensures are already de-duplicated per id.
    - W27: the address-family guard in `isTrusted` is redundant because `BlockList.check` returns false for
      non-addresses.

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
| web | `TRUSTED_PROXIES` | `127.0.0.1,::1,edge` (override: `127.0.0.1,::1,${PADDOCK_EDGE_IP}`) | peers whose `X-Forwarded-For` is kept (IPs, CIDRs, host names re-resolved every 60 s); everyone else's forwarding headers are replaced by the TCP peer |
| web | `TRUSTED_PROXY_HOPS` | empty | IPs/CIDRs of proxies in front of the edge (e.g. a TLS front), skipped by better-auth inside `X-Forwarded-For` |
| provisioner | `HARNESS_IMAGE`, `HARNESS_MEMORY`, `HARNESS_CPUS`, `HARNESS_PIDS_LIMIT` | `paddock-harness-codex`, `4g`, `2`, `512` | swap = memory (none extra); json-file logs 3 × 10 MB |
| provisioner | `MAX_HARNESSES` | `0` (no cap) | a new harness beyond N managed containers gets 409 |
| provisioner | `DOCKER_API_VERSION` | `v1.44` | Engine API version used in request paths |
| provisioner | `TOKENS_DIR`, `HOST_TOKENS_DIR`, `USER_ENV_DIR`, `WEB_CONTAINER`, `EGRESS_CONTAINER`, `RECONCILE_INTERVAL_MS`, `PULL_MISSING_IMAGE` | see `docs/services/provisioner/README.md` | |
| provisioner | `LLM_PROVIDER_NAME`, `LLM_PROVIDER_LABEL`, `LLM_BASE_URL`, `LLM_WIRE_API` (`responses`), `LLM_DEFAULT_MODEL`, `LLM_API_KEY_ENV` (`LLM_API_KEY`) | — | seed `[model_providers.<name>]` with `env_key` |
| provisioner | `MCP_SERVERS_JSON` | — | `[{"id","url","bearer_env"}]` → `[mcp_servers.<id>] url, bearer_token_env_var` |
| compose | `PADDOCK_EGRESS_API_SUBNET` | `10.254.254.0/29` | web ↔ gost API (bridge `pd-eapi`) |
| compose | `PADDOCK_CONTROL_SUBNET` | `172.20.9.0/24` | web ↔ provisioner; every compose network has a fixed subnet (a pooled one can collide with a parallel create: "Pool overlaps") |
| compose | `PADDOCK_EGRESS_IP` | `172.20.1.251` | egress's static core address; `EGRESS_CORE_IP` in paddock-guard.nft |
| host | `EGRESS_CONTAINER`, `NETWORK_PREFIX`, `NFT_TABLE` | `paddock-egress`, `paddock-u-`, `inet paddock_guard` | for `paddock-guard-egress-sync.sh` |
| compose | `PADDOCK_CORE_SUBNET` / `PADDOCK_OUTSIDE_SUBNET` | `172.20.1.0/24` / `172.20.2.0/24` | bridges `pd-core` / `pd-out` (egress-api: `pd-eapi`) |
| compose | `PADDOCK_EDGE_IP` | `172.20.1.250` | the edge's static address on core, trusted by web |

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
- Unit tests (as of the provision fixes): `web` 150 (`npm test`), `provisioner` 41 (`npm test`, including server.mjs against a fake Docker Engine API
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
  Engine API (API version `DOCKER_API_VERSION`, default `v1.44`; prod Engine 29.x accepts 1.40–1.56), and whether bind mounts of token files
  work with the host path discovered from the provisioner's own mount. Also that internal networks really isolate
  harnesses from each other through the shared web/egress, `DAC_OVERRIDE` being enough to write tokens into a
  host-owned `secrets/tokens`, and the reconcile loop after `docker compose up`.
- gost: neither `gost.example.yaml` nor `gost.razum.yaml` was run (no Docker daemon; building gost was not
  permitted). Both were checked against the gost 3.3.2 source: the bypass is matched before DNS and resolved addresses
  are never re-checked, so DNS rebinding is left to the host firewall ([g017-host-firewall.md](g017-host-firewall.md)).
- An LLM behind the seeded provider (that Codex reaches it with the key from `env_key`), and MCP seeding.
- The UI overlay and the login page in a real browser (only typechecked, i18n-checked and built; `tests/*.mjs` need a
  running instance and were not run).

## Open points / known limits

- Offboarding: the provisioner never deletes containers, networks or volumes; a user removed from the IdP group
  cannot log in, but their harness keeps running until removed by hand.
- Admin rights from `OIDC_ADMIN_GROUPS` are taken from the last login and stay valid for the session lifetime
  (30 days) unless the user logs in again or is removed from the allowed groups.
- The egress proxy port is shared by all users (web and egress sit on every user network). Without a bypass for
  private targets, it is a bridge between user networks (harnesses still require their own token). `gost.razum.yaml`
  refuses private targets and container names; the host rules close rebinding (rule 1 outside; egress's static
  core IP and fixed MAC on internal bridges), intra-bridge ports, and port 18080 everywhere but pd-eapi. Probe ports (`:18100+`, only when a proxy chain is configured) have no bypass.
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
| 54c5aa3 | provisioner: SSO ids only, `pu<hex>` bridges, `DOCKER_API_VERSION`, bounded logs/swap/pids, `MAX_HARNESSES` | squash into PR 3 |
| 1632678 | web: provision only SSO harnesses; client address from the TCP peer unless it is the edge | PR 4 (provisioning part); the client-address part is an independent PR (any deployment with an edge) |
| 7845cbc | compose: fixed bridge names, core subnet, static edge address | PR 4 or 5 |
| d8c5b79, 68d185f | provisioner: warning for pre-change networks; README; tests | squash into PR 3 |
| a54b3a4 | `docs/razum`: gost config, nft rules, firewall runbook | fork only |

None of the commits contain company names, domains or secrets. `docs/razum/` is fork-only and should not go upstream.
