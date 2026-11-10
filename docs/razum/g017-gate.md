---
node_type: runbook
title: G-017 gate — Paddock sign-in in front of another app (forward_auth)
description: "GET /api/gate/<app>: a forward-auth check that lets a reverse proxy (Caddy) admit an app without its own login to Paddock users who are signed in, past the second factor and allowed for that app; env, Caddy config, limits."
service: _platform
status: active
updated: 2026-11-10
links:
  documents: [../../web/lib/gate.ts, ../../web/server.ts, ../../web/test/gate.test.mjs]
  relates_to: [g017-changes.md, g017-oidc-totp.md, g017-host-firewall.md]
---

# G-017 gate: Paddock sign-in in front of another app

An app without a login of its own runs on the same host as Paddock, on another port, behind Caddy. In this note the
app is the IDE `bb`, at `https://<paddock-host>:8443`. On every request, Caddy asks Paddock (through the edge) whether
the browser's Paddock session may use the app. This works because Paddock's session cookie is host-only, and browsers
send a host-only cookie to every port of that host.

## Endpoint

`GET /api/gate/<app>` (also `HEAD`). It is handled in `server.ts` before Next, after the forwarding headers are
normalised, so it never goes through a page. The code is in `web/lib/gate.ts`.

| answer | when |
|---|---|
| **204**, with `X-Gate-User-Id`, `X-Gate-User-Email`, `X-Gate-Harness` | there is a session, it is past the second factor, and the user is allowed for `<app>` |
| **401** | no session cookie, an unknown or expired session, or a session still waiting for its second factor (`OIDC_REQUIRE_TOTP`) |
| **403** | signed in but not allowed for `<app>` |
| **404** | `<app>` is not `[a-z0-9-]{1,32}`, or no `GATE_<APP>_*` variable is set for it (deny by default) |
| **429** | too many checks from one client address |

- The session check is the same gated `sessionFromHeaders` that pages and the WS bridge use. It is given **only the
  Cookie header**: `X-Forwarded-*`, `Authorization` and every other header play no part in finding the user.
- Every answer carries `Cache-Control: no-store`. Error bodies are just the status number. Cookie values are never
  sent back.
- A header value is sent only if it is printable ASCII and at most 320 characters, so an email with CR/LF is left out.
  `X-Gate-Harness` is left out when the user has no harness id.
- Denials are logged as `gate <app> <status> <client> <path>`, where the path is that of `X-Forwarded-Uri` without
  its query.

## Who is allowed

`<APP>` is the app name upper-cased, with `-` turned into `_` (`bb` → `GATE_BB_…`, `my-ide` → `GATE_MY_IDE_…`).
These variables go in `secrets/web.env`. Any one of them that matches is enough:

| var | meaning |
|---|---|
| `GATE_<APP>_EMAILS` | comma or space list of emails, compared case-insensitively |
| `GATE_<APP>_GROUPS` | OIDC groups as of the user's **last** OIDC login (the same stored claim that `OIDC_ALLOWED_GROUPS` / `OIDC_ADMIN_GROUPS` use). A password-only user has none |
| `GATE_<APP>_ADMINS=1` | Paddock admins (`ADMIN_USERS`, or `OIDC_ADMIN_GROUPS` at the last login) |

Group changes at the IdP take effect at the next Paddock login. Someone removed from `OIDC_ALLOWED_GROUPS` loses
every session at their next login attempt. Before that, the only way to stop them is to delete their sessions.

## Rate limits

Limits are per client address, as better-auth computes it: `X-Forwarded-For` from the edge, read right to left,
skipping `TRUSTED_PROXY_HOPS`.

- 60 failed checks per minute (401, 403 or 404). After that, everything from that address gets 429 for the rest of
  the minute.
- 6000 checks per minute in total. Caddy calls the gate once per request of the app, so every asset of a page counts.
- Caddy sends the real client in `X-Forwarded-For`; it ignores an incoming one unless `trusted_proxies` is set. The
  edge then appends Caddy's own address. **Add that address, as the edge sees it, to `TRUSTED_PROXY_HOPS`.**
  Otherwise all users of the app share one bucket, and anyone probing without a cookie can get it blocked for a
  minute. The edge access log shows that address: `docker compose logs edge`. With docker-proxy it is usually the
  outside bridge's gateway (172.20.2.1).

## Caddy

```caddy
https://<paddock-host>:8443 {
	# Never let a client supply the identity headers itself (copy_headers only sets those the gate returns).
	request_header -X-Gate-User-Id
	request_header -X-Gate-User-Email
	request_header -X-Gate-Harness

	forward_auth 127.0.0.1:8088 {
		uri /api/gate/bb
		copy_headers X-Gate-User-Id X-Gate-User-Email X-Gate-Harness

		# Not signed in (or second factor pending): to Paddock's login. 403/404/429 are passed through as they are.
		@unauthorized status 401
		handle_response @unauthorized {
			redir https://<paddock-host>/login 302
		}
	}

	reverse_proxy 127.0.0.1:<bb-port> {
		# The app does not need Paddock's session cookie: strip it (better-auth.* and __Secure-better-auth.*).
		header_up Cookie "(^|;\s*)(__Secure-)?better-auth\.[^=;]*=[^;]*" ""
	}
}
```

- `forward_auth` forwards the original request headers, including Cookie, and adds `X-Forwarded-Method`,
  `X-Forwarded-Uri` and `X-Forwarded-For`. `127.0.0.1:8088` is the edge's published port.
- Check after deploying:
  - signed out: the app redirects to `/login`;
  - a pending SSO session (TOTP not entered yet): it also redirects;
  - signed in and allowed: the app loads;
  - signed in, not allowed: 403.
- Directly, from a machine that can reach the edge: `curl -si http://127.0.0.1:8088/api/gate/bb` returns 401, and
  `curl -si -H "Cookie: <your cookie>" …` returns 204 with your headers.

## Risks to keep in mind

- **Shared site.** The app now runs on the same site as Paddock (same host, other port). Browsers send Paddock's
  cookies (SameSite=Lax) along with requests that the app's pages start, as long as they are same-site. better-auth
  refuses requests whose Origin is not `PUBLIC_URL`, and the WS bridge checks Origin too. Paddock's own POST routes
  under `/api/*` should also be checked for an Origin check before an app that runs third-party code goes behind the
  gate.
- **The app's backend receives the cookie** unless Caddy strips it, as above. The cookie is HttpOnly, so the app's
  JavaScript never sees it.
- The gate only answers "this browser has an allowed Paddock session". Anything finer, such as per-user data inside
  the app, must use `X-Gate-User-Id` / `X-Gate-Harness`. The app must trust those headers only from Caddy: bind the
  app to 127.0.0.1.

## Tests

`web/test/gate.test.mjs`, 9 tests:

- The pure rules: names, env keys, case, deeper paths, the log path, and the client address.
- The handler with fake dependencies:
  - the session check sees only the cookie;
  - 204/401/403/404/405, HEAD and `no-store`;
  - an unsafe header value is left out;
  - the log has no query and no cookie;
  - failure and total limits per address.
- The handler on a real HTTP server with the real better-auth (temp sqlite, mock OpenID provider,
  `OIDC_REQUIRE_TOTP` on):
  - no cookie gives 401;
  - a pending SSO session gives 401, then 204 with the right headers once TOTP is verified;
  - group and admin rules follow the last login;
  - not allowed gives 403, and an unknown app gives 404;
  - an unsigned cookie gives 401, and sign-out gives 401;
  - a password user is matched by email.
- A static check of the `server.ts` wiring.
