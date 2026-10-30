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
   - **First time**: `POST /api/auth/second-factor/enrol` creates a `twoFactor` row exactly as better-auth's plugin does
     (`secret` and `backupCodes` encrypted with `symmetricEncrypt` and the auth secret, `verified = false`) and returns
     the otpauth URI → QR code and manual key → the person enters a code → the row becomes `verified`,
     `user.twoFactorEnabled = true`, and the 10 backup codes are shown once.
5. `POST /api/auth/second-factor/verify` succeeds → a **new session** (new token, the old one deleted: no session
   fixation) is marked **verified**, the cookie replaced, the browser goes to `next`.

The password path is unchanged: `/sign-in/email` (and better-auth's own `/two-factor/verify-totp` step when the user
has TOTP) creates an **exempt** session.

## Env

| var | default | meaning |
|---|---|---|
| `OIDC_REQUIRE_TOTP` | `1` whenever `OIDC_ISSUER` + `OIDC_CLIENT_ID` are set | `0` = old behaviour (the plugin and the session hooks are not installed at all) |

No other new variables. TOTP: SHA-1, 6 digits, 30 s, ±1 step (like better-auth). Lockout: 5 wrong codes on one pending
session revoke it (sign in through SSO again); 10 wrong codes in 15 min across a user's sessions lock the user for
15 min (even the right code gets 429). better-auth's rate limit adds 20 requests/min per client address on
`/second-factor/*`.

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
- a session rotated by another endpoint keeps the state of the one it replaces;
- **no row** (e.g. sessions from before this branch, or an unknown path) → pending **if the user has an OIDC account**,
  fine otherwise. Old OIDC sessions are not grandfathered. That also covers old *password* sessions of a user who has an
  OIDC account linked: they too must enter the TOTP once.

Rows of signed-out or expired sessions are removed by better-auth's session delete hook and by a cleanup at start and
every 10 minutes.

## Decisions

- **Disabling TOTP**: refused (`403 TOTP_REQUIRED_FOR_SSO`) for any user with an OIDC account while
  `OIDC_REQUIRE_TOTP` is on, whatever the session. Otherwise the next SSO login would simply enrol again, and a stolen
  verified session could remove the second factor. "Settings → Paddock login" then shows an error on "disable".
- **Lost phone / reset** (admin, on the server; the user then enrols again at the next SSO login):
  `sqlite3 data/auth.db "DELETE FROM twoFactor WHERE userId = '<id>'; UPDATE user SET twoFactorEnabled = 0 WHERE id = '<id>';"`
  Backup codes cover the usual case without an admin.
