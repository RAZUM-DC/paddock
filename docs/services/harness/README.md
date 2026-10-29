---
node_type: service
title: harness — контейнер агента пользователя
description: "Codex app-server в своём контейнере на пользователя: свой ~/.codex, свой /workspace, вход в ChatGPT, выход в интернет только через egress."
service: harness
status: active
updated: 2026-10-29
links:
  documents: [../../../codex, ../../../users/_template.yml, ../../../add-user.sh]
  relates_to: [../../reference/harness-protocol.md, ../../ops/add-user.md]
---

# harness — контейнер агента пользователя

- Образ `codex/Dockerfile`: node 22 + `@openai/codex`, пользователь `codex` (uid 1000).
- Запуск: `codex app-server --listen ws://0.0.0.0:4500 --ws-auth capability-token`; токен — `secrets/tokens/<user>.token`.
- Тома: `harness-home-<user>` (`~/.codex`), `workspace-<user>` (`/workspace`). Админу ещё монтируются исходники морды — Codex может её править и выкатывать.
- Сеть: только `core` (internal). Интернет — через `HTTPS_PROXY=http://egress:8080`.
- `codex/config.toml`: `sandbox_mode = "danger-full-access"` (песочница — сам контейнер), `approval_policy = "on-request"`. Меняется из морды.
- Сессии Codex хранит бессрочно; см. roadmap 3.6.
