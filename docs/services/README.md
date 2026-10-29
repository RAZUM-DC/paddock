---
node_type: index
title: services
status: active
updated: 2026-10-29
---

# services

- [web/](web/README.md) — морда: Next.js, WS-мост к харнессам, вход, супервизор выкатки
- [harness/](harness/README.md) — контейнер харнесса пользователя (сейчас Codex app-server)
- [egress/](egress/README.md) — единственный выход в интернет: gost, цепочка прокси, API для морды
- [edge/](edge/README.md) — nginx, единственная точка входа
