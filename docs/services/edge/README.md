---
node_type: service
title: edge — точка входа
description: "nginx 1.27: единственный опубликованный порт (по умолчанию 127.0.0.1:8088), WebSocket upgrade до морды."
service: edge
status: active
updated: 2026-10-29
links:
  documents: [../../../edge/nginx.conf]
---

# edge — точка входа

`EDGE_BIND` в `.env` решает, на каком адресе слушать (по умолчанию `127.0.0.1`, снаружи — SSH-туннель).
Публичный доступ: домен + HTTPS на внешнем nginx/Traefik, `PUBLIC_URL=https://…` в `secrets/web.env`
(от него зависит проверка Origin). См. roadmap 3.10.
