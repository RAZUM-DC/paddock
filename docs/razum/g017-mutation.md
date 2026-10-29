---
node_type: report
title: G-017 pilot — mutation testing of the new pure logic
description: "28 deliberate bugs put one at a time into the logic the G-017 commits added; which test caught each one; 27 killed, 1 equivalent."
service: _platform
status: active
updated: 2026-10-29
links:
  documents: [../../web/lib/identity.ts, ../../provisioner/lib.mjs, ../../provisioner/server.mjs, ../../web/test, ../../provisioner/test]
  relates_to: [g017-changes.md]
---

# G-017 mutation testing

Method: one small bug at a time was written into the source, the suite of that package was run
(`node --test --test-timeout=20000 test/*.test.mjs` in `web/` or `provisioner/`), and the file was restored before
the next mutation. A mutation is **killed** when at least one test fails. The scripted runner lives outside the
repo; the working tree was checked clean after the run.

**Score: 27 killed / 28; the one survivor is equivalent (cannot change behaviour). 27/27 non-equivalent killed.**

| # | file | mutation | result | caught by |
|---|---|---|---|---|
| M1 | web/lib/identity.ts | harness id truncated to 11 hex | killed | deriveHarnessId: u- + first 12 hex of sha256(salt:issuer:sub) |
| M2 | web/lib/identity.ts | salt dropped from the hash input | killed | deriveHarnessId: salt, issuer and sub all matter |
| M3 | web/lib/identity.ts | issuer trailing slash not normalised | killed | deriveHarnessId: a trailing slash on the issuer does not move the user |
| M4 | web/lib/identity.ts | being in an admin group alone admits the user | killed | decideOidcLogin: group policy and admin groups at every login |
| M5 | web/lib/identity.ts | empty allow-list rejects everyone | killed | checkGroups: empty allow-list admits everyone (+2) |
| M6 | web/lib/identity.ts | group match made case-insensitive | killed | checkGroups: membership in any allowed group admits, none rejects |
| M7 | web/lib/identity.ts | id regex loses its `^` anchor | killed | isValidHarnessId |
| M8 | web/lib/identity.ts | userinfo `sub` mismatch check removed | killed | decideOidcLogin: userinfo for another subject is refused |
| M9 | web/lib/identity.ts | stored harness id ignored | killed | chooseHarnessId: a stored id always wins |
| M10 | web/lib/identity.ts | password users moved to derived ids | killed | chooseHarnessId: OIDC-only user gets a derived id, password user keeps the legacy name |
| M11 | web/lib/identity.ts | empty `ADMIN_USERS` entry matches an empty id | killed | isAdmin: ADMIN_USERS by harness id or email, or OIDC admin group |
| M12 | web/lib/identity.ts | `email_verified: "false"` treated as verified | killed | decideOidcLogin: email_verified must be true, name falls back |
| M13 | web/lib/identity.ts | `u-<12 hex>` not reserved for SSO users | killed | legacyHarnessId: email local part, a-z0-9- only |
| M14 | provisioner/lib.mjs | id regex allows dots (`..`) | killed | isValidId; idFromPath |
| M15 | provisioner/lib.mjs | user network created with `Internal: false` | killed | networkCreateBody; ensure creates network… (fake Docker) |
| M16 | provisioner/lib.mjs | `CapDrop: ["ALL"]` removed | killed | containerCreateBody: same command and hardening as users/_template.yml |
| M17 | provisioner/lib.mjs | `no-new-privileges` removed | killed | containerCreateBody: same command and hardening as users/_template.yml |
| M18 | provisioner/lib.mjs | per-user env file can override `HTTPS_PROXY` | killed | containerCreateBody: user env passes, cannot override the proxy |
| M19 | provisioner/lib.mjs | `/harness/<id>` parser accepts extra path segments | **survived (equivalent)** | — |
| M20 | provisioner/lib.mjs | seed writes `experimental_bearer_token` instead of `env_key` | killed | configSeed: provider via env_key, never the key itself |
| M21 | provisioner/lib.mjs | a restarting container counts as ready | killed | readiness: running with a token, nothing else |
| M22 | provisioner/lib.mjs | harness on the default bridge instead of its own network | killed | containerCreateBody; ensure creates network… (fake Docker) |
| M23 | provisioner/lib.mjs | reserved provider ids (`openai`…) accepted | killed | configFromEnv: LLM provider |
| M24 | provisioner/lib.mjs | TOML strings do not escape `"` | killed | tomlString escapes |
| M25 | provisioner/server.mjs | any non-empty bearer token accepted | killed | health needs no auth, everything else does |
| M26 | provisioner/server.mjs | token file regenerated on every ensure | killed* | a removed container is recreated on the next ensure, with the same token |
| M27 | provisioner/server.mjs | concurrent ensures not deduplicated | killed | concurrent ensures for one id share a single run |
| M28 | provisioner/lib.mjs | reconcile acts on networks it did not create | killed | idOfNetwork: only networks this provisioner made |

\* M26 survived the first run. The existing idempotency test re-ran ensure while the container existed, so the
removed "token exists" guard went unnoticed: the `wx` write flag then threw, but only inside the background ensure,
after the container check had already passed. A new test (commit 3a041dc) removes the container and ensures again,
which is the documented way to apply a changed per-user env file. It kills M26.

**M19 is equivalent.** With `^/harness/(.+)$`, a path like `/harness/alice/x` captures `alice/x`, and `isValidId` then
rejects it because `/` is not in the id alphabet. So the answer (400) is the same as with the original
`([^/?#]+)`. The pattern is kept as defence in depth.

Not covered by mutation testing (no pure seam, verified by integration runs instead, see g017-changes.md): the
better-auth wiring in `web/lib/oidc.ts` (mock-IdP end-to-end run), `web/lib/provision.ts` (fake provisioner run),
and `codex/entrypoint.sh` (shell run).
