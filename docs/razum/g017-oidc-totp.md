---
node_type: report
title: G-017 — Paddock's own TOTP after an OIDC login
description: "Branch razum/g017-oidc-totp: OIDC_REQUIRE_TOTP makes every SSO session pending until Paddock's TOTP (better-auth twoFactor format) is entered; the gate, enrolment, lockout, rotation, tests, mutation record and answers on lk's OIDC setup."
service: _platform
status: active
updated: 2026-10-30
links:
  documents: [../../web/lib/second-factor.ts, ../../web/lib/second-factor-core.ts, ../../web/app/2fa/page.tsx, ../../web/components/second-factor.tsx, ../../web/test/oidc-totp.test.mjs]
  relates_to: [g017-changes.md, g017-git-secrets.md, ../reference/architecture.md]
---

# G-017: Paddock's own TOTP after an OIDC login

Branch `razum/g017-oidc-totp`, on top of `razum/g017-git-secrets` (3a1d980). Paddock is reachable from the internet
and its agents run code, so a single sign-on login alone must not open a workspace: **after an OIDC login Paddock
asks for its own TOTP.** better-auth's `twoFactor` plugin only guards email/password sign-in; its OAuth callback
creates a complete session. This branch closes that gap.

## Flow

1. The person clicks "Sign in with SSO" → better-auth's `/sign-in/social` → IdP (PKCE S256, nonce) → `/api/auth/callback/oidc`
   (id_token RS256 verified against the JWKS, `iss` checked, group policy from the pilot) → session cookie.
2. The session hook marks this session **pending** (table `session_second_factor`).
3. `/` sees no usable session (get-session refuses pending ones) but a pending one, and redirects to
   `/2fa?next=/?chat=…`.
4. `/2fa`:
   - **TOTP already set up** (better-auth `twoFactor` row, verified): enter the 6-digit code, or a backup code.
   - **First time**: `POST /api/auth/second-factor/enrol` stores a `twoFactor` row in the format of better-auth's plugin
     (`secret` and `backupCodes` encrypted with `symmetricEncrypt` and the auth secret, `verified = false`) and returns
     the otpauth URI → QR code and manual key → the person enters a code → the row becomes `verified`,
     `user.twoFactorEnabled = true`, and the 10 backup codes are shown once.
     **Every enrol call makes a new secret and new backup codes**, replacing an unconfirmed row (one row per user, in
     a transaction). A confirmed row, or a legacy one with `verified` NULL, is never touched and its secret never
     returned (409). Reloading `/2fa` shows a new QR code; an older one stops working.
5. `POST /api/auth/second-factor/verify` succeeds → a **new session** (new token, the old one deleted: no session
   fixation) is marked **verified**, the cookie replaced, the browser goes to `next`.

**Atomicity (review F1).**
- **Before anything is awaited**, one synchronous better-sqlite3 transaction (`beginAttempt`) refuses a locked user
  or a session that has used its attempts, and otherwise counts the attempt for both the session and the user. N
  concurrent guesses therefore get exactly the cap evaluated; the rest are refused unevaluated.
- After a correct code, one transaction (`consumeSuccess`) does everything or nothing:
  - the session must still exist (not expired) and still be pending;
  - the TOTP step must be newer than every step used before (conditional upsert);
  - a backup code must still be in the stored list (compare-and-swap on the encrypted list);
  - a first enrolment must still have the secret the code was checked against;
  - then the pending session row is deleted and the counters are reset.
- A session whose last attempt fails is deleted at once (synchronously), so a slower correct code in the same burst
  finds it gone. Two concurrent successes (same code, two sessions) give exactly one winner.

The password path is unchanged: `/sign-in/email` (and better-auth's own `/two-factor/verify-totp` step when the user
has TOTP) creates an **exempt** session.

## Env

| var | default | meaning |
|---|---|---|
| `OIDC_REQUIRE_TOTP` | `1` whenever `OIDC_ISSUER` + `OIDC_CLIENT_ID` are set | `0` = old behaviour (the plugin and the session hooks are not installed at all) |

No other new variables. TOTP: SHA-1, 6 digits, 30 s, ±1 step (like better-auth).

**Lockout:**
- **Per session:** a pending session gets 5 attempts; when the 5th fails, the session is revoked (sign in through SSO
  again).
- **Per user:** 10 attempts without a success within 15 min, across all sessions, lock the user (429, even for the
  right code).
- **Growing locks:** each further lock lasts twice as long as the previous one: 15, 30, 60, 120 min, … capped at
  24 h. The lock history is kept for 7 days.
- **Hard lock:** after the 5th lock the user stays locked (`429 LOCKED_HARD`) until an admin clears it.
- **Log:** every lock writes one JSON line `{"event":"second-factor-lock","user":…,"locks":n,"hard":…,"until":…}` (no
  codes, no secrets).
