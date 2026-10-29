#!/bin/sh
set -e
# Базовый конфиг кладём только при первом запуске: дальше config.toml живёт на томе и правится руками или самим codex.
[ -f "$CODEX_HOME/config.toml" ] || cp /opt/codex/config.toml "$CODEX_HOME/config.toml"
exec "$@"
