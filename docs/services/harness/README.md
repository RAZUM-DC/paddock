---
node_type: service
title: harness — the user's agent container
description: "Codex app-server in its own container per user: its own ~/.codex, its own /workspace, ChatGPT login, internet only through egress."
service: harness
status: active
updated: 2026-10-29
links:
  documents: [../../../codex, ../../../users/_template.yml, ../../../add-user.sh]
  relates_to: [../../reference/harness-protocol.md, ../../ops/add-user.md]
---

# harness — the user's agent container

- Image `codex/Dockerfile` (built as `paddock-harness-codex`): node 22 + `@openai/codex`, user `codex` (uid 1000).
- Service `harness-<user>`, started as `codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token`; the token is `secrets/tokens/<user>.token`.
- Volumes: `harness-home-<user>` (`~/.codex`), `workspace-<user>` (`/workspace`). The admin additionally gets the web UI sources mounted at `/workspace/paddock-web`, so their Codex can edit and deploy the UI.
- Network: only `core` (internal). Internet goes through `HTTPS_PROXY=http://egress:8080`.
- `codex/config.toml`: `sandbox_mode = "danger-full-access"` (the container is the sandbox), `approval_policy = "on-request"`. Editable from the web UI.
- Codex keeps sessions forever; see roadmap 3.6.
- Git: `/etc/gitconfig` (from `codex/gitconfig`) sets `credential.helper = /usr/local/bin/git-credential-paddock`
  (`codex/git-credential-paddock`, node, no dependencies), `credential.useHttpPath = true`, and includes
  `~/.codex/paddock/gitconfig` (commit identity written by Settings → Git). The helper asks web
  (`PADDOCK_WEB_URL`, default `http://web:3000`; the provisioner sets `http://paddock-web:3000`; directly, not through egress) for a token of the user's git accounts,
  authenticating with the harness token (`web/lib/harness-api.ts`); `PADDOCK_GIT_CREDENTIALS=0` turns it off.
