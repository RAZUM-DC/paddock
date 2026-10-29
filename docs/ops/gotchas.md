---
node_type: gotcha
title: Ловушки
description: "Что уже ломалось: бинарные WS-фреймы, дубли тредов после revert, devDependencies в сборке, автозаполнение паролей, гидратация, тесты и uppercase."
service: _platform
status: active
updated: 2026-10-29
---

# Ловушки

- **app-server молча игнорирует бинарные WS-фреймы.** `ws` отдаёт Buffer, `send(Buffer)` шлёт бинарный фрейм → мост передаёт `{ binary: isBinary }` явно (`web/server.ts`).
- **После `thread/revert` `thread/list` отдаёт тред дважды** (codex 0.165) — морда убирает дубли по id.
- **Сборка без devDependencies падает** — `npm ci --include=dev` в супервизоре.
- **Email вида `valera@hub` не проходит валидацию** better-auth — используем `@hub.local`.
- **Менеджер паролей вписывает логин в первое текстовое поле страницы** (поиск по чатам) при виде поля пароля → у форм с паролем есть скрытое `autocomplete="username"`, у поиска `type=search autocomplete=off`.
- **React #418 (гидратация)**: раскладка из localStorage на первом рендере → рабочая область рисуется только на клиенте.
- **Node `fetch` не ходит через `HTTPS_PROXY`** — наружу из морды через CONNECT к egress (`viaEgress`), из харнесса — curl.
- **Тесты: `innerText` учитывает `text-transform: uppercase`** — сравнивать без учёта регистра.
- **Сессии Codex не чистятся сами** — см. roadmap 3.6.
