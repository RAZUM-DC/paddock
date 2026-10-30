---
node_type: service
title: web — the web UI
description: "Next.js + assistant-ui: chat panes, statusline, settings; server.ts holds the WS bridge to harnesses; supervisor.sh builds and switches versions."
service: web
status: active
updated: 2026-10-29
links:
  documents: [../../../web]
  relates_to: [../../reference/architecture.md, ../../ops/deploy.md]
---

# web — the web UI

| file | what |
|---|---|
| `web/server.ts` | HTTP + `/ws/codex`: checks the cookie session and Origin; the user's token is added server-side |
| `web/components/chat.tsx` | workspace: connection, sidebar, 1/2/4 layout, drag and drop, borders, files |
| `web/components/pane.tsx` | a single pane: thread, turns, editing, model, composer, statusline |
| `web/lib/messages.ts` | harness events → messages and tool cards |
| `web/components/settings.tsx` | account, NeuralDeep, Codex, proxy, password (images — in progress) |
| `web/lib/proxy.ts` | gost API (admin only), outbound requests through egress |
| `web/tools/` | registry of Paddock tools (CLI + skill); the web UI installs them into the harness, see `web/tools/README.md` |
| `web/lib/harness-api.ts` | `/api/harness/*` for harness containers (git credentials, secret requests), handled in `server.ts` before Next; harness auth in `lib/harness-auth.ts` |
| `web/lib/git-accounts.ts` | per-user git accounts (`git_accounts` in `/data/auth.db`, token sealed by `lib/secret-box.ts`), matching by host and path prefix; browser API `/api/git/*`; admins: `/api/admin/git-accounts?user=<email or harness id>` (count, revoke all) |
| `web/lib/secret-requests.ts` | in-memory secret requests of the `secrets` tool; browser API `/api/secret-requests`, form in `components/secret-requests.tsx` |
| `web/lib/second-factor.ts` | TOTP after an OIDC login (`OIDC_REQUIRE_TOTP`): gate on every better-auth endpoint for "pending" sessions, `/api/auth/second-factor/*`, page `/2fa`; every session check goes through `sessionFromHeaders` in `lib/auth.ts` |
| `web/lib/turn-meta.ts` | `turn_meta` table in `/data/auth.db`: model, TTFT, tok/s, last usage of a turn |
| `web/supervisor.sh` | builds next to the old version, switches only when `/login` is alive, rolls back; `SELF_DEPLOY=0` = build once, ignore deploy requests |
| `web/Dockerfile.prod` | alternative image: built at image build time, no supervisor, no self-deploy |

The admin is set by `ADMIN_USERS` in `secrets/web.env`. Deploy: [ops/deploy.md](../../ops/deploy.md).
