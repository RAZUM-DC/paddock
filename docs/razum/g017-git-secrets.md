---
node_type: report
title: G-017 — git accounts per user and secret requests
description: "Branch razum/g017-git-secrets: per-user git accounts served to the harness through a credential helper, commit identity, the secrets tool with a masked form, default tools; env vars, end-to-end flow, threat notes, verification, mutation testing, upstream plan."
service: _platform
status: active
updated: 2026-10-30
links:
  documents: [../../web/lib/git-accounts.ts, ../../web/lib/secret-box.ts, ../../web/lib/harness-api.ts, ../../web/lib/harness-auth.ts, ../../web/lib/secret-requests.ts, ../../web/tools/secrets, ../../codex/git-credential-paddock, ../../codex/gitconfig]
  relates_to: [g017-changes.md, ../reference/architecture.md]
---

# G-017: git accounts per user and secret requests

Branch `razum/g017-git-secrets`, on top of `razum/g017-pilot`. The idea comes from get-bb/bb (MIT): git credentials
reach git through a credential helper, never through files the user types or the chat; secrets the agent needs are
typed by the human into a masked form and land in a file, never in the transcript.

## What changed

**1. Git accounts per user.**

- *Settings → Git* (RU/EN): commit identity (name, email) and a list of accounts: host (`github.com`,
  `gitlab.example.com[:port]`), optional path prefix (`my-org/` limits the account to repositories under it), username
  (prefilled `x-access-token` for github.com, `oauth2` elsewhere, editable), token (password field, never shown again),
  label. The list shows label, host, prefix, username, last 4 characters of the token and the date. The help text asks
  for fine-grained, repository-scoped tokens with an expiry, and says the agent can read a token it uses.
