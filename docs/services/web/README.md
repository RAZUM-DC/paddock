---
node_type: service
title: web — морда
description: "Next.js + assistant-ui: окна чатов, statusline, настройки; server.ts держит WS-мост к харнессам; supervisor.sh собирает и переключает версии."
service: web
status: active
updated: 2026-10-29
links:
  documents: [../../../web]
  relates_to: [../../reference/architecture.md, ../../ops/deploy.md]
---

# web — морда

| файл | что |
|---|---|
| `web/server.ts` | HTTP + `/ws/codex`: проверка cookie-сессии и Origin, токен пользователя добавляется на стороне сервера |
| `web/components/chat.tsx` | рабочая область: соединение, сайдбар, раскладка 1/2/4, перетаскивание, границы, файлы |
| `web/components/pane.tsx` | одно окно: тред, ходы, правка, модель, композер, statusline |
| `web/lib/messages.ts` | события харнесса → сообщения и карточки инструментов |
| `web/components/settings.tsx` | аккаунт, NeuralDeep, Codex, прокси, пароль (картинки — в работе) |
| `web/lib/proxy.ts` | API gost (только admin), запросы наружу через egress |
| `web/tools/` | реестр инструментов Paddock (CLI + скилл), морда ставит их в харнесс, см. `web/tools/README.md` |
| `web/lib/turn-meta.ts` | таблица `turn_meta` в `/data/auth.db`: модель, TTFT, tok/s, последний расход хода |
| `web/supervisor.sh` | сборка рядом со старой, переключение только при живом `/login`, откат |

Админ задаётся `ADMIN_USERS` в `secrets/web.env`. Выкатка — [ops/deploy.md](../../ops/deploy.md).
