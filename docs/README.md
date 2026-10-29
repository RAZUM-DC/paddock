---
node_type: index
title: docs — база знаний Paddock
description: "Точка входа в документацию: архитектура, харнессы, сервисы, решения, runbook'и, план."
service: _platform
status: active
updated: 2026-10-29
---

# docs — база знаний Paddock

Устроена по подходу [OntoShip](https://github.com/vakovalskii/ontoship): markdown + `README`-индекс в каждой папке + git.
У каждого документа frontmatter с `node_type`, ссылки типизированы.

- [reference/architecture.md](reference/architecture.md) — схема связки, изоляция, где лежит состояние
- [reference/harness-protocol.md](reference/harness-protocol.md) — протокол морды, адаптеры, смена харнессов
- [services/](services/README.md) — по сервису на папку: web, egress, harness, edge
- [decisions/](decisions/README.md) — архитектурные решения (ADR)
- [ops/](ops/README.md) — выкатка, новый пользователь, ловушки
- [plans/roadmap.md](plans/roadmap.md) — что сделано, что в работе, что дальше