- Storage: table `git_accounts` in the auth db (created on first use, after better-auth's migrations, like the
  branch's other tables). The token is sealed with AES-256-GCM (`web/lib/secret-box.ts`); the additional data is
  `git:<user id>:<account id>`, so a ciphertext copied to another row or user does not decrypt. Key:
  `PADDOCK_SECRETS_KEY` (64 hex) or HKDF-SHA256(`BETTER_AUTH_SECRET`, info `paddock-secrets-v1`).
- Browser API (session; POST/DELETE only with `Origin === PUBLIC_URL`, any signed-in user, own data only):
  `GET/POST /api/git/accounts`, `DELETE /api/git/accounts/<id>`. The list never contains tokens. Limits: 20 accounts,
  token ≤ 4096 characters and single line, host a host name with optional `:port`, prefix `[A-Za-z0-9._/-]{0,200}`
  without empty/`.`/`..` segments; one account per (host, prefix).
- Identity: the browser writes `~/.codex/paddock/gitconfig` through the harness fs API (`[user] name = "…" email = "…"`,
  quotes and backslashes escaped, newlines refused) and reads it back to show the current values.
- Harness image: `/usr/local/bin/git-credential-paddock` (node, no dependencies, CommonJS) and `/etc/gitconfig` with
  `credential.helper`, `credential.useHttpPath = true` and `[include] path = /home/codex/.codex/paddock/gitconfig`.
- Server: `POST /api/harness/git-credential` (see "Harness API" below): https only, exact host, the longest prefix
  that covers the path in whole segments (`my-org` does not cover `my-org-evil/…`; `.git` is ignored); `{username,
  password}` or 204. One JSON log line per call: `{"event":"git-credential","harness","host","account"}`.

**2. Secret requests (Paddock tool `secrets`).**

- `web/tools/secrets`: `tool.json` (`"default": true`), `paddock-secret.mjs` (no dependencies), `SKILL.md`. The skill
  tells the agent never to ask for secrets in the chat and to run
  `node <bin> request NAME --file <path> [--reason "…"] [--timeout 900]`. The command checks that the path resolves
  inside `/workspace` (symlinks followed, folder must exist) before it creates the request, waits, then writes
  `NAME=value` (file created, the first `NAME`/`export NAME` line replaced and duplicates dropped, value bare / single-
  quoted / escaped double-quoted, atomic rename, mode 600) and prints only `saved NAME to <file> (N chars)`. Exit 3
  with `declined` / `expired`; Ctrl-C and its own timeout withdraw the request. `list` shows pending requests.
- Server: an in-memory store per harness (`web/lib/secret-requests.ts`, on `globalThis` so `server.ts` and Next's route
  handlers share it): id = 128 random bits, name `^[A-Z_][A-Z0-9_]{0,63}$`, file, reason ≤ 300, threadId (from
  `CODEX_THREAD_ID`), TTL 15 min, ≤ 5 pending per harness; the value (non-empty, single line, ≤ 8 KB) is handed out
  once and wiped; also wiped on decline, cancel and expiry; finished entries are forgotten 5 min later. Never logged.
- Harness endpoints: `POST /api/harness/secret-requests`, `GET /api/harness/secret-requests` (pending),
  `GET /api/harness/secret-requests/<id>` (the value once, then `consumed`), `DELETE …/<id>` (withdraw).
  Browser endpoints: `GET /api/secret-requests` (pending, no values), `POST /api/secret-requests/<id>`
  `{value}` or `{decline:true}` (Origin check).
- UI (`components/secret-requests.tsx`): polls every 4 s while the page is visible; a card in the visible pane whose
  thread asked, else in the active pane: chat title, NAME, file, reason, minutes left, password field with show/hide,
  Save / Decline, and a result line ("Saved. The agent writes it…", "Declined…", or the server's error).

**3. Default tools.** `"default": true` in `tool.json` installs a tool on connect unless the user removed it; removal
writes `~/.codex/paddock/tools/<id>/removed`, installing again deletes it. Existing tools have no flag and behave as
before. Settings → Tools shows "on by default".

**Harness API (`web/lib/harness-api.ts`).** `/api/harness/*` is handled in `server.ts` before Next (Next fills in
`X-Forwarded-For` itself). A request carrying `X-Forwarded-For`, `Forwarded` or `X-Real-IP` came through a proxy and is
answered 404; `edge/nginx.conf` also returns 404 for `location /api/harness/`. The caller is authenticated by
`Authorization: Bearer <token>`: sha256 of the token is compared in constant time with every `TOKENS_DIR/<id>.token`
(valid harness ids only, tokens ≥ 32 characters), the harness id is mapped to the web user through `harness_users`.
A harness whose owner never signed in to web has no accounts. 120 requests/min per harness for each of the two
endpoints. The existing browser route `/api/harness` (no trailing slash) is not affected.

**Provisioner.** web is attached to user networks with the alias `web` (`WEB_ALIAS`), so `http://web:3000` resolves
there as on `core`.

## Env vars

| where | var | default | meaning |
|---|---|---|---|
| web | `PADDOCK_SECRETS_KEY` | derived from `BETTER_AUTH_SECRET` | 64 hex characters (`openssl rand -hex 32`); key for stored git tokens. Changing it (or `BETTER_AUTH_SECRET` without it) makes stored tokens unreadable: they behave as absent and must be added again |
| web | `PADDOCK_HARNESS_API` | `1` | `0` answers 404 on all of `/api/harness/*` (git credentials and secret requests off) |
| web | `TOKENS_DIR`, `PUBLIC_URL` | as before | harness tokens; the Origin for browser mutations |
| harness | `PADDOCK_WEB_URL` | `http://web:3000` | where the helper and the `secrets` tool reach web (plain http, directly) |
| harness | `PADDOCK_WS_TOKEN_FILE` | `/run/secrets/ws-token` | the harness token they authenticate with |
| harness | `PADDOCK_GIT_CREDENTIALS` | `1` | `0` turns the credential helper off |
| harness | `PADDOCK_GIT_DEBUG` | — | `1` prints the helper's errors (never the token) to stderr |
| harness | `PADDOCK_WORKSPACE` | `/workspace` | root the `secrets` tool accepts files under (the server checks `/workspace`) |
| provisioner | `WEB_ALIAS` | `web` | web's DNS alias on user networks |

## End to end

Git: the agent runs `git push https://github.com/my-org/app.git` → git calls `git-credential-paddock get` with
`protocol=https host=github.com path=my-org/app.git` → the helper POSTs that to `http://web:3000/api/harness/git-credential`
with the harness token (node:http with its own agent, never `HTTPS_PROXY`; 10 s timeout) → web finds the harness by
token, the user by harness, the account by host and longest prefix, decrypts the token → the helper prints
`username=…`/`password=…` → git talks to github.com through egress as before. No match or any error: no output, git
fails as without a helper. `store`/`erase` do nothing.

Secret: the agent tells the user a form is waiting and runs `node …/paddock-secret.mjs request OPENAI_API_KEY --file
.env --reason "…"` → web stores a pending request → the browser's 4-second poll shows the card in that chat's pane →
the user types the key and saves → the command's 2-second poll collects it once → `.env` gets `OPENAI_API_KEY=…`
(mode 600) → the command prints `saved OPENAI_API_KEY to /workspace/app/.env (51 chars)`.

## Threat notes

- **The agent can read any token it can use.** `git credential fill` in the harness returns it, and it can be printed.
  The helper only keeps tokens out of files, the chat and the command log; it does not hide them from the agent. Use
  fine-grained tokens scoped to the needed repositories, with an expiry; prefer a separate machine/bot account.
- **Secrets land in workspace files**, readable by the agent; if the agent prints one, it goes into the transcript and to
  the model provider. The skill forbids that, but it is an instruction to a model, not a control. Keep those files in
  `.gitignore`.
- Isolation between users rests on the per-harness token and `harness_users`; there is no other secret between a
  harness and web. Anyone who can read `secrets/tokens/` can impersonate any harness (as before, for the WS bridge).
- `/api/harness/*` relies on a proxy in front of web setting `X-Forwarded-For` (edge nginx does; edge also blocks the
  prefix). If web's port is published directly, the token still protects the routes, but block the prefix there.
- `credential.useHttpPath = true` is system-wide in the harness image: other credential helpers the user configures
  then also see paths (they would store credentials per repository).
- Requests and values live in web's memory only: a web restart (self-deploy) drops pending requests; the waiting command
  then reports `expired`.
- Tokens at rest depend on the key in `secrets/web.env`; a stolen auth db alone does not reveal them.

## Verified here

- `cd web && npx tsc --noEmit -p . && node scripts/check-i18n.mjs && npx next build` passes (the build logs the same
  "Database schema mismatch" on an empty db as before). Every commit of the branch typechecks and passes the tests on
  its own.
- Unit and integration tests: `web` 82 (`npm test`, now `node --import tsx --test`), `provisioner` 29. New:
  `secret-box` (roundtrip, fresh IV, tampering at every part, wrong key/aad, key derivation), `git-accounts`
  (validation, segment-wise prefixes, longest prefix, https only, exact host, store with a temp sqlite, no token in
  list or in clear in the db, 20 limit, cross-user isolation, ciphertext moved between rows), `harness-auth` (bearer
  parsing, wrong/foreign/short tokens, bad file names, harness → user, rate limiter), `secret-requests` (one-time read,
  TTL, wipe, isolation, limits, validation), `secrets-cli` (quoting checked by reading values back with `sh`, upsert,
  workspace paths with symlinks and a `workspace-evil` sibling, mode 600), `git-identity` (read back by real
  `git config`), `tools` (default install, removal remembered), and `harness-api`: the real handler on a local port with
  a temp sqlite and tokens dir; the real helper as a child process (stdin parsing, output, no output on every failure,
  ignores `HTTP(S)_PROXY` with `NODE_USE_ENV_PROXY=1`, never calls web for non-https, drops answers with line breaks);
  **real `git credential fill`** through the helper; the real `paddock-secret.mjs` end to end (request → fulfil →
  file, declined, outside the workspace, bad name).
- Live smoke test of the production server (`NODE_ENV=production tsx server.ts`, temp db, two password users): login,
  Git accounts add/list/delete with and without Origin, a foreign user's delete → 404, harness credential for the owner
  and 204 for another harness, `X-Forwarded-For` → 404, `/api/harness` (browser) unaffected, secret request created by a
  harness token and seen/fulfilled/declined through the browser routes (the store is shared between `server.ts` and
  Next), a foreign user → 404, multi-line and empty values → 400, collected once, nothing secret in the server log.
  This found and fixed one bug: `instanceof` across the two module graphs (errors are now matched by name).

## Not verified

- A real `git push`/`clone` over https through egress with a real token, inside the harness image (the image was not
  built: no Docker daemon here). `git credential fill` with the helper was run on the host.
- The helper inside a provisioned harness on its own network (alias `web`), and `add-user.sh` harnesses on `core`.
- The UI in a real browser: the Git tab, the secret card placement, polling, password managers. Only typechecked,
  i18n-checked and built; `tests/*.mjs` (headless, live instance) were not run.
- That Codex exports `CODEX_THREAD_ID` to shell commands (the existing `agents` tool relies on it; without it the card
  goes to the active pane).
- `edge/nginx.conf` was not loaded into a real nginx.

## Mutation testing

Method as in [g017-mutation.md](g017-mutation.md): one bug at a time in the new security-relevant code, the full `web`
suite run (`node --import tsx --test test/*.test.mjs`), the file restored. The runner lived outside the repo.

**Score: 40/40 killed** (38 in the first run; the 2 survivors led to new tests, then killed).

| # | file | mutation | result | first test that failed |
|---|---|---|---|---|
| M1 | `web/lib/secret-box.ts` | additional data (row binding) not used when sealing | killed | store: credentialFor matches only the user's own accounts |
| M2 | `web/lib/secret-box.ts` | HKDF info string changed | killed | secretsKeyFrom: HKDF-SHA256 of BETTER_AUTH_SECRET with info paddock-secrets-v1 |
| M3 | `web/lib/secret-box.ts` | PADDOCK_SECRETS_KEY accepts 62-64 hex chars | killed | secretsKeyFrom: PADDOCK_SECRETS_KEY wins, must be 64 hex |
| M4 | `web/lib/secret-box.ts` | key derived as raw secret bytes instead of HKDF | killed | secretsKeyFrom: HKDF-SHA256 of BETTER_AUTH_SECRET with info paddock-secrets-v1 |
| M5 | `web/lib/git-accounts.ts` | credentials also for non-https protocols | killed | pickAccount: https only, exact host, longest prefix wins |
| M6 | `web/lib/git-accounts.ts` | shortest prefix wins instead of longest | killed | pickAccount: https only, exact host, longest prefix wins |
| M7 | `web/lib/git-accounts.ts` | prefix compared as a string prefix, not whole segments | killed | prefixCovers: whole leading segments, .git ignored |
| M8 | `web/lib/git-accounts.ts` | host matched as a suffix | killed | pickAccount: https only, exact host, longest prefix wins |
| M9 | `web/lib/git-accounts.ts` | credentialFor considers every user's accounts | killed | store: credentialFor matches only the user's own accounts |
| M10 | `web/lib/git-accounts.ts` | tokens with line breaks accepted | killed | validToken: 1..4096 characters, single line |
| M11 | `web/lib/git-accounts.ts` | no limit of 20 accounts | killed | store: limits and duplicates |
| M12 | `web/lib/git-accounts.ts` | list returns the sealed token too | killed | store: add, list without tokens, last4, delete |
| M13 | `web/lib/harness-auth.ts` | only the first 32 characters of a token compared | killed | harness authentication: no, wrong, short or unknown tokens get 401 |
| M14 | `web/lib/harness-auth.ts` | token file names not validated as harness ids | killed | harnessIdForToken: the token file decides which harness is calling |
| M15 | `web/lib/harness-auth.ts` | minimum token length dropped (both checks) | killed | harnessIdForToken: the token file decides which harness is calling |
| M16 | `web/lib/harness-auth.ts` | bearer regex unanchored | killed | bearerOf |
| M17 | `web/lib/harness-api.ts` | requests through a proxy not refused | killed | a request that came through a proxy (X-Forwarded-For etc.) is answered 404, even with a valid token |
| M18 | `web/lib/harness-api.ts` | X-Real-IP not treated as proxied | killed | a request that came through a proxy (X-Forwarded-For etc.) is answered 404, even with a valid token |
| M19 | `web/lib/harness-api.ts` | git credential rate limit not applied | killed | rate limit per harness |
| M20 | `web/lib/harness-api.ts` | repository path written to the log | killed | git-credential log: harness, host, account id; never the token or the path |
| M21 | `web/lib/harness-api.ts` | PADDOCK_HARNESS_API=0 ignored | killed | PADDOCK_HARNESS_API=0 (enabled: false) answers 404 |
| M22 | `web/lib/secret-requests.ts` | value not wiped after the first read | killed | secret requests: harness creates, user fulfils, harness collects once; isolation and validation |
| M23 | `web/lib/secret-requests.ts` | owner not checked | killed | secret requests: harness creates, user fulfils, harness collects once; isolation and validation |
| M24 | `web/lib/secret-requests.ts` | pending requests expire one tick late | killed | TTL: pending and uncollected requests expire, values are wiped, finished ones are forgotten later |
| M25 | `web/lib/secret-requests.ts` | uncollected values kept past the deadline | killed | TTL: pending and uncollected requests expire, values are wiped, finished ones are forgotten later |
| M26 | `web/lib/secret-requests.ts` | limit of pending requests off by one | killed | at most 5 pending per owner; answered ones free a slot |
| M27 | `web/lib/secret-requests.ts` | multi-line values accepted | killed | validFile and validateValue |
| M28 | `web/lib/secret-requests.ts` | .. segments allowed in the file path | killed | create: name, file and reason are validated |
| M29 | `web/lib/secret-requests.ts` | value size limit counted in characters, not bytes | killed | validFile and validateValue |
| M30 | `web/tools/secrets/paddock-secret.mjs` | folder symlinks not resolved | killed | resolveInWorkspace: inside the workspace after symlinks, folder must exist |
| M31 | `web/tools/secrets/paddock-secret.mjs` | workspace check without the path separator | **survived → killed** after a new test | resolveInWorkspace: inside the workspace after symlinks, folder must exist |
| M32 | `web/tools/secrets/paddock-secret.mjs` | name regex in .env upsert not anchored | killed | upsertEnvLine: append, replace in place, drop duplicates, keep the rest |
| M33 | `web/tools/secrets/paddock-secret.mjs` | single quotes used even when the value contains one | killed | quoteValue: bare when plain, single quotes, else escaped double quotes; line breaks refused |
| M34 | `web/tools/secrets/paddock-secret.mjs` | output file mode 644 instead of 600 | killed | secrets command: request → user saves → NAME=value in the file (600), output without the value |
| M35 | `codex/git-credential-paddock` | answer with a line break passed to git | killed | helper: an answer with a line break is dropped; the token never reaches stderr |
| M36 | `codex/git-credential-paddock` | helper asks web for http remotes too | **survived → killed** after a new test | helper: never contacts web for anything but https |
| M37 | `codex/git-credential-paddock` | helper uses the default (proxy-aware) agent | killed | helper: ignores HTTP(S)_PROXY and talks to web directly |
| M38 | `web/lib/git-identity.ts` | double quotes not escaped in the identity file | killed | identityConfig escapes quotes and backslashes; real git reads back the same values |
| M39 | `web/lib/tools.ts` | removal of a default tool not remembered | killed | a default tool the user removed stays removed; installing it again clears that |
| M40 | `web/lib/tools.ts` | every tool installed on connect | killed | a default tool is installed on connect, others are not |

Not mutated: the browser routes' session and Origin checks (`requireUser` in `web/lib/harness-services.ts`) need a live
better-auth; they were exercised in the smoke test above (403 without Origin, 401 without a session, 404 for another
user's account or request). Each of the two token-length checks in `harnessIdForToken` alone is redundant with the
other (defence in depth); M15 removes both.

## Commits and upstream PRs

| commit | subject | upstream as |
|---|---|---|
| 12f31aa | run unit tests through the tsx loader | with PR A (needed by its tests) |
| bc15de5 | per-user git accounts, AES-256-GCM | PR A: git accounts |
| 2a538cf | in-memory store for secret requests | PR B: secret requests |
| 6445c95 | `/api/harness/*`: git credentials and secret requests | PR A + B (shared harness API; can be split by endpoint) |
| 660065f | edge: refuse `/api/harness/` | PR A |
| fbe00a8 | harness: git credential helper and `/etc/gitconfig` | PR A |
| b5fd306 | provisioner: alias `web` on user networks | with the provisioner PR (PR 3 of g017-changes) or alone |
| 158e57a | Settings → Git | PR A |
| c8fe0f4 | `"default": true` tools | PR C (independent, small) |
| 9d88575 | `secrets` tool, masked form, end-to-end test | PR B (needs PR C for "on by default", A's helper for its test) |
| e71bb1b | tests from mutation testing | squash into A/B |

No commit contains company names, domains or secrets. This document (`docs/razum/`) is fork-only.

## Open questions

- Key rotation: there is no re-encryption command; a new `PADDOCK_SECRETS_KEY` means re-adding tokens. Worth a
  `scripts/rotate-secrets-key.ts`?
- Should an admin be able to see (not read) every user's accounts, or revoke them on offboarding? Today deleting the
  web user leaves `git_accounts` rows (unreadable to anyone but that user id).
- SSH remotes are out of scope (https only). Rewrite `git@github.com:` to https with `url.<base>.insteadOf` in the
  image's gitconfig?
- Should secret requests survive a web restart (sqlite with the same sealing), or is "expired, ask again" enough?