- **Reset:** a success resets the counters and the lock history.
- **Backup codes during a lock:** while a user is locked (soft or hard), TOTP codes are refused but **backup codes
  still work**, on their own counter: 5 attempts per hour per user, and the session cap still applies. A success
  clears the lock, so the owner can recover without an admin. An attacker guessing backup codes (10 random
  alphanumeric codes of 10 characters) gets 5 tries per hour against about 8·10¹⁷ possible codes per code.
- **Rate limit:** better-auth adds 20 requests/min per client address on `/second-factor/*`.

**Residual guessing rate.** Each attempt hits one of 3 valid codes (±1 step) out of 10⁶, so p = 3·10⁻⁶.
- Per 15-minute window: at most 10 attempts per user, i.e. 3·10⁻⁵.
- Before the hard lock: 5 locks × 10 = 50 attempts, spread over roughly 15+30+60+120 min ≈ 4 h. That gives
  ≈ 1.5·10⁻⁴ in total, after which an admin must act.

**Admin unlock / reset** (on the server):
- Unlock a hard or soft lock: `sqlite3 data/auth.db "DELETE FROM second_factor_failures WHERE key = 'u:<user id>';"`
- Lost authenticator: see Decisions.

## The gate

A better-auth plugin (`web/lib/second-factor.ts`) has a `before` hook on **every** better-auth endpoint. Those hooks
run for HTTP requests and for server-side `auth.api.*` calls alike. If the request's (signed) session cookie belongs
to a pending session, everything except the following answers 403 `SECOND_FACTOR_REQUIRED`:

| allowed while pending | why |
|---|---|
| `/sign-out` | leave |
| `/second-factor/status`, `/second-factor/enrol`, `/second-factor/verify` | the 2FA page |
| `/sign-in/social`, `/callback/:id`, `/sign-in/email` | a fresh sign-in replaces the pending cookie |
| `/error`, `/ok` | better-auth's static answers |

Everything else is refused, including `/get-session`, `/list-sessions`, `/revoke-sessions`, `/update-user`,
`/change-password`, `/delete-user`, `/link-social`, `/list-accounts`, and all of `/two-factor/*`.

Because `get-session` is refused, **every Paddock session check** sees "no session" for a pending session. All of them
now go through one helper, `sessionFromHeaders` (`auth.api.getSession`). That covers `app/page.tsx`, every API route
(`requireUser` for `/api/git/*` and `/api/secret-requests`, `requireAdmin` for `/api/proxy` and `/api/admin/*`, the plain checks of
`/api/harness`, `/api/tools`, `/api/turns`, `/api/snapshots`, `/api/net`, `/api/neuraldeep/models`) and **the WS bridge
in `server.ts`**. A static test (`test/session-gate.test.mjs`) keeps it so: `getSession(` appears only in
`lib/auth.ts`, nothing outside the auth libraries touches the session table, better-auth's internal adapter or
`auth.handler`, and every API route except `auth`, `login-options` and `version` calls one of the checks.
`/api/harness/*` (harness tokens) and static assets are not session-based and are unaffected.

**Which sessions are pending.** The state is server-side, keyed by session id, never in a cookie:

- the OIDC callback → `pending`;
- `/sign-in/email`, `/two-factor/verify-totp`, `/two-factor/verify-backup-code` → `exempt`;
- `/second-factor/verify` → a new session marked `verified`;
- a session rotated by another endpoint (e.g. change-password) keeps the state of the one the request came with, for
  the same user, verified or exempt only. better-auth's database hooks can't see its middleware session, so the gate
  records the request's state keyed by the request's `Headers` object, which the hook does see;
- **no row** (e.g. sessions from before this branch, or an unknown path) → pending **if the user has an OIDC account**,
  fine otherwise. Old OIDC sessions are not grandfathered. That also covers old *password* sessions of a user who has an
  OIDC account linked: they too must enter the TOTP once.

Rows of signed-out or expired sessions are removed by better-auth's session delete hook and by a cleanup at start and
every 10 minutes.

## Decisions

- **Disabling TOTP**: refused (`403 TOTP_REQUIRED_FOR_SSO`) for any user with an OIDC account while
  `OIDC_REQUIRE_TOTP` is on, whatever the session. Otherwise the next SSO login would simply enrol again, and a stolen
  verified session could remove the second factor. "Settings → Paddock login" then shows an error on "disable".
  **Unlinking accounts** is refused for every session of a user who has an SSO account (`403 SSO_ACCOUNT_REQUIRED`,
  review F4). better-auth 1.7's `/unlink-account` takes only `{ accountId }`, so the SSO account cannot be singled
  out from the request body: a first fix that looked at `providerId` was bypassable. Without this rule, a linked user
  could unlink and then disable. The rule chosen is "has an OIDC account", not "has a TOTP Paddock created":
  better-auth's `twoFactor` row does not record who created it, and for SSO users TOTP is the policy whoever enrolled
  it.
- **Lost phone / reset** (admin, on the server; the user then enrols again at the next SSO login):
  `sqlite3 data/auth.db "DELETE FROM twoFactor WHERE userId = '<id>'; UPDATE user SET twoFactorEnabled = 0 WHERE id = '<id>';"`
  Backup codes cover the usual case without an admin.
