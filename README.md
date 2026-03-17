# cc-tower

Claude Code Session Control Tower — monitor and interact with multiple Claude Code sessions in tmux.

## Dashboard Preview

```
cc-tower — 5 sessions
   PANE  LABEL            STATUS    TASK
1  %3   migration-api    ● EXEC    bash: npm test
2  %5   frontend-dash    ◐ THINK   "Add tooltip component..."
3  %7   auth-refactor    ○ IDLE    ✓ Token refresh implemented
─────────────────────────────────────────────────── (monitor-only)
4  —    vscode-session   ◐ THINK   Refactoring database layer
5  —    ssh-dev          ○ IDLE    ✓ Deployment complete

[j/k] Navigate  [1-9] Jump  [Enter] Detail  [p] Peek  [/] Send  [q] Quit
```

## Features

- **Auto-discovery** — Detects Claude Code sessions automatically from `~/.claude/sessions/`
- **Real-time state tracking** — Monitors session status (idle/thinking/executing/agent) via Claude Code hooks or JSONL fallback
- **TUI dashboard** — Terminal UI showing all sessions with status, task, and progress
- **LLM summaries** — Intelligent turn summaries describing what Claude is actually working on
- **Desktop notifications** — Alerts when sessions idle, error, or complete
- **Send/Peek** — Send commands to sessions or peek at their output from the dashboard
- **Remote ready** — SSH socket forwarding support for remote session monitoring (Phase 1.5)
- **Flexible configuration** — YAML config for notifications, dashboard behavior, and more

## Requirements

- **Node.js 22+** with npm
- **tmux 3.2+** (for full interactivity; monitor-only works without tmux)
- **Claude Code** (installed and configured)
- **macOS/Linux** (tested on Linux; macOS support pending)

Optional but recommended:
- `socat` or `nc` (netcat) for faster hook delivery

## Installation

```bash
npm install -g https://github.com/youngslab/cc-tower/releases/download/v1.5.0/cc-tower-1.0.0.tgz
```

