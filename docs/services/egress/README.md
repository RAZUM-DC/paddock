---
node_type: service
title: egress — the way out to the internet
description: "gost 3: HTTP proxy :8080 for harnesses and the web UI, a chain of upstream proxies with failover, API :18080 (core only, password-protected) for the Proxy tab."
service: egress
status: active
updated: 2026-10-29
links:
  documents: [../../../docker-compose.yml]
  relates_to: [../../reference/architecture.md, ../../ops/gotchas.md]
---

# egress — the way out to the internet

- Config: `secrets/egress/gost.yaml` (not in git). Chain `upstream`, strategy `fifo`: top to bottom by priority, a failed node is disabled for 60 s.
- Blocks LAN and host access, so a harness cannot reach neighboring machines.
- gost API `:18080` with basic auth: the web UI edits the proxy list on the fly and saves it back to `gost.yaml` (`POST /api/config`). The API password is in `secrets/web.env`.
- Checking the way out: Settings → Proxy → "Check egress" (ipinfo.io through the chain).
- [gost.example.yaml](gost.example.yaml): a starting point with direct outbound (no upstream chain), private targets
  refused (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, 127/8 and internal container names), clients admitted
  only from private networks, and the API with a password placeholder. Marked "to verify": run the checks listed at
  its top before relying on it.