- **Password login stays as it was** (the owner's request). A linked user who has a password can still sign in with
  it, and with TOTP once they have enrolled through SSO. With `LOCAL_LOGIN=0` password sign-in is off on the server.

## Threat notes

- An attacker with someone's SSO credentials (phished, reused) now also needs their authenticator. On the **first**
  SSO login of a person without TOTP, whoever completes the SSO login enrols the authenticator. Enrol everyone soon, or
  pre-enrol on a known device.
  - An attacker can't take over an *existing* enrolment: `enrol` answers 409 once a verified (or legacy) row exists,
    and never returns that secret.
  - An attacker can't learn a victim's *unconfirmed* secret either: every enrol call returns a new one and invalidates
    the previous one (review F2). The worst an attacker can do during someone's first enrolment is make the victim's QR
    code stop working; the victim notices and reloads.
- Codes: constant-time comparison of all window steps and all backup codes. A used step can't be replayed through
  `/second-factor/verify`. better-auth's own password-flow verify has no replay protection, and it keeps its own
  failure counter. A code used in one flow could be reused within 90 s in the other only by someone who also has the
  password.
- Session fixation: the session that saw the second factor is new; the pending token is deleted.
- The gate needs a valid signed cookie and a live session; a bare or forged token is no session at all.
- Pending sessions still count as signed in for better-auth's own sign-in rate limits and stay in the `session` table
  until they expire or the person signs out.
- `/2fa?next=` accepts only same-site paths (no `//`, `/\`, `/api/`, control characters); the decision is
  `secondFactorPageAction`, unit-tested, and the page uses exactly it.
- CSRF: in production better-auth refuses POSTs to `/second-factor/*` without the PUBLIC_URL Origin (tested with
  `NODE_ENV=production`; in `test`/`development` better-auth relaxes this).
- All TOTP and backup-code comparisons stay constant-time (`timingSafeEqual`). That cannot be shown by a functional
  test (mutation M9 survives by nature). Session expiry is checked explicitly in the plugin, not left to the adapter.

## Verified here

- `cd web && npx tsc --noEmit -p . && node scripts/check-i18n.mjs && npx next build`: pass. `npm test` in `web`:
  135/135; `provisioner`: 32/32. Every commit of the branch passes on its own.
- **After the re-review**:
  - unlinking with `{ accountId }` only → 403 and the account remains;
  - `twoFactorEnabled` is set in the success transaction (a unit test shows the rollback when it can't be set);
  - user A's verified cookie plus an id_token sign-in of user B → B's session is pending
    (`/sign-in/social` sessions are now classified pending, and `inheritedState` is unit-tested);
  - backup codes during locks (above).

  `npm test`: 139/139.
- **After the review**, all in `test/oidc-totp.test.mjs` unless noted:
  - A walk over **every** better-auth endpoint gives 403 `SECOND_FACTOR_REQUIRED` for a pending session, except the
    explicit allow-list. The requests carry a body/query that passes each endpoint's input validation, so they reach
    the hooks. Server-only endpoints are called through `auth.api` and refused too. Explicitly checked:
    `/get-access-token`, `/update-session`, `/account-info`, `/unlink-account`, `/get-session`, `/list-sessions`,
    `/two-factor/*`, `/change-password`, `/link-social`.
  - A walk over **every** Paddock API route handler (all `app/api/**/route.ts`, every exported method, 18+ handlers)
    gives 401/403 for a pending session, the same answer as with no cookie.
  - Concurrency:
    - 40 parallel wrong codes on one session: exactly 4 `INVALID_CODE` plus the revoking 5th, the user counter is 5,
      and the session is deleted;
    - after 5 wrong codes, a burst including the right code is all refused and leaves no usable session;
    - a burst of 30 has at most one winner and at most 5 evaluated;
    - the same valid code on two sessions at once gives exactly one 200;
    - 5 concurrent first enrols give one `twoFactor` row and 5 different secrets; only the stored one works, stale
      ones never do, and a confirmed row is never revealed again.
  - Rows and states:
    - a legacy row with `verified` NULL counts as set up (enrol 409, nothing revealed; verify without backup codes);
    - unlinking the SSO account → 403;
    - an expired pending session → `NO_SESSION` on status, enrol and verify;
    - enrol/verify from a verified or password session → `NOT_PENDING`, nothing stored.
  - Counters and locks:
    - a success resets the user counter;
    - locks grow 15 → 30 min and are logged (keys checked, no secret in the log);
    - a hard lock refuses even the right code (`LOCKED_HARD`) until the row is deleted;
    - the 5th failure itself deletes the session; backup codes work during soft and hard locks on their own limit
      (5/hour) and clear the lock, while TOTP stays locked;
    - a session whose attempts are used up is revoked by its next request;
    - change-password keeps a verified session verified.
  - `test/oidc-totp-prod.test.mjs` (`NODE_ENV=production`): a foreign, missing or look-alike Origin on enrol/verify →
    403, and nothing is stored.
  - Unit (`test/second-factor.test.mjs`): `countAttempt` (growing and hard locks), `beginAttempt`, `consumeSuccess`
    (one winner, rollback on every failure branch), `revokeSession`, `storeEnrolment`, `secondFactorPageAction` and
    that the page uses it, and the randomness source (`node:crypto` `randomInt`, no `Math.random`).
  - The reviewer's probe, rerun on the fixed code:
    - P1: `{INVALID_CODE: 4, SESSION_REVOKED: 2, NO_SESSION: 34}` (was 40 evaluated);
    - P1b: no success after the revocation;
    - P1c: no winner from a revoked session;
    - P2: different secrets;
    - P3 in production: `INVALID_ORIGIN` / `MISSING_OR_NULL_ORIGIN`;
    - P5: one 200;
    - P6: 5 counted (was 400);
    - P7: unlink 403, disable 403.

    P2's "attacker verify 200" comes from the probe handing the victim the DB secret (the attacker's), which a real
    victim cannot know.
- **Unit** (`test/second-factor.test.mjs`): flag parsing, classification of new sessions, the pending allow-list, state
  rules incl. "no row", lockout windows, HOTP against RFC 4226/6238 vectors **and** against better-auth's
  `createOTP`, window ±1, replay, base32 and the otpauth URI against better-auth's, backup codes, `safeNext`, cleanup.
- **Static** (`test/session-gate.test.mjs`) as above.
- **Integration through the real handlers** (`test/oidc-totp.test.mjs`, temp sqlite, a mock OpenID provider in
  `test/oidc-mock.mjs` with discovery, JWKS, RS256 id_tokens, PKCE S256, nonce and the `iss` parameter):
  - A pending session is refused by `sessionFromHeaders` / `auth.api.getSession` (the WS bridge's check), by 11
    better-auth account endpoints (403) and by 10 Paddock API routes of every kind (401).
  - Enrolment is stored like better-auth: its `createOTP` gives the same code and URI. Then a new verified session:
    token rotated, old session and state gone, `twoFactorEnabled`, routes and get-session work.
  - Replay of the used code on the next login is refused. A backup code works exactly once. Enrolling again → 409.
    `/two-factor/disable` → 403.
  - Old and future codes outside the window are refused, as are codes of another secret and wrong formats.
  - Lockout: 5 wrong codes revoke the session, 10 lock the user even for the right code, and the lock expires.
  - Sign-out removes the session and its state.
  - A session without a state row is pending for an OIDC user; a password-only user is unaffected.
  - **The linked-user case of the rollout**: a password user `alice@hub.local` gets harness `alice`. The email is
    changed in the db to the directory address. An SSO login without `email_verified` is not linked
    (`account_not_linked`); with it, it links to the same user, and the harness stays `alice`. The user enrols, then
    signs in by **password + better-auth's TOTP** with the secret Paddock stored, and that session is exempt and valid.
  - A forged unsigned cookie, and client-side "verified" cookies, change nothing.
  - `test/oidc-totp-off.test.mjs`: with `OIDC_REQUIRE_TOTP=0` the OIDC session works at once, the endpoints are 404,
    and no state rows exist.
- **Live end to end** (scratch script, not committed): the real `server.ts` (Next production build + WS bridge) with
  the mock IdP, over HTTP. 25/25 checks:
  - redirect URI `${PUBLIC_URL}/api/auth/callback/oidc` with `iss`;
  - `/?chat=abc` → `307 /2fa?next=%2F%3Fchat%3Dabc`, and `/2fa` renders;
  - 7 API routes → 401, get-session/list-sessions → 403, **WS upgrade → 401**;
  - enrol → verify → token rotated → `/` 200, `/2fa` → `next`, `/api/git/accounts` 200;
  - **WS upgrade passes the session check** (403 only for the missing harness token);
  - disable → 403, sign-out → 401 afterwards.
- **Proxy probe** (scratch): see (b) below.

## Not verified

- The real IdP (idp.example / django-oauth-toolkit): its discovery document, the `iss` value it puts into the
  authorization response (must equal the discovery `issuer` byte for byte), the `groups` claim, `email_verified`.
- The `/2fa` page in a real browser and real authenticator apps. The QR and URI format match better-auth's, which
  Authy / Google Authenticator / 1Password read.
- `tests/*.mjs` (headless suite against a live instance) were not run.

## Answers to the rollout questions

**(a) Token endpoint auth / `lib/oidc.ts`.** Nothing needs changing. With `OIDC_CLIENT_SECRET` set and no
`tokenEndpointAuth`, better-auth 1.7.14 uses **`client_secret_post`**
(`@better-auth/core/oauth2/token-endpoint-auth.mjs`: `getDefaultTokenEndpointAuth`). DOT accepts it, and it does not
depend on `token_endpoint_auth_methods_supported` in discovery. The mock IdP checks the secret the same way and
accepts both methods.
- PKCE S256 and the nonce are sent; the id_token is verified against `jwks_uri` with the discovered `issuer`.
- The `iss` authorization-response parameter is compared **exactly** with the discovered `issuer`
  (`oauth2/callback.mjs`, `ISSUER_MISMATCH`). If the IdP's discovery says `https://idp.example/o` and the response carries
  `https://idp.example/o/`, login fails with `issuer_mismatch`. Check once:
  `curl -s https://idp.example/o/.well-known/openid-configuration | jq .issuer` against the `iss` in a real
  callback URL.
- `OIDC_ISSUER=https://idp.example/o` gives discovery at `https://idp.example/o/.well-known/openid-configuration`.

**(b) Egress.** Confirmed with a probe: a logging proxy, `NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY`/`HTTP_PROXY` set,
`NO_PROXY` empty, Node 22.23. These went to the proxy as `CONNECT host:443`:
- discovery — global `fetch`;
- token exchange — `@better-fetch/fetch` 1.3.3;
- the userinfo call in `lib/oidc.ts` — global `fetch`;
- JWKS — `jose` 6.2.13 `createRemoteJWKSet`;
- `https.get` (default agent).

A WebSocket opened with its own `new http.Agent()`, as `server.ts` does for harnesses (`agent: direct`), connected
**directly**. Other internal calls also use own agents and/or are in `NO_PROXY` (`localhost,127.0.0.1,web,egress`,
plus `egress-api,provisioner` with the override): the provisioner (`lib/provision.ts`) and the gost API. Without
`NODE_USE_ENV_PROXY=1`, Node 22's `fetch` ignores `HTTPS_PROXY` and web would try lk directly. Keep it set in
`secrets/web.env` (pilot doc).

**(c) Email and linking.**
- **Email claim.** The email is `email` from the id_token claims merged with userinfo (userinfo wins), lower-cased
  (`lib/identity.ts` `decideOidcLogin`).
- **Conditions for linking to an existing password user** (better-auth `handleOAuthUserInfo`), all required:
  - `OIDC_LINK_BY_EMAIL=1`;
  - **`email_verified` from lk must be `true`** (boolean or the string `"true"`). The provider is not in better-auth's
    trusted list; without it the result is `account_not_linked`. Tested both ways.
  - the local user's `emailVerified` must be true (`scripts/create-user.ts` sets it);
  - the db email equals the lower-cased SSO email.
- **Harness.** `harness_users` keeps `alice` after the email change and the link (tested): the user id doesn't change,
  and a stored harness id always wins.
- **Precondition.** The `harness_users` row must exist **before** the email is changed, i.e. Alice has loaded Paddock
  at least once with the pilot (or later) build. Without the row, the first lookup after the change would derive the
  id from the new email. `alice.smith@…` is not a valid legacy name, so he would get "no harness" (403). Check
  `SELECT * FROM harness_users WHERE user_id = '<id>'` before the change. If it is missing, insert
  `('<id>', 'alice', <now ms>)`.
- **Steps.**
  1. Change the email in lower case: `UPDATE user SET email = lower('<AD email>') WHERE id = '<id>'`.
  2. Check `emailVerified = 1`.
  3. Log in through SSO and enrol the TOTP.

  His password keeps working, now with TOTP.

## Mutation testing

Method as in [g017-mutation.md](g017-mutation.md): one deliberate bug at a time in the security-relevant lines; the whole
`web` suite run (`node --import tsx --test test/*.test.mjs`, which includes the mock-IdP integration tests); the file
restored. Both sets were run on the final code (10d14a4); the runners lived outside the repo.

**Own set (T1–T41, U2–U22): 59 mutations, 55 killed, 4 equivalent (T29, T38, U20, U21).** Survivors along the way
that led to new tests:
- T39: backup codes before the confirmation;
- T26 / T41: they masked each other, because a test read the session through a cookie the 5th response had cleared;
- U-series: the new atomic code.

**Reviewer's set (M1–M20, adapted to the fixed code where lines moved): 20 mutations, 19 killed.** M9 (a
non-constant-time compare) cannot be caught by a functional test and is kept as reviewed code. The survivors of the
review run (M1–M4, M6, M7, M14, M16, M17, M18) are now killed by the endpoint and route walks, the NOT_PENDING test,
the counter-reset test, the randomness assertion, the backup-code assertion and the `/2fa` action test. M8 found a real
bug: rotated sessions lost their state; it is fixed in 10d14a4.

| # | file | mutation | result | first test that failed / note |
|---|---|---|---|---|
| T1 | `web/lib/second-factor-core.ts` | OIDC_REQUIRE_TOTP off unless set to 1 | killed | production: enrol and verify refuse a foreign or missing Origin, accept PUBLIC_URL |
| T2 | `web/lib/second-factor-core.ts` | OIDC callback session classified verified | killed | production: enrol and verify refuse a foreign or missing Origin, accept PUBLIC_URL |
| T3 | `web/lib/second-factor-core.ts` | any provider's callback counts as the OIDC one | killed | classifyNewSession: OIDC callback pending, password paths exempt, the rest unknown |
| T4 | `web/lib/second-factor-core.ts` | password + better-auth TOTP session not exempt | killed | linked user: password login keeps its harness, OIDC links by email, enrols, then password + TOTP sign-in works |
| T5 | `web/lib/second-factor-core.ts` | get-session allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T6 | `web/lib/second-factor-core.ts` | two-factor/disable allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T7 | `web/lib/second-factor-core.ts` | a state row of another user is honoured | killed | sessionState / isPending: a row decides; no row = pending only for OIDC users; a row of another user is ignored |
| T8 | `web/lib/second-factor-core.ts` | sessions without a row grandfathered (exempt) for OIDC users too | killed | sessions from before the feature (no state row) of an OIDC user are pending; password-only users are not affected |
| T9 | `web/lib/second-factor-core.ts` | no-row state not treated as pending | killed | sessions from before the feature (no state row) of an OIDC user are pending; password-only users are not affected |
| T10 | `web/lib/second-factor-core.ts` | lock one failure later | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T11 | `web/lib/second-factor-core.ts` | lock never expires | killed | countAttempt: count within the window, lock at the maximum, growing locks, hard lock, reset |
| T12 | `web/lib/second-factor-core.ts` | failure window never restarts | killed | locks grow (15 → 30 min), are logged without secrets, and a hard lock needs the admin |
| T13 | `web/lib/second-factor-core.ts` | HOTP truncation without the sign mask | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T14 | `web/lib/second-factor-core.ts` | window loses the next step | killed | concurrency: the same valid code on two pending sessions at once — exactly one succeeds |
| T15 | `web/lib/second-factor-core.ts` | replay of the last used step accepted | killed | matchTotp: window of ±1 step, constant shape, replay refused |
| T16 | `web/lib/second-factor-core.ts` | window of ±2 steps | killed | an old code (outside the window) and a code from another secret are refused |
| T17 | `web/lib/second-factor-core.ts` | last used step can go back | killed | last TOTP step per user never goes back |
| T18 | `web/lib/second-factor-core.ts` | backup code compared by its first half | killed | backup codes: format, exact match only, index of the match |
| T19 | `web/lib/second-factor-core.ts` | protocol-relative next accepted | killed | secondFactorPageAction: login, the sanitised target, or the form |
| T20 | `web/lib/second-factor-core.ts` | 8-character TOTP secret | killed | hotp: RFC 4226 / RFC 6238 test vectors and better-auth's implementation |
| T21 | `web/lib/second-factor-core.ts` | cleanup deletes live sessions' rows | killed | cleanup drops rows of missing or expired sessions and old failure counters |
| T22 | `web/lib/second-factor.ts` | gate lets pending sessions through | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T23 | `web/lib/second-factor.ts` | gate exempts get-session | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T24 | `web/lib/second-factor.ts` | two-factor/disable allowed for SSO users | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T25 | `web/lib/second-factor-core.ts` | user lock not checked | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T26 | `web/lib/second-factor.ts` | session not revoked after 5 wrong codes | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T27 | `web/lib/second-factor-core.ts` | no session rotation (the pending session becomes verified) | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T28 | `web/lib/second-factor.ts` | a used backup code is not removed | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T29 | `web/lib/second-factor.ts` | replay: last used step not passed | **equivalent** | the atomic step check in consumeSuccess refuses the replay anyway (the pre-filter is defence in depth) |
| T30 | `web/lib/second-factor-core.ts` | replay: used step not saved | killed | consumeSuccess: one winner, nothing half-done |
| T31 | `web/lib/second-factor.ts` | enrolment does not set twoFactorEnabled | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T32 | `web/lib/second-factor-core.ts` | enrolment does not mark the twoFactor row verified | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T33 | `web/lib/second-factor-core.ts` | enrol of an already enrolled user returns its secret | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T34 | `web/lib/second-factor.ts` | session hook never marks OIDC sessions pending (default-deny remains) | killed | sign-out clears the pending session and its state |
| T35 | `web/lib/second-factor-core.ts` | user failures not counted | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T36 | `web/lib/auth.ts` | plugin not installed when required | killed | OIDC_REQUIRE_TOTP=0: the OIDC session works at once, no second-factor endpoints, no state rows |
| T37 | `web/lib/harness-services.ts` | requireUser reads the session past the gate (internal adapter) | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T38 | `web/lib/second-factor.ts` | verified state set on the old session too (pending row kept) | **equivalent** | consumeSuccess already removed the state row; the second forget is redundant |
| T39 | `web/lib/second-factor.ts` | backup codes usable during enrolment | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T40 | `web/lib/second-factor-core.ts` | two-factor/verify-totp allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T41 | `web/lib/second-factor.ts` | a session over its attempt limit is refused but not revoked | killed | a session whose attempts are used up is revoked by its next request, even if nothing revoked it before |
| U2 | `web/lib/second-factor-core.ts` | consumeSuccess: live-session check removed (expired session upgraded) | killed | consumeSuccess: one winner, nothing half-done |
| U3 | `web/lib/second-factor-core.ts` | consumeSuccess: pending check removed | killed | consumeSuccess: one winner, nothing half-done |
| U4 | `web/lib/second-factor-core.ts` | backup code compare-and-swap without the old value | killed | consumeSuccess: one winner, nothing half-done |
| U5 | `web/lib/second-factor-core.ts` | enrolment confirm without the secret check | killed | consumeSuccess: one winner, nothing half-done |
| U6 | `web/lib/second-factor-core.ts` | legacy verified NULL row treated as unconfirmed | killed | legacy twoFactor rows with verified NULL count as set up: enrol refuses and reveals nothing |
| U7 | `web/lib/second-factor-core.ts` | enrol inserts a second row instead of replacing | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| U8 | `web/lib/second-factor-core.ts` | no hard lock | killed | countAttempt: count within the window, lock at the maximum, growing locks, hard lock, reset |
| U9 | `web/lib/second-factor-core.ts` | locks do not grow | killed | locks grow (15 → 30 min), are logged without secrets, and a hard lock needs the admin |
| U10 | `web/lib/second-factor.ts` | lock not logged on the revoking attempt | killed | locks grow (15 → 30 min), are logged without secrets, and a hard lock needs the admin |
| U11 | `web/lib/second-factor.ts` | SSO account can be unlinked | killed | the SSO account cannot be unlinked, even from a verified session |
| U13 | `web/lib/second-factor-core.ts` | attempts beyond the session limit still evaluated | killed | concurrency: 40 parallel wrong codes on one pending session — exactly 5 are evaluated |
| U15 | `web/lib/second-factor-core.ts` | /2fa without a session renders instead of going to login | killed | secondFactorPageAction: login, the sanitised target, or the form |
| U16 | `web/lib/second-factor.ts` | enrol for an enrolled user answers with a (new, unused) secret | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| U18 | `web/lib/second-factor-core.ts` | revokeSession keeps the session row | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| U19 | `web/lib/second-factor-core.ts` | reaching the session limit does not lock/revoke: limit 6 | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| U20 | `web/lib/second-factor.ts` | rotation inherits the state of another user's session | **equivalent** | no endpoint creates a session for another user within one request in this configuration (no impersonation plugin); defence in depth |
| U21 | `web/lib/second-factor.ts` | rotation inherits a pending state too | **equivalent** | the gate lets a pending session reach only endpoints whose sessions are classified (callback, sign-in) or set explicitly (verify); defence in depth |
| U22 | `web/lib/second-factor.ts` | the gate does not record the request's session (no carry-over) | killed | a verified or exempt session rotated by another endpoint (change-password) keeps its state |

Reviewer's set:

| # | mutation | result | first test that failed / note |
|---|---|---|---|
| M1 | get-access-token (IdP tokens) allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| M2 | update-session allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| M3 | account-info allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| M4 | unlink-account allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| M5 | legacy twoFactor rows (verified NULL) treated as not enrolled -> enrol returns their secret | killed | legacy twoFactor rows with verified NULL count as set up: enrol refuses and reveals nothing |
| M6 | enrol callable without a pending session | killed | enrol and verify need a pending session: verified and password sessions get NOT_PENDING, nothing is stored |
| M7 | user failure counter not reset after success | killed | concurrency: 40 parallel wrong codes on one pending session — exactly 5 are evaluated |
| M8 | rotated sessions do not inherit verified/exempt | killed | a verified or exempt session rotated by another endpoint (change-password) keeps its state |
| M9 | non-constant-time code compare | **survives (by nature)** | timing is not observable by a functional test; timingSafeEqual is kept and reviewed |
| M10 | gate reads the cookie unsigned (token.sig never found) | killed | production: enrol and verify refuse a foreign or missing Origin, accept PUBLIC_URL |
| M11 | gate ignores session expiry | killed | an expired pending session is no session for the second-factor endpoints either |
| M12 | safeNext: control characters accepted | killed | secondFactorPageAction: login, the sanitised target, or the form |
| M13 | safeNext: /\ accepted | killed | secondFactorPageAction: login, the sanitised target, or the form |
| M14 | neuraldeep route ignores the session result | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| M15 | user attempts counted per session instead of per user (variant) | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| M16 | secrets/backup codes from Math.random | killed | secrets and backup codes come from node:crypto, not Math.random |
| M17 | every successful verify returns the remaining backup codes | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| M18 | /2fa redirect uses unsanitised next (open redirect) | killed | secondFactorPageAction: login, the sanitised target, or the form |
| M19 | lock checked per session instead of per user | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| M20 | disable refused only while pending | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |

Re-review set (V1–V14, on 467a1fe with the V9 test fix): **14 mutations, 14 killed** (V9 after a test fix; V3 was
first written as a syntax error and replaced by a valid one). They supersede T25 → V7, T31 → V2, U11 → V1,
U20 → V4, U21 → V5 and the reviewer's M8 → V14, whose lines moved. All other T/U/M mutations target lines unchanged
since the full run on 10d14a4.

| # | file | mutation | result | first test that failed |
|---|---|---|---|---|
| V1 | `web/lib/second-factor.ts` | unlink refused only when the body names the SSO provider (the bypass) | killed | an SSO user cannot unlink any account (better-auth takes only accountId), so TOTP stays required |
| V2 | `web/lib/second-factor-core.ts` | user flag not set in the success transaction | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| V3 | `web/lib/second-factor-core.ts` | user flag failure does not roll back | killed | consumeSuccess: one winner, nothing half-done |
| V4 | `web/lib/second-factor-core.ts` | rotation inherits another user's state (the N9 guard) | killed | inheritedState: same user only, verified/exempt only |
| V5 | `web/lib/second-factor-core.ts` | rotation inherits a pending state | killed | inheritedState: same user only, verified/exempt only |
| V6 | `web/lib/second-factor-core.ts` | backup codes refused during a lock | killed | backup codes work during a soft or hard lock (own counter, 5 per hour) and clear it; TOTP codes stay locked |
| V7 | `web/lib/second-factor-core.ts` | TOTP codes allowed during a lock | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| V8 | `web/lib/second-factor-core.ts` | no limit on backup attempts during a lock | killed | backup codes work during a soft or hard lock (own counter, 5 per hour) and clear it; TOTP codes stay locked |
| V9 | `web/lib/second-factor-core.ts` | backup counter window never restarts | killed | beginAttempt while locked: … (**survived first**, test fixed: the soft lock had expired before the next-hour check) |
| V10 | `web/lib/second-factor-core.ts` | backup attempt during a lock skips the session cap | killed | beginAttempt while locked: TOTP refused, backup codes on their own counter (5 per hour), session cap still applies |
| V11 | `web/lib/second-factor-core.ts` | backup counter not reset by a success | killed | backup codes work during a soft or hard lock (own counter, 5 per hour) and clear it; TOTP codes stay locked |
| V12 | `web/lib/second-factor-core.ts` | id_token sign-in sessions not marked pending (default-deny remains) | killed | a verified session of user A plus an id_token sign-in of user B gives B a pending session, never A's state |
| V13 | `web/lib/second-factor.ts` | backup attempt flag derived wrongly (every code treated as TOTP) | killed | backup codes work during a soft or hard lock (own counter, 5 per hour) and clear it; TOTP codes stay locked |
| V14 | `web/lib/second-factor.ts` | rotated sessions do not inherit verified/exempt (reviewer's M8 on the new code) | killed | a verified or exempt session rotated by another endpoint (change-password) keeps its state |

## Review findings (2026-10-30) and what was done

| # | finding | fix |
|---|---|---|
| F1 (High) | concurrent verifies bypassed the 5/10 limits; a correct code in a burst upgraded an already revoked session | attempts counted for session and user in one synchronous transaction before any await (`beginAttempt`); success consumed in one transaction (`consumeSuccess`: live + pending session, conditional TOTP step, backup-code compare-and-swap, enrolment secret check, session row deleted); a session is revoked synchronously when its last attempt fails |
| F2 (Medium) | enrol returned an existing unconfirmed secret to another pending session | a new secret and new backup codes on every call, replacing only an unconfirmed row; confirmed and legacy (NULL) rows never touched or revealed; one row per user (transaction) |
| F3 (Medium) | fixed 15-min user lock | locks double up to 24 h, hard lock after 5 (admin SQL above), one JSON log line per lock, residual rate documented |
| F4 (Low) | SSO account could be unlinked, then TOTP disabled | `/unlink-account` of the SSO provider refused for any session; disable refused for users with an SSO account (decision above) |
| F5 | Origin in production; concurrent first enrols | production-mode test (foreign/missing/look-alike Origin → 403); enrolment in a transaction, one row |
| — | rotated sessions lost their verified state (found by M8) | gate records the request's session state; the session hook inherits it for the same user |
| F4 (re-review) | `/unlink-account` takes only `{accountId}`, so the `providerId` check was bypassable | any unlink refused for a user with an SSO account; test without `providerId` |
| R2 | `twoFactorEnabled` set after the transaction | set inside `consumeSuccess`; rollback tested |
| R3 | rotation guard `prev.userId === session.userId` untested | `inheritedState` pure and unit-tested; A's verified cookie + B's id_token sign-in → B pending; `/sign-in/social` sessions classified pending |
| R4 | a locked owner needed an admin | backup codes work during soft/hard locks on their own counter (5/hour), TOTP stays locked; tests |

## Upstream

Everything here is generic: no company names, domains or secrets. `OIDC_REQUIRE_TOTP` only matters when OIDC is
configured, and `0` restores the previous behaviour exactly. One PR on top of the pilot's OIDC PR:
- `lib/second-factor-core.ts` + `lib/second-factor.ts` + the `lib/auth.ts` wiring;
- the `sessionFromHeaders` refactor of every session check;
- `/2fa` + `components/second-factor.tsx` + i18n;
- tests with the mock IdP.

The mock IdP (`test/oidc-mock.mjs`) is reusable for the pilot's OIDC code too. This document (`docs/razum/`) is
fork-only.
