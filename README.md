# popmux

> Multi-agent tmux session picker for AI coding sessions

## What is popmux?

popmux is a popup-first picker for browsing and switching between AI
coding agent sessions (currently Claude Code; codex/gemini support
planned) running in local and remote tmux servers. Press a key, see
all your sessions, jump straight in.

```
prefix + Space  →  popmux popup
                   ┌──────────────┐
                   │ ● local-1    │  Enter — jump to that session
                   │ ○ local-2    │  /     — send a message
                   │ ◐ remote-A   │  q     — cancel
                   └──────────────┘
```

## Quick Start

```bash
npm i -g popmux
popmux install-hooks
```

In your `~/.tmux.conf`:

```tmux
bind-key Space run-shell 'popmux-go'
```

That's it. `prefix + Space` opens the popup; pressing Enter switches
the client to the highlighted session.

## Why popup-first?

popmux is designed to be invoked dozens of times a day. The previous
generation (cc-tower v1) ran a full-screen TUI that took 1–2s to start.
popmux's `--no-cold-start` mode reads `state.json` only and reaches
first frame in ~50–100 ms — even on the smallest popup.

The wrapper does the orchestration:
1. tmux opens a popup running `popmux --picker --output <tmpfile>`
2. The picker writes a single-line JSON action to the tmpfile and exits
3. The wrapper reads the JSON and dispatches:
   - `go` → `tmux switch-client` (local) or `popmux mirror` (remote)
   - `send` → `popmux send`
   - `new` → `popmux spawn`

## Architecture

popmux is organized in three layers:

```
┌─────────────────────────────────────────────────────┐
│  Picker (popmux --picker --output <file>)           │
│  Ink/React TUI — renders session list, writes JSON  │
└────────────────────┬────────────────────────────────┘
                     │ JSON action file
┌────────────────────▼────────────────────────────────┐
│  Wrapper (popmux-go)                                │
│  Bash — opens tmux popup, reads action, dispatches  │
└────────────────────┬────────────────────────────────┘
                     │ CLI calls
┌────────────────────▼────────────────────────────────┐
│  Orchestrator (popmux mirror / send / spawn)        │
│  Node — manages mirror windows, SSH, state          │
└─────────────────────────────────────────────────────┘
```

Session discovery feeds state into the picker:

```
Session Discovery
    ├─ Local: PID scan + process CWD → project matching
    └─ Remote: SSH polling (cat ~/.claude/sessions/*.json)
    ↓
State Machine (Hook-Primary)
    ├─ Primary: Claude Code hooks (Unix socket, local or SSH-tunneled)
    ├─ Fallback: JSONL polling (local fs.watch or SSH tail)
    └─ Fallback: Process scanning (local only)
    ↓
Session Store (in-memory cache with file persistence)
    ↓
Picker / TUI Dashboard (Ink + React)
```

## Multi-agent

popmux currently supports Claude Code only. The agent layer
(`src/agents/`) is intentionally not behind an interface yet — the
abstraction will be extracted when codex / gemini get their first
implementation (2-instances rule). For now `agents.claude` is the
only namespace.

## Remote SSH sessions

popmux discovers tmux/Claude sessions on remote hosts via SSH. When
you press Enter on a remote session, popmux creates a persistent
*mirror window* in a hidden `__popmux_mirrors` tmux session and runs
`ssh -t target tmux attach -t %paneId` inside it. The next press on
the same target reuses the open ssh — so you get O(1) jump cost after
the first connect.

### ControlMaster (recommended)

Add to `~/.ssh/config`:

```
Host *
  ControlMaster auto
  ControlPath ~/.ssh/cm-%r@%h:%p
  ControlPersist 10m
```

This drops new ssh handshakes to a few milliseconds. `popmux check-ssh`
reads your config (read-only) and reports any missing settings.

## Comparison

`claude-tmux` (Rust) is the closest cousin. Both render a popup and
both let you jump into Claude sessions; popmux differs in:

