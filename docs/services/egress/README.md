---
node_type: service
title: egress — выход в интернет
description: "gost 3: HTTP-прокси :8080 для харнессов и морды, цепочка внешних прокси с failover, API :18080 (только core, с паролем) для вкладки «Прокси»."
service: egress
status: active
updated: 2026-10-29
links:
  documents: [../../../docker-compose.yml]
  relates_to: [../../reference/architecture.md, ../../ops/gotchas.md]
---

# egress — выход в интернет

- Конфиг: `secrets/egress/gost.yaml` (в git не попадает). Цепочка `upstream`, стратегия `fifo`: сверху вниз по приоритету, упавший узел выключается на 60 с.
- В LAN и на хост не пускает — харнесс не достанет до соседних машин.
- API gost `:18080` с basic-auth: морда меняет список прокси на лету и сохраняет его обратно в `gost.yaml` (`POST /api/config`). Пароль API — в `secrets/web.env`.
- Проверка выхода — Настройки → Прокси → «Проверить выход» (ipinfo.io через цепочку).
