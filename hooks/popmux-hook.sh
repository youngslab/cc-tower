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

# Auto-start daemon when socket is unavailable — it will drain the queue on startup.
# Use an exclusive lock so only one hook fires the start even under parallel invocations.
# The daemon exits silently if another instance already holds the socket (EADDRINUSE).
if [ "$SENT" = "0" ] && command -v flock >/dev/null 2>&1; then
  PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
  POPMUX_BIN=""
  if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/bin/popmux.js" ]; then
    POPMUX_BIN="node $PLUGIN_ROOT/bin/popmux.js"
  elif command -v popmux >/dev/null 2>&1; then
    POPMUX_BIN="popmux"
  fi
  if [ -n "$POPMUX_BIN" ]; then
    DAEMON_LOCK="$QUEUE_DIR/daemon-start.lock"
    mkdir -p "$QUEUE_DIR"
    (
      flock -n 9 || exit 0   # skip if another hook is already starting the daemon
      # shellcheck disable=SC2086
      nohup $POPMUX_BIN --daemon >> "$QUEUE_DIR/daemon.log" 2>&1 &
    ) 9>"$DAEMON_LOCK"
  fi
fi

exit 0
