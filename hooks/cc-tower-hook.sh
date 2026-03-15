#!/bin/sh
CONTEXT=$(cat)
SOCKET="${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock"
PAYLOAD=$(printf '{"event":"%s","sid":"%s","cwd":"%s","ts":%s,"context":%s}\n' \
  "$1" "${CLAUDE_SESSION_ID:-unknown}" "$PWD" "$(date +%s%3N)" "${CONTEXT:-null}")

if command -v socat >/dev/null 2>&1; then
  echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" 2>/dev/null
elif command -v nc >/dev/null 2>&1; then
  echo "$PAYLOAD" | nc -U "$SOCKET" 2>/dev/null
fi
exit 0