- Multi-agent abstraction (claude only today, codex/gemini wired up)
- Remote SSH-attached sessions with persistent mirror windows
- Picker / wrapper / orchestrator separation (Rust binary picker
  is feasible but not necessary)
- Tower mode for full-screen monitoring is still available
  (`popmux` with no flags)

## Requirements

- **Node.js 22+** with npm
- **tmux 3.2+**
- **Claude Code** (installed and configured)
- **macOS/Linux** (tested on Linux; macOS support pending)

Optional but recommended:
- `socat` or `nc` (netcat) for faster hook delivery

## Commands

| Command | Purpose |
|---|---|
| `popmux` | Full TUI dashboard |
| `popmux --picker --output <path>` | Picker mode (used by popmux-go) |
| `popmux list [--json]` | Print sessions to stdout |
| `popmux send <session> <message>` | Send a message to a session |
| `popmux spawn --cwd <p> [--host <h>] [--ssh-target <t>] [--resume <id>]` | Spawn a new claude session |
| `popmux mirror --host <h> --pane <p> --ssh-target <t>` | Manage remote mirror windows |
| `popmux mirror --clean` / `--list` | Mirror maintenance |
| `popmux migrate` | Migrate from `~/.config/cc-tower/` |
| `popmux install-hooks [--remote <host>]` | Install Claude Code hooks |
| `popmux check-ssh [<host>]` | Diagnose SSH ControlMaster setup |

## Configuration

Config file: `~/.config/popmux/config.yaml`
State file: `~/.config/popmux/state.json`

Example config:

```yaml
discovery:
  scan_interval: 2000          # ms between session scans
  auto_discover: true          # auto-detect new sessions

tracking:
  jsonl_watch: true            # watch JSONL files
  process_scan_interval: 5000  # ms between process checks

dashboard:
  refresh_rate: 1000           # TUI update interval (ms)
  default_sort: status         # or: project, name, activity
  show_cost: true              # show estimated token costs
  show_dead: false             # hide completed sessions

notifications:
  enabled: true
  min_duration: 30             # don't notify for quick tasks (seconds)
  cooldown: 30                 # min seconds between alerts
  suppress_when_focused: true  # quiet if popmux has focus
  channels:
    desktop: true              # system notifications
    tmux_bell: true            # tmux bell
    sound: false               # audio alert
  alerts:
    on_error: true
    on_cost_threshold: 5.0     # USD
    on_session_death: true

commands:
  confirm_before_send: true    # confirm when sending to session
  confirm_when_busy: true      # confirm if session is thinking/executing

# SSH Remote hosts
hosts:
  - name: server-a
    ssh: user@192.168.1.10
    hooks: true                # SSH socket forwarding for real-time events
  - name: dev-box
    ssh: user@dev.example.com
    hooks: false               # JSONL polling fallback (no remote install needed)
```

## Migrating from cc-tower v1.x

popmux is the successor to cc-tower. See [MIGRATION.md](./MIGRATION.md)
for the upgrade path: install popmux, run `popmux migrate`, then
`popmux install-hooks` to disable the v1 plugin and switch to the new
socket. The legacy `cc-tower.sock` is still listened on for 14 days
so v1 hook deliveries don't get lost.

## Manual test checklist

1. `bind-key Space run-shell popmux-go` after reload → Space opens popup
2. Local session Enter → immediate jump to that session
3. Remote session Enter → mirror window created + ssh connected
4. Second jump to same remote → mirror reused (no new ssh handshake)
5. `prefix + d` from mirror window then re-jump → cleanup and recreate
6. Two tmux clients attach same mirror → status-line `[shared mirror]` warning shown
7. `/` in picker → single-line prompt → message delivered to session
8. Run `popmux` outside tmux → clear error or dashboard fallback
9. Session with v1 hook installed → tracked via cc-tower.sock (14-day window)
10. After `popmux install-hooks` → stderr shows legacy plugin disabled notice

## Roadmap

- [ ] Codex CLI agent
- [ ] Gemini CLI agent
- [ ] Standalone Rust picker binary for sub-50ms cold start
- [ ] Web dashboard

## License

MIT
