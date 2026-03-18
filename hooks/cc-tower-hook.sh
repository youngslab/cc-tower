#!/bin/sh
# Read stdin JSON from Claude Code hooks (contains session_id, tool_name, etc.)
CONTEXT=$(cat)
SOCKET="${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock"

# Extract session_id from stdin JSON (Claude Code provides this in all hook events)
SID=$(printf '%s' "$CONTEXT" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
SID="${SID:-unknown}"

PAYLOAD="{\"event\":\"$1\",\"sid\":\"$SID\",\"cwd\":\"$PWD\",\"ts\":$(date +%s%3N)}"

if command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" 2>/dev/null
elif command -v nc >/dev/null 2>&1; then
  printf '%s\n' "$PAYLOAD" | nc -U "$SOCKET" 2>/dev/null
elif command -v node >/dev/null 2>&1; then
  node -e "require('net').createConnection(process.argv[1],function(){this.write(process.argv[2]+'\n');this.end()})" "$SOCKET" "$PAYLOAD" 2>/dev/null
fi
exit 0