> If you get a permission error, either use [nvm](https://github.com/nvm-sh/nvm)/[fnm](https://github.com/Schniz/fnm) (recommended)
> or run `npm config set prefix ~/.local` and ensure `~/.local/bin` is in your PATH.

### Alternative: Clone and run directly

```bash
git clone https://github.com/youngslab/cc-tower.git
cd cc-tower
npm install
npm link
```

After any option, `cc-tower` is available as a command from anywhere.

### 3. Install Hook Plugin

The hook plugin enables real-time state updates. Install it once:

```bash
cc-tower install-hooks
```

This creates `~/.claude/plugins/cc-tower/` with hook definitions. New Claude Code sessions will immediately report state changes to cc-tower.

**Note:** Already-running sessions will fall back to JSONL polling until restarted.

## Usage

### TUI Dashboard (Default)

Launch the interactive dashboard:

```bash
cc-tower
```

The dashboard displays all active Claude Code sessions with real-time status updates. See keybindings below.

### List Sessions

Show all sessions in table format:

```bash
cc-tower list
```

Export as JSON:

```bash
cc-tower list --json
```

### Send Command to Session

Send a message or command to a running session:

```bash
cc-tower send <session> "message"
```

Where `<session>` can be:
- Pane ID: `%5`
- Session ID prefix: `9445bc28` (first 8 chars)
- Custom label: `migration-api`

Example:

```bash
cc-tower send migration-api "npm test -- --watch"
```

### Peek at Session

Open a read-only popup view of a session's output:

```bash
cc-tower peek <session>
```

Press `prefix + d` (default: `Ctrl-b d`) to close the popup and return to the dashboard.

### Label a Session

Assign a human-readable name:

```bash
cc-tower label 9445bc28 "feature-branch"
```

### Tag Sessions

Add custom tags for organization:

```bash
cc-tower tag migration-api backend important
```

### View Status

Quick status check:

```bash
cc-tower status
```

Show details for one session:

```bash
cc-tower status migration-api
```

### Manage Configuration

Edit the config file in your default editor:

```bash
cc-tower config
```

Config location: `~/.config/cc-tower/config.yaml`

## Keybindings

Dashboard navigation and controls:

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `1-9` | Jump to session N |
| `Enter` | View session details |
| `/` | Send command to session |
| `p` | Peek at session output |
| `q` / `Ctrl-C` | Quit with confirmation |

## Configuration

Config file: `~/.config/cc-tower/config.yaml`

Create one to customize behavior. Example:

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
  suppress_when_focused: true  # quiet if cc-tower has focus
  channels:
    desktop: true              # system notifications
    tmux_bell: true            # tmux bell
    sound: false               # audio alert
  alerts:
    on_error: true
    on_cost_threshold: 5.0     # USD
    on_session_death: true
  quiet_hours:
    enabled: false
    start: "23:00"
    end: "07:00"

commands:
  confirm_before_send: true    # confirm when sending to session
  confirm_when_busy: true      # confirm if session is thinking/executing

# SSH Remote hosts
hosts:
  - name: server-a
    ssh: user@192.168.1.10
    hooks: true                # SSH socket forwarding for real-time events
    # ssh_options: "-i ~/.ssh/id_rsa -p 2222"
    # claude_dir: "~/.claude"  # custom path if non-standard
  - name: dev-box
    ssh: user@dev.example.com
    hooks: false               # JSONL polling fallback (no remote install needed)
```

## SSH Remote Sessions

Monitor Claude Code sessions running on remote servers from your local dashboard.

### Setup

1. Add hosts to `~/.config/cc-tower/config.yaml` (see above)
2. Ensure SSH key-based auth works: `ssh user@host "echo ok"`
3. (Optional) Install hooks on remote for real-time tracking:

```bash
cc-tower install-hooks --remote server-a
```

### Two Modes

| Mode | Config | Latency | Remote Install |
|------|--------|---------|----------------|
| **Socket forwarding** | `hooks: true` | ~50ms (real-time) | Required (`install-hooks --remote`) |
| **JSONL polling** | `hooks: false` | ~3s (polling) | Not needed |

### How It Works

```
Local (cc-tower TUI)
  ├─ SSH tunnel (-R) ──→ Remote: hooks → socket → tunnel → local cc-tower
  ├─ SSH poll ──────────→ Remote: cat ~/.claude/sessions/*.json
  ├─ SSH JSONL tail ───→ Remote: tail -c 262144 session.jsonl
  ├─ Peek: display-popup → ssh -t host "tmux attach"
  └─ Send: ssh host "tmux send-keys -t %5 'text' Enter"
```

Remote sessions appear in the dashboard with a HOST column:

```
   #  HOST      PANE  LABEL           STATUS    TASK
   1  local     %7    cc-session      ● EXEC    ...
   2  local     %5    obsidian        ○ IDLE    ...
   3  server-a  %3    api-backend     ◐ THINK   ...
   4  dev-box   %1    ml-pipeline     ● EXEC    ...
```

## Architecture

cc-tower combines multiple signals to provide semantic awareness:

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
TUI Dashboard (Ink + React)
    ├─ Dashboard view (session list with HOST column)
    ├─ Detail view (session info + recent activity)
    ├─ Send view (local tmux send-keys or SSH)
    └─ Peek (local session group or SSH tmux attach)
```

**Key Design Principles:**

- **No persistent daemon** — cc-tower runs only when the TUI is active
- **Hook-primary architecture** — Hooks deliver real-time updates; JSONL/process are fallbacks
- **Monitor-only graceful degradation** — Sessions run outside tmux are still tracked but don't support Peek/Send
- **Cold start recovery** — On startup, reads `~/.claude/sessions/` and JSONL files to restore current state

## Roadmap

| Phase | Status | Features |
|-------|--------|----------|
| **Phase 1** | ✓ Complete | Local MVP: auto-discovery, TUI, hooks, JSONL fallback, Send/Peek |
| **Phase 1.5** | ✓ Complete | SSH remote: socket forwarding, remote Peek/Send, multi-host dashboard |
| **Phase 2** | Future | Web UI: browser dashboard, team collaboration, cost tracking, analytics |

## License

MIT

## Support

For issues, questions, or feature requests, open an issue on GitHub or check the PRD.md for detailed technical specifications.
