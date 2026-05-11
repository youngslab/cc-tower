#!/bin/sh
# Read stdin JSON from Claude Code hooks (contains session_id, tool_name, etc.)
CONTEXT=$(cat)
SOCKET="${XDG_RUNTIME_DIR:-/tmp}/popmux.sock"
QUEUE_DIR="${XDG_RUNTIME_DIR:-/tmp}/popmux"
QUEUE="$QUEUE_DIR/hook-queue.jsonl"

# Extract session_id from stdin JSON (Claude Code provides this in all hook events)
SID=$(printf '%s' "$CONTEXT" | sed -n 's/.*"session_id" *: *"\([^"]*\)".*/\1/p' | head -1)
SID="${SID:-unknown}"
PANE="${TMUX_PANE:-}"

PAYLOAD="{\"v\":1,\"event\":\"$1\",\"sid\":\"$SID\",\"cwd\":\"$PWD\",\"pane\":\"$PANE\",\"pid\":$PPID,\"ts\":$(date +%s%3N)}"

SENT=0
if command -v socat >/dev/null 2>&1; then
  printf '%s\n' "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCKET" 2>/dev/null && SENT=1
fi
if [ "$SENT" = "0" ] && command -v nc >/dev/null 2>&1; then
  printf '%s\n' "$PAYLOAD" | nc -U "$SOCKET" 2>/dev/null && SENT=1
fi
if [ "$SENT" = "0" ] && command -v node >/dev/null 2>&1; then
  node -e "require('net').createConnection(process.argv[1],function(){this.write(process.argv[2]+'\n');this.end()})" "$SOCKET" "$PAYLOAD" 2>/dev/null && SENT=1
fi

# Fallback: append to queue file with shared lock (parallel-safe, no socket receiver needed)
if [ "$SENT" = "0" ] && command -v flock >/dev/null 2>&1; then
  mkdir -p "$QUEUE_DIR"
  (
    flock -s 9
    printf '%s\n' "$PAYLOAD" >> "$QUEUE"
  ) 9>"$QUEUE.lock"
fi

exit 0
