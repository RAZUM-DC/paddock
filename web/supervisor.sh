#!/bin/bash
# Супервизор морды: собирает /src в отдельную папку, переключает только рабочую сборку, при провале откатывает.
# Codex просит выкатку записью в /src/.deploy-request; результат пишется в /src/.deploy-status.
# SELF_DEPLOY=0: build once at start (or keep the existing build), never rebuild on request — the UI cannot redeploy itself.
set -uo pipefail

SRC=/src
BUILDS=/build
CURRENT=$BUILDS/current
STATUS=$SRC/.deploy-status
REQ=$SRC/.deploy-request
PID=""

log() { echo "[supervisor $(date -u +%H:%M:%S)] $*"; }
status() { echo "$(date -u +%FT%TZ) $*" > "$STATUS"; log "$*"; }

start() {
  (cd "$CURRENT" && exec node_modules/.bin/tsx server.ts) &
  PID=$!
}

stop() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null && wait "$PID" 2>/dev/null
  PID=""
}

healthy() {
  for _ in $(seq 1 45); do
    curl -fs -o /dev/null http://127.0.0.1:3000/login && return 0
    kill -0 "$PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

build() {
  local dir="$BUILDS/b-$(date +%s)"
  status "building $dir"
  rsync -a --delete --exclude node_modules --exclude .next --exclude '.deploy-*' "$SRC/" "$dir/"
  if ! (cd "$dir" && npm ci --include=dev --no-audit --no-fund && npm run build) > "$dir.log" 2>&1; then
    status "build FAILED, still serving $(readlink "$CURRENT"); log: $(tail -c 1500 "$dir.log")"
    rm -rf "$dir"
    return 1
  fi

  local prev
  prev=$(readlink "$CURRENT" || true)
  ln -sfn "$dir" "$CURRENT"
  stop
  start
  if healthy; then
    status "deployed $dir"
    # Оставляем текущую и одну предыдущую сборку.
    ls -1d "$BUILDS"/b-* 2>/dev/null | grep -v -e "^$dir$" -e "^${prev:-none}$" | grep -v '\.log$' | xargs -r rm -rf
    find "$BUILDS" -maxdepth 1 -name 'b-*.log' -mtime +2 -delete
    return 0
  fi

  if [ -n "$prev" ]; then
    ln -sfn "$prev" "$CURRENT"
    stop
    start
    status "new build did not come up, rolled back to $prev"
  else
    status "new build did not come up and there is nothing to roll back to"
  fi
  return 1
}

trap 'stop; exit 0' TERM INT

if [ -e "$CURRENT" ]; then start; healthy || build; else build; fi
last=$(cat "$REQ" 2>/dev/null || true)

while true; do
  sleep 5
  req=$(cat "$REQ" 2>/dev/null || true)
  if [ "$req" != "$last" ] && [ "${SELF_DEPLOY:-1}" = "0" ]; then
    last=$req
    status "deploy request ignored: SELF_DEPLOY=0"
  elif [ "$req" != "$last" ]; then
    last=$req
    build
  elif [ -e "$CURRENT" ] && ! kill -0 "$PID" 2>/dev/null; then
    log "server exited, restarting"
    start
  fi
done