- **Password login stays as it was** (the owner's request). A linked user who has a password can still sign in with
  it, and with TOTP once they have enrolled through SSO. With `LOCAL_LOGIN=0` password sign-in is off on the server.

## Threat notes

- An attacker with someone's SSO credentials (phished, reused) now also needs their authenticator. On the **first**
  SSO login of a person without TOTP, whoever completes the SSO login enrols the authenticator. Enrol everyone soon, or
  pre-enrol on a known device. An attacker can't take over an *existing* enrolment: `enrol` answers 409 once a
  verified row exists, and never returns that secret.
- Codes: constant-time comparison of all window steps and all backup codes. A used step can't be replayed through
  `/second-factor/verify`. better-auth's own password-flow verify has no replay protection, and it keeps its own
  failure counter. A code used in one flow could be reused within 90 s in the other only by someone who also has the
  password.
- Session fixation: the session that saw the second factor is new; the pending token is deleted.
- The gate needs a valid signed cookie and a live session; a bare or forged token is no session at all.
- Pending sessions still count as signed in for better-auth's own sign-in rate limits and stay in the `session` table
  until they expire or the person signs out.
- `/2fa?next=` accepts only same-site paths (no `//`, `/\`, `/api/`, control characters).

## Verified here

- `cd web && npx tsc --noEmit -p . && node scripts/check-i18n.mjs && npx next build`: pass. Web tests (`npm test`) and
  provisioner tests: see the final counts in the commit log / report.
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
  - **The linked-user case of the rollout**: a password user `evgenii@hub.local` gets harness `evgenii`. The email is
    changed in the db to the directory address. An SSO login without `email_verified` is not linked
    (`account_not_linked`); with it, it links to the same user, and the harness stays `evgenii`. The user enrols, then
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

- The real IdP (lk.razum.life / django-oauth-toolkit): its discovery document, the `iss` value it puts into the
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
  (`oauth2/callback.mjs`, `ISSUER_MISMATCH`). If lk's discovery says `https://lk.razum.life/o` and the response carries
  `https://lk.razum.life/o/`, login fails with `issuer_mismatch`. Check once:
  `curl -s https://lk.razum.life/o/.well-known/openid-configuration | jq .issuer` against the `iss` in a real
  callback URL.
- `OIDC_ISSUER=https://lk.razum.life/o` gives discovery at `https://lk.razum.life/o/.well-known/openid-configuration`.

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
- **Harness.** `harness_users` keeps `evgenii` after the email change and the link (tested): the user id doesn't change,
  and a stored harness id always wins.
- **Precondition.** The `harness_users` row must exist **before** the email is changed, i.e. Evgenii has loaded Paddock
  at least once with the pilot (or later) build. Without the row, the first lookup after the change would derive the
  id from the new email. `evgenii.erman@…` is not a valid legacy name, so he would get "no harness" (403). Check
  `SELECT * FROM harness_users WHERE user_id = '<id>'` before the change. If it is missing, insert
  `('<id>', 'evgenii', <now ms>)`.
- **Steps.**
  1. Change the email in lower case: `UPDATE user SET email = lower('<AD email>') WHERE id = '<id>'`.
  2. Check `emailVerified = 1`.
  3. Log in through SSO and enrol the TOTP.

  His password keeps working, now with TOTP.

## Mutation testing

Method as in [g017-mutation.md](g017-mutation.md): one deliberate bug at a time in the security-relevant lines of
`lib/second-factor-core.ts`, `lib/second-factor.ts`, the `lib/auth.ts` wiring and one route check; the whole `web`
suite run (`node --import tsx --test test/*.test.mjs`, which includes the mock-IdP integration test); the file
restored. The runner lived outside the repo.

**Score: 40 mutations, 39 killed, 1 equivalent (T38).** T39 survived the first run (backup codes accepted before the
app is confirmed — not exploitable, the codes are only revealed after confirmation, but the rule is now tested) and
was killed by a new assertion.

| # | file | mutation | result | first test that failed / note |
|---|---|---|---|---|
| T1 | `web/lib/second-factor-core.ts` | OIDC_REQUIRE_TOTP off unless set to 1 | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T2 | `web/lib/second-factor-core.ts` | OIDC callback session classified verified | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T3 | `web/lib/second-factor-core.ts` | any provider's callback counts as the OIDC one | killed | classifyNewSession: OIDC callback pending, password paths exempt, the rest unknown |
| T4 | `web/lib/second-factor-core.ts` | password + better-auth TOTP session not exempt | killed | linked user: password login keeps its harness, OIDC links by email, enrols, then password + TOTP sign-in works |
| T5 | `web/lib/second-factor-core.ts` | get-session allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T6 | `web/lib/second-factor-core.ts` | two-factor/disable allowed while pending | killed | allowedWhilePending: only sign-out, sign-in and the second-factor endpoints |
| T7 | `web/lib/second-factor-core.ts` | a state row of another user is honoured | killed | sessionState / isPending: a row decides; no row = pending only for OIDC users; a row of another user is ignored |
| T8 | `web/lib/second-factor-core.ts` | sessions without a row grandfathered (exempt) for OIDC users too | killed | sessions from before the feature (no state row) of an OIDC user are pending; password-only users are not affected |
| T9 | `web/lib/second-factor-core.ts` | no-row state not treated as pending | killed | sessions from before the feature (no state row) of an OIDC user are pending; password-only users are not affected |
| T10 | `web/lib/second-factor-core.ts` | lock one failure later | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T11 | `web/lib/second-factor-core.ts` | lock never expires | killed | failures: count within the window, lock at the maximum, reset |
| T12 | `web/lib/second-factor-core.ts` | failure window never restarts | killed | failures: count within the window, lock at the maximum, reset |
| T13 | `web/lib/second-factor-core.ts` | HOTP truncation without the sign mask | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T14 | `web/lib/second-factor-core.ts` | window loses the next step | killed | matchTotp: window of ±1 step, constant shape, replay refused |
| T15 | `web/lib/second-factor-core.ts` | replay of the last used step accepted | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T16 | `web/lib/second-factor-core.ts` | window of ±2 steps | killed | an old code (outside the window) and a code from another secret are refused |
| T17 | `web/lib/second-factor-core.ts` | last used step can go back | killed | last TOTP step per user never goes back |
| T18 | `web/lib/second-factor-core.ts` | backup code compared by its first half | killed | backup codes: format, exact match only, index of the match |
| T19 | `web/lib/second-factor-core.ts` | protocol-relative next accepted | killed | safeNext: a path on this site, nothing else |
| T20 | `web/lib/second-factor-core.ts` | 8-character TOTP secret | killed | hotp: RFC 4226 / RFC 6238 test vectors and better-auth's implementation |
| T21 | `web/lib/second-factor-core.ts` | cleanup deletes live sessions' rows | killed | cleanup drops rows of missing or expired sessions and old failure counters |
| T22 | `web/lib/second-factor.ts` | gate lets pending sessions through | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T23 | `web/lib/second-factor.ts` | gate exempts get-session | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T24 | `web/lib/second-factor.ts` | two-factor/disable allowed for SSO users | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T25 | `web/lib/second-factor.ts` | user lock not checked | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T26 | `web/lib/second-factor.ts` | session not revoked after 5 wrong codes | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T27 | `web/lib/second-factor.ts` | no session rotation (the pending session becomes verified) | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T28 | `web/lib/second-factor.ts` | a used backup code is not removed | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T29 | `web/lib/second-factor.ts` | replay: last used step not passed | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T30 | `web/lib/second-factor.ts` | replay: used step not saved | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T31 | `web/lib/second-factor.ts` | enrolment does not set twoFactorEnabled | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T32 | `web/lib/second-factor.ts` | enrolment does not mark the twoFactor row verified | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T33 | `web/lib/second-factor.ts` | enrol of an already enrolled user returns its secret | killed | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T34 | `web/lib/second-factor.ts` | session hook never marks OIDC sessions pending (default-deny remains) | killed | sign-out clears the pending session and its state |
| T35 | `web/lib/second-factor.ts` | user failures not counted | killed | lockout: 5 wrong codes revoke the session; 10 across sessions lock the user even for the right code |
| T36 | `web/lib/auth.ts` | plugin not installed when required | killed | OIDC_REQUIRE_TOTP=0: the OIDC session works at once, no second-factor endpoints, no state rows |
| T37 | `web/lib/harness-services.ts` | requireUser reads the session past the gate (internal adapter) | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |
| T38 | `web/lib/second-factor.ts` | verified state set on the old session too (pending row kept) | **equivalent** | better-auth's session delete hook removes the old session's state row anyway (defence in depth) |
| T39 | `web/lib/second-factor.ts` | backup codes usable during enrolment | **survived → killed** after a new test | first enrolment: otpauth URI, stored like better-auth's twoFactor, then a new verified session |
| T40 | `web/lib/second-factor-core.ts` | two-factor/verify-totp allowed while pending | killed | an OIDC session is pending: no get-session, no WS bridge, no API route, no account settings |

## Upstream

Everything here is generic: no company names, domains or secrets. `OIDC_REQUIRE_TOTP` only matters when OIDC is
configured, and `0` restores the previous behaviour exactly. One PR on top of the pilot's OIDC PR:
- `lib/second-factor-core.ts` + `lib/second-factor.ts` + the `lib/auth.ts` wiring;
- the `sessionFromHeaders` refactor of every session check;
- `/2fa` + `components/second-factor.tsx` + i18n;
- tests with the mock IdP.

The mock IdP (`test/oidc-mock.mjs`) is reusable for the pilot's OIDC code too. This document (`docs/razum/`) is
fork-only.
