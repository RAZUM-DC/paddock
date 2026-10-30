---
node_type: runbook
title: G-017 host firewall, Docker address pool and the compose network switch
description: "nft rules for the Paddock host (outside network → private ranges, per-user bridges, gost API, bridges → host), the br_netfilter requirement, a default-address-pools proposal, and how to switch the compose networks to fixed bridge names without touching a legacy harness."
service: _platform
status: active
updated: 2026-10-30
links:
  documents: [paddock-guard.nft, paddock-guard-test.sh, gost.razum.yaml, ../../docker-compose.provisioner.yml]
  relates_to: [g017-changes.md, ../services/provisioner/README.md]
---

# G-017 host firewall, Docker address pool and the compose network switch

What the containers cannot enforce themselves, enforced on the host. Applies to
`docker-compose.yml` + `docker-compose.provisioner.yml` (compose project `paddock`). All names are generic.

| bridge | network | who | route out |
|---|---|---|---|
| `pd-out` | `paddock_outside` | edge, egress | yes (the only one) |
| `pd-core` | `paddock_core` | web, edge (static `PADDOCK_EDGE_IP`, default 172.20.1.250), egress (static `PADDOCK_EGRESS_IP`, default 172.20.1.251), other core services, legacy harnesses | no (internal) |
| `pd-eapi` | `paddock_egress-api` | web, egress (alias `egress-api`) | no (internal) |
| `pu<12 hex>` | `paddock-u-u-<12 hex>` | `harness-u-<hex>`, web (alias `web`), egress (alias `egress`; its MACs here are synced into the nft set `egress_macs`) | no (internal) |
| — | `paddock_control` | web, provisioner (fixed subnet `PADDOCK_CONTROL_SUBNET`, default 172.20.9.0/24) | no (internal) |

## 1. Rules: `paddock-guard.nft`

