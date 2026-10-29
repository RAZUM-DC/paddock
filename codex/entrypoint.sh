#!/bin/sh
set -e
# The base config is copied only on first start: after that config.toml lives on the volume and is edited by hand or by codex.
# PADDOCK_CONFIG_PREPEND / PADDOCK_CONFIG_APPEND (set by the provisioner, optional) seed it once: top-level keys such as
# model_provider go before the base config, [model_providers.*] and [mcp_servers.*] tables after it.
if [ ! -f "$CODEX_HOME/config.toml" ]; then
  tmp="$CODEX_HOME/config.toml.tmp"
  : > "$tmp"
  if [ -n "${PADDOCK_CONFIG_PREPEND:-}" ]; then printf '%s\n\n' "$PADDOCK_CONFIG_PREPEND" >> "$tmp"; fi
  cat /opt/codex/config.toml >> "$tmp"
  if [ -n "${PADDOCK_CONFIG_APPEND:-}" ]; then printf '\n%s\n' "$PADDOCK_CONFIG_APPEND" >> "$tmp"; fi
  mv "$tmp" "$CODEX_HOME/config.toml"
fi
unset PADDOCK_CONFIG_PREPEND PADDOCK_CONFIG_APPEND
# Approval rules for destructive commands are Paddock's, so they are refreshed on every start.
mkdir -p "$CODEX_HOME/rules"
cp /opt/codex/paddock.rules "$CODEX_HOME/rules/paddock.rules"
exec "$@"
