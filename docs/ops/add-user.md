---
node_type: runbook
title: Новый пользователь
description: "add-user.sh: контейнер, тома и токен; затем пользователь морды и вход в ChatGPT."
service: harness
status: active
updated: 2026-10-29
links:
  documents: [../../add-user.sh, ../../users/_template.yml]
---

# Новый пользователь

1. `./add-user.sh <имя>` (или `--admin`, чтобы его агент мог править морду). Скрипт создаёт `users/<имя>.yml`, токен и дописывает compose-файл в `.env`.
2. `docker compose up -d harness контейнера` (`codex-<имя>`).
3. `docker compose exec web npm run create-user -- <имя>@hub.local '<пароль>'` — часть до `@` связывает пользователя морды с его контейнером.
4. Пользователь входит и в Настройках подключает ChatGPT (код устройства) или API-ключ.
