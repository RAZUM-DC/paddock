---
node_type: runbook
title: Поднять и выкатить
description: "Первый запуск на сервере с docker compose и выкатка новой версии морды через супервизор."
service: _platform
status: active
updated: 2026-10-29
links:
  documents: [../../docker-compose.yml, ../../web/supervisor.sh]
---

# Поднять и выкатить

## С нуля

```bash
git clone https://github.com/vakovalskii/paddock && cd paddock
mkdir -p secrets/egress secrets/tokens && chmod 700 secrets
# secrets/egress/gost.yaml — цепочка прокси (пример в docs/services/egress), + блок api с паролем
# secrets/web.env:
#   BETTER_AUTH_SECRET=<openssl rand -hex 32>
#   PUBLIC_URL=http://localhost:8088
#   GOST_API=http://egress:18080/api  GOST_API_USER=hub  GOST_API_PASS=<как в gost.yaml>
#   ADMIN_USERS=<имя>
./add-user.sh <имя> --admin
docker compose up -d --build
docker compose exec web npm run create-user -- <имя>@hub.local '<пароль 12+>'
```

Дальше вход в ChatGPT — из морды: Настройки → Аккаунт ChatGPT → «Получить код».

## Новая версия морды

```bash
rsync -az --exclude node_modules --exclude .next web/ server:paddock/web/
ssh server 'date +%s > paddock/web/.deploy-request'
ssh server 'cat paddock/web/.deploy-status'   # building → deployed / build FAILED / rolled back
```

То же делает сам Codex админа изнутри: исходники примонтированы ему в `/workspace/codex-hub-web`.

## Проверка

```bash
HUB_PASS=... node tests/ui-tour.mjs /tmp/tour     # 18 шагов по всей морде
HUB_PASS=... node tests/grid-edges.mjs            # 22 проверки сетки окон
```