One table, `inet paddock_guard`, with its own `forward` and `input` base chains at priority `filter - 10`. It does not
use `DOCKER-USER`: that chain exists only with Docker's iptables backend and covers forward only. A separate table works
with either backend (iptables-nft or Docker 29's nftables backend), because in nftables a `drop` in any base chain is
final, and an `accept` in this table does not skip Docker's own chains.

| # | chain | match (new connections only; replies and established flows pass) | needs br_netfilter |
|---|---|---|---|
| 1 | forward | from `pd-out` to 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 (and fc00::/7, fe80::/10) → drop, except `outside_allow4` | no (routed) |
| 2 | forward | `pu*` → `pu*` (between members of a user bridge): drop anything egress opens (`ether saddr @egress_macs`); allow tcp 3000 (web), 4500 (harness), 8080 (egress proxy); drop everything else, including tcp 18080 (gost API) | **yes** |
| 3 | forward | `pd-core` → `pd-core`: drop anything egress opens (`ip saddr $EGRESS_CORE_IP`) and tcp 18080. `pd-out` → `pd-out`: drop tcp 18080. `pd-eapi` → `pd-eapi`: only tcp 18080 (web → gost API) | **yes** |
| 4 | input | from `pd-*`, `pu*`, `docker0`, `br-*` to the host itself → drop | no |

Install (as root):

```bash
install -d /etc/nftables.d
install -m 600 docs/razum/paddock-guard.nft /etc/nftables.d/paddock-guard.nft
install -m 755 docs/razum/paddock-guard-egress-sync.sh /usr/local/sbin/paddock-guard-egress-sync.sh
nft -c -f /etc/nftables.d/paddock-guard.nft          # syntax check only
nft -f /etc/nftables.d/paddock-guard.nft && paddock-guard-egress-sync.sh   # load (replaces just this table) + fill egress_macs
nft list table inet paddock_guard
```

Boot persistence, before Docker starts any container:

```ini
# /etc/systemd/system/paddock-guard.service
[Unit]
Description=Paddock host firewall (nft table inet paddock_guard)
Wants=network-pre.target
After=network-pre.target systemd-modules-load.service
Before=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/nftables.d/paddock-guard.nft
# Loading the file empties egress_macs: refill it (fails harmlessly at boot, before Docker; the watcher fills it then).
ExecStartPost=-/usr/local/sbin/paddock-guard-egress-sync.sh
ExecReload=/usr/sbin/nft -f /etc/nftables.d/paddock-guard.nft
ExecReload=-/usr/local/sbin/paddock-guard-egress-sync.sh
ExecStop=/usr/sbin/nft delete table inet paddock_guard
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/paddock-guard-egress-watch.service — re-sync egress_macs on every network connect of egress
[Unit]
Description=Paddock: keep nft egress_macs in sync with the egress container
After=docker.service paddock-guard.service
Requires=docker.service
PartOf=paddock-guard.service
[Service]
ExecStart=/usr/local/sbin/paddock-guard-egress-sync.sh watch
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target

# /etc/systemd/system/paddock-guard-egress-sync.service — one sync (fallback, from the timer)
[Unit]
Description=Paddock: sync nft egress_macs once
After=docker.service paddock-guard.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/paddock-guard-egress-sync.sh

# /etc/systemd/system/paddock-guard-egress-sync.timer
[Unit]
Description=Paddock: sync nft egress_macs every minute
[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
```

`systemctl daemon-reload && systemctl enable --now paddock-guard paddock-guard-egress-watch paddock-guard-egress-sync.timer`.
After editing the rules, use `systemctl reload paddock-guard` (it re-syncs at once) or `restart` (which also
restarts the watcher, via `PartOf=`). A bare `nft -f` leaves `egress_macs` empty until the next timer tick (≤ 1 min). Check with `nft list set inet paddock_guard egress_macs`: one MAC per `paddock-u-*` network of egress, the
same as `docker inspect -f '{{range $n, $e := .NetworkSettings.Networks}}{{$n}} {{$e.MacAddress}}{{"\n"}}{{end}}' paddock-egress`. Do **not** include the file from a stock
`/etc/nftables.conf` that starts with `flush ruleset`. `systemctl restart nftables` would then also wipe Docker's rules.
If that ever happens: `systemctl restart docker paddock-guard`.

Exceptions for rule 1 (a private destination the outside network legitimately needs, e.g. an upstream proxy or a VPC
resolver), as `address . port` (tcp or udp):

```bash
nft add element inet paddock_guard outside_allow4 '{ 10.30.0.2 . 53 }'   # example; persist it in the .nft file
```

The gost config in `gost.razum.yaml` resolves through **public** nameservers, so egress normally needs no exception. If
the proxy chain points at an upstream proxy in a private range, add that `ip . port` here.

**Keep in sync:** `define EGRESS_CORE_IP` at the top of the file = `PADDOCK_EGRESS_IP` (compose).

Why rules 2 and 3 drop what egress opens: DNS rebinding through the proxy (`<private ip>.nip.io:4500`) passes gost's
bypass. When the address is on a network egress is attached to, egress connects from that bridge directly. Rule 1
(pd-out) never sees that connection. In production, this reached a legacy harness on core. Egress has no reason to open
a connection on any internal bridge: harnesses connect to it, and web reaches the API over pd-eapi. So:

- on core, its static address is refused as a source;
- on user networks (dynamic subnets), its MACs are refused. Docker gives each endpoint a random MAC; it ignores
  `MacAddress` in a network connect of a running container (seen on Docker 29), so the host learns the MACs from
  `docker inspect` (`paddock-guard-egress-sync.sh`, triggered by each `connect` event of egress and every minute).
  A harness cannot copy a MAC because it has no CAP_NET_ADMIN.
- Window: a user network attached after the last sync is unprotected until the event-driven sync runs (normally well
  under a second; with the timer only, up to a minute).

gost serves its API (top-level `api:`, the only form that works in 3.3.2) on every interface of egress. Port 18080 is
therefore fenced here and not in gost: refused on pu*, core and outside, and allowed on pd-eapi, where web is the only
client.

### Verified in network namespaces

`docs/razum/paddock-guard-test.sh` builds the bridges in throwaway namespaces (`pgt-*`) and loads the real
`paddock-guard.nft` there. Usage: `sudo ./paddock-guard-test.sh ./paddock-guard.nft`. It needs root, iproute2,
nft, python3 and Linux ≥ 5.3, and touches no host interface or ruleset. Run here on 6.18 / nft 1.0.9: **30/30 PASS**:

- On a user bridge: harness→web:3000 and web→harness:4500 open; harness→web:3001, web→harness:4501 and →:18080
  dropped.
- On core: →egress:8080 open, →:18080 dropped; egress (172.20.1.251) → legacy harness:4500 dropped.
- Egress on a user bridge (random MAC):
  - before the sync, egress→harness:4500 is open;
  - the sync script (with a fake `docker`) loads only the user-network MACs, lower-cased;
  - a reload empties the set and a re-sync refills it;
  - `watch` syncs at start and on egress's connect events only;
  - after the sync, harness→egress:8080 is open, →:18080 dropped, and egress→harness:4500 and egress→web:3000
    are dropped (rebinding).
- On egress-api: web→egress:18080 open; egress→web:3000 dropped.
- Bridges → host sshd dropped.
- outside → VPC dropped; outside → public open; inbound to the outside bridge unaffected.
- `outside_allow4` opens exactly one `ip . port`.
- With `bridge-nf-call-iptables=0`, the intra-bridge rules stop working (harness→web:3001 open again). Rule 1 still
  works.

The script also confirms that reloading the file twice is idempotent.

## 2. br_netfilter

Traffic between two containers on the same bridge is switched, not routed. It reaches the IP-layer hooks (and so
rules 2 and 3) only when the `br_netfilter` module is loaded and `net.bridge.bridge-nf-call-iptables=1`.
Docker may load it itself in some setups, but do not rely on that.

```bash
echo br_netfilter > /etc/modules-load.d/br_netfilter.conf
printf 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\n' > /etc/sysctl.d/90-paddock-br-netfilter.conf
modprobe br_netfilter && sysctl --system >/dev/null
```

Verify:

```bash
lsmod | grep -w br_netfilter || test -d /proc/sys/net/bridge     # module loaded (or built in)
sysctl net.bridge.bridge-nf-call-iptables                         # = 1
# Live, from inside a provisioned harness (host tools via nsenter; use IPs, the host's DNS does not know containers):
ID=u-XXXXXXXXXXXX; H=harness-$ID; N=paddock-u-$ID                # a provisioned user
pid() { docker inspect -f '{{.State.Pid}}' "$1"; }
WEB=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$N\").IPAddress}}" paddock-web)
GW=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$N")
nsenter -t "$(pid $H)" -n curl -sm3 -o /dev/null -w '%{http_code}\n' "http://$WEB:3000/login"  # 200
nsenter -t "$(pid $H)" -n curl -sm3 "http://$WEB:3001/"; echo "exit $?"   # 28 = dropped; 7 (refused) = br_netfilter OFF
nsenter -t "$(pid $H)" -n curl -sm3 "http://$GW:22/";    echo "exit $?"   # 28 (rule 4; skip if GW is empty)
nsenter -t "$(pid paddock-egress)" -n curl -sm3 http://169.254.169.254/; echo "exit $?"            # 28 (rule 1)
nsenter -t "$(pid paddock-egress)" -n curl -sm3 -o /dev/null -w '%{http_code}\n' https://example.com  # 200
nft list table inet paddock_guard | grep counter                          # the matching counters grew
```

## 3. Docker address pool (`/etc/docker/daemon.json`)

Proposal: merge into the existing file. Changing it needs a daemon restart, and every container restarts unless
`live-restore` is on.

```json
{
  "default-address-pools": [ { "base": "10.210.0.0/16", "size": 26 } ]
}
```

- 1024 networks of /26 (62 addresses). A user network holds 3 endpoints, so this is room for ~1000 users, and Docker
  will not fall back to its built-in 172.17–31/16 and 192.168/16 pools.
- It does not collide with 10.30.0.0/16 (VPC), 100.64.0.0/10 (CGNAT), 172.20.0.0/16 (core 172.20.1.0/24, outside
  172.20.2.0/24) or the egress-api subnet 10.254.254.0/29. Those compose networks keep their explicit subnets; the pool
  only feeds networks without one: the provisioner's `pu*`, `control`, and `docker0` unless `bip` is set.
- Before applying, check that nothing routes 10.210/16 elsewhere: `ip route get 10.210.0.1` must say `dev pu…` or the
  default route (no VPN or peering route). Also check that the VPC has no subnet there.
- Validate: `dockerd --validate --config-file /etc/docker/daemon.json`. Existing networks keep their subnets; only new
  ones come from the pool.
- Optional, same file: `"log-driver": "json-file", "log-opts": {"max-size": "10m", "max-file": "3"}`. It caps the
  logs of every container. Harnesses already get this per container from the provisioner and `users/_template.yml`.

## 4. Switching the compose networks (fixed bridge names, edge static IP)

`driver_opts` and `ipam` of an existing network cannot change, so `paddock_core` and `paddock_outside` must be recreated
once. **Every compose network needs a fixed subnet** (the override sets one for core, outside, control and egress-api),
especially when the daemon's pool overlaps them (e.g. a 172.20.0.0/14-like pool). Compose creates networks in parallel,
and one left to the pool can take a subnet another is about to claim. Seen in production: `control` took 172.20.2.0/24,
which `outside` had just freed, and `outside` then failed with "Pool overlaps". Default subnets: core 172.20.1.0/24,
outside 172.20.2.0/24, control 172.20.9.0/24, egress-api 10.254.254.0/29. `docker compose down` would also remove a legacy harness that is in `COMPOSE_FILE` (`add-user.sh` adds
`users/*.yml` there). To keep such a container exactly as it is (same container, same volumes), recreate only the
other services and move the legacy harness across by hand:

```bash
F="-f docker-compose.yml -f docker-compose.provisioner.yml"     # plus your other overlays, NOT users/<legacy>.yml
S="web edge egress provisioner"                                 # every service of the project except legacy harnesses
LEG=harness-legacy                                              # the legacy container name(s)
docker inspect -f '{{json (index .NetworkSettings.Networks "paddock_core").Aliases}}' $LEG   # note its aliases
docker compose -p paddock $F --dry-run up -d $S                 # see what compose would do
docker compose -p paddock $F stop $S && docker compose -p paddock $F rm -f $S
docker network disconnect paddock_core $LEG
docker network rm paddock_core paddock_outside                  # and paddock_egress-api / paddock_control if they exist
docker compose -p paddock $F up -d $S                           # creates pd-core / pd-out / pd-eapi, edge on its static IP
docker network connect --alias $LEG paddock_core $LEG           # repeat --alias for each alias noted above
ip link show pd-core && ip link show pd-out && ip link show pd-eapi
```

- Egress gets its static core address (`PADDOCK_EGRESS_IP`) here; reload `paddock-guard.nft` if you change it.
- The legacy harness is off `core` for the minute in between. Its volumes and container are untouched; it gets a
  dynamic address on the new core (never the edge's static one).
- A later plain `docker compose up -d` (with `COMPOSE_FILE`) may still decide to recreate it because its network
  changed. Check with `--dry-run` first. If it does, it keeps the same named volumes.
- `paddock-u-*` networks are not compose networks and are kept. The provisioner's reconcile loop re-attaches the
  recreated web and egress within `RECONCILE_INTERVAL_MS` (60 s). Networks it created before this change still have
  `br-<hex>` bridges, which rule 2 does not see. The provisioner logs `WARNING … is not on bridge pu…` for them; the
  recreate steps are in `docs/services/provisioner/README.md`.
- Order: daemon.json + docker restart, then br_netfilter, then `paddock-guard`, then this switch, then the gost config
  (`gost.razum.yaml` → `secrets/egress/gost.yaml`; web must use `GOST_API=http://egress-api:18080/api`, which the
  override sets. Over core, rule 3 now drops it).

### Client addresses behind the edge (`TRUSTED_PROXIES`, `TRUSTED_PROXY_HOPS`)

Web keeps `X-Forwarded-For` only from `TRUSTED_PROXIES`: loopback and the edge's static core address (set by the
override from `PADDOCK_EDGE_IP`). From any other peer, every forwarding header is replaced by the TCP peer address.

If a TLS-terminating proxy sits in front of the edge, the edge appends that proxy's address to `X-Forwarded-For`.
Put that address in `TRUSTED_PROXY_HOPS` (`secrets/web.env`, IPs or CIDRs). This is the address the edge sees, i.e.
`$remote_addr` in the edge's access log: `docker compose -p paddock $F logs --tail 20 edge`. Otherwise every user
gets that proxy's address, and they all share one sign-in rate-limit bucket (3 attempts per 10 s). The front proxy
must itself send the client in `X-Forwarded-For` (nginx: `proxy_set_header X-Forwarded-For
$proxy_add_x_forwarded_for;`). If every entry is trusted, better-auth finds no client address and falls back to one
shared bucket per path; it logs "Rate limiting could not determine a client IP" once.

## 5. What is covered where

| path | gost (`gost.razum.yaml`) | host (`paddock-guard.nft`) |
|---|---|---|
| harness → proxy → private literal IP (incl. `::ffff:` forms) | 403 (bypass CIDRs) | rule 1 |
| harness → proxy → container name (`web`, `harness-*`, …) | 403 (bypass names); also not in public DNS | rule 1 if it ever resolved |
| harness → proxy → public name resolving to a private IP (`172.20.1.3.nip.io`, rebinding) | **not covered**: gost checks only the requested name, before DNS | **rule 1** (via outside), **rule 3** (an address on core: egress's static IP), **rule 2** (an address on any user network: egress's MAC), rule 3 (egress-api) |
| harness → proxy → cloud metadata 169.254.169.254 | 403 (literal) | rule 1 (any name) |
| harness → another harness / web or egress on other ports | — | rule 2 (user networks); Docker isolates different internal networks |
| harness → gost API | password only (the top-level `api:` listens everywhere) | rules 2 and 3 (18080 only on pd-eapi) |
| container → host services | — | rule 4 |
