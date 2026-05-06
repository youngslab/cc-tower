# Changelog

## [2.0.0] — 2026-05-06 (BREAKING)

This release renames cc-tower to popmux and reshapes the entry point
around a popup-first picker. The full-screen Tower mode still exists,
but day-to-day use is via `popmux-go` bound to a tmux key.

### Breaking changes

- **Renamed**: `cc-tower` npm package → `popmux`. CLI entry point
  `cc-tower` → `popmux`. Plugin directory
  `~/.claude/plugins/cc-tower/` → `~/.claude/plugins/popmux/`.
  Config and state directories `~/.config/cc-tower/` →
  `~/.config/popmux/`.
- **Removed**: `peek` command and `[p]` keybinding. The popup picker
  replaces read-only previews — press Enter to jump in directly.
- **Removed**: `_cctower_peek_*` tmux session cleanup, peek hooks,
  `peekingSession` notifier suppression.

### Added

- `popmux --picker --output <path>` — picker mode that emits a
  single-line JSON action and exits, designed for tmux popup usage.
  Supports `--no-cold-start` (read state.json only; first-frame ≈
  50–100 ms) and `--no-summary` (skip live LLM calls).
- `bin/popmux-go` — bash wrapper that runs the picker in a
  display-popup, parses the JSON, and dispatches `go` /`send` / `new`.
- `popmux mirror` — persistent ssh-attach windows in a hidden
  `__popmux_mirrors` tmux session. Subcommands: `--host --pane
  --ssh-target`, `--clean`, `--list`. 30-minute idle TTL,
  per-host advisory lock.
- `popmux migrate` — explicit migration of cc-tower v1 config and
  state into the popmux paths. Idempotent, supports `--force` and
  `--dry-run`.
- `popmux check-ssh [host]` — read-only diagnostic that reports
  missing ControlMaster/ControlPath/ControlPersist settings.
- `popmux spawn` — fork a new local Claude session via tmux
  (remote spawn currently errors out; will land in 2.1).
- `agents.claude` namespace (`src/agents/`) isolating Claude-specific
  detection / status inference / summarization. The agent layer is
  intentionally not behind an interface yet — that abstraction will
  be extracted at the second concrete agent (codex / gemini).

### Changed

- HookReceiver now binds **both** `popmux.sock` (new) and
  `cc-tower.sock` (legacy). Both feed the same SessionStateMachine.
  The legacy listener will be removed in v2.1.0 (≈ 14 days).
- `state.json` v3 schema gains an optional `agentId` field
  (default `"claude"`) on every session entry. Always written, even
  for the default value.
- Tower constructor accepts `{ skipHooks, skipColdStart, skipSummary,
  readOnly }` for picker-mode usage.
- All internal tmux session/window prefixes consolidated under
  `__popmux_*`: `__popmux_playground`, `__popmux_llm_<id>`,
  `__popmux_go_*`, `__popmux_mirrors`.

### Compatibility

- **Hook socket**: `cc-tower.sock` listener stays for **14 days**
  after release. Re-run `popmux install-hooks` to switch live
  sessions to `popmux.sock`.
- **npm package**: `cc-tower` is published as a deprecated stub for
  **6 months** that prints "Renamed to popmux — npm i -g popmux"
  and exits 1.
- **Brew / AUR / other distros**: not currently published.
- **State schema**: v3 (no version bump). Optional `agentId`
  (default `"claude"`) is read-side backward-compatible.

### Migration

See [MIGRATION.md](./MIGRATION.md). Short version:

```bash
npm i -g popmux
popmux migrate
popmux install-hooks
```

Then in `~/.tmux.conf`:

```
bind-key Space run-shell 'popmux-go'
```

---

## [1.1.1] — 2026-04

(Last cc-tower release; see git history for changes prior to 2.0.)
