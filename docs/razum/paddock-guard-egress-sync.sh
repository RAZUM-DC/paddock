#!/bin/bash
# Fill the nft set `inet paddock_guard egress_macs` with the MAC addresses of the egress container on every per-user
# network (Docker gives each endpoint a random MAC, so the host has to learn them). The set is replaced atomically:
# flush + add run as one `nft -f` transaction. Explained in g017-host-firewall.md.
#
#   paddock-guard-egress-sync.sh          sync once (systemd timer, ExecStartPost of paddock-guard.service)
#   paddock-guard-egress-sync.sh watch    sync, then again on every network connect of the egress container
#
# Env: EGRESS_CONTAINER (default paddock-egress), NETWORK_PREFIX (default paddock-u-), NFT_TABLE (inet paddock_guard).
set -uo pipefail
C=${EGRESS_CONTAINER:-paddock-egress}
PREFIX=${NETWORK_PREFIX:-paddock-u-}
TABLE=${NFT_TABLE:-inet paddock_guard}

sync_once() {
  local macs list
  # "<network> <mac>" per endpoint; a missing container gives nothing (the set is then emptied).
  macs=$(docker inspect -f '{{range $n, $e := .NetworkSettings.Networks}}{{$n}} {{$e.MacAddress}}{{"\n"}}{{end}}' "$C" 2>/dev/null |
    awk -v p="$PREFIX" 'BEGIN { h = "[0-9a-f][0-9a-f]"; re = "^" h ":" h ":" h ":" h ":" h ":" h "$" }
      index($1, p) == 1 && tolower($2) ~ re { print tolower($2) }' | sort -u)
  if ! nft list set $TABLE egress_macs >/dev/null 2>&1; then
    echo "paddock-guard-egress-sync: set $TABLE egress_macs not loaded" >&2
    return 1
  fi
  list=$(echo $macs | tr ' ' ',')
  {
    echo "flush set $TABLE egress_macs"
    [ -n "$list" ] && echo "add element $TABLE egress_macs { $list }"
  } | nft -f - || return 1
  echo "paddock-guard-egress-sync: $C on ${PREFIX}*: $(echo $macs | wc -w) MAC(s)"
}

case "${1:-once}" in
  once) sync_once ;;
  watch)
    sync_once
    # Every connect of any container to any network; only those of the egress container trigger a sync (its id can
    # change when compose recreates it, so it is looked up each time).
    docker events --filter type=network --filter event=connect --format '{{.Actor.Attributes.container}}' |
      while read -r cid; do
        [ "$cid" = "$(docker inspect -f '{{.Id}}' "$C" 2>/dev/null)" ] && sync_once
      done
    exit 1 ;;  # docker events ended (daemon restart): let systemd restart the watcher
  *) echo "usage: $0 [once|watch]" >&2; exit 2 ;;
esac
