# Migrating from cc-tower v1.x to popmux v2.0

popmux v2.0 is a major rewrite of cc-tower. The CLI is renamed and the
UX is popup-first. Your data and sessions can move forward — read on.

## Why renamed?

cc-tower started as a Claude-specific dashboard. popmux generalises it:
the agent module (`src/agents/`) is being prepared for Claude, OpenAI
Codex CLI, and Google Gemini CLI. The new name is agent-neutral.

## What's removed

### Peek

v1.x had a `peek` command and `[p]` keybinding that opened a read-only
popup of a session. v2.0 removes Peek entirely. The popup picker now
*replaces* the dashboard, and Enter jumps you straight in — no
intermediate read-only step is needed. If you miss read-only, run
`tmux attach -r -t <session>` directly.

### TUI as primary

The full-screen Tower TUI (run `popmux` with no flags) is still
available, but the popup picker is now the recommended entry point.

## What's new

- `popmux --picker --output <tmpfile>` — popup-friendly picker
- `popmux mirror` — persistent remote SSH attach windows
- `popmux check-ssh` — read-only ControlMaster diagnostics
- `popmux migrate` — explicit migration from cc-tower
- `popmux-go` — bash wrapper that ties it all together

## Migration steps

```bash
# 1. Install popmux globally (cc-tower v1 stays as-is)
npm i -g popmux

# 2. Move config + state from cc-tower → popmux (explicit, not magical)
popmux migrate              # dry-run first if you want: --dry-run
popmux migrate --force      # if you've already started using popmux

# 3. Disable the v1 Claude Code plugin and install the v2 hook
popmux install-hooks
# This renames ~/.claude/plugins/cc-tower/plugin.json
# to plugin.json.disabled and writes the new plugin to
# ~/.claude/plugins/popmux/.

# 4. Update your tmux keybinding (if you had one for cc-tower)
# In ~/.tmux.conf:
#   unbind-key g
#   bind-key Space run-shell 'popmux-go'
```

## Compatibility windows

- **Hook socket dual-listen — 14 days from install.** popmux listens
  on both `popmux.sock` (new) and `cc-tower.sock` (legacy). After
  re-running `popmux install-hooks` your live Claude sessions emit
  events to the new socket. The legacy listener will be removed in
  v2.1.0 (approximately 14 days after the v2.0.0 release).

- **Deprecated `cc-tower` npm package — 6 months.** A stub package
  publishes alongside popmux that prints `Renamed to popmux — run
  npm i -g popmux` and exits 1 when invoked. The stub will be
  unpublished after 6 months.

- **Brew / AUR / other distros.** Not currently published.

## Troubleshooting

### "popmux migrate refuses to run"

This means `~/.config/popmux/` already has data and the migration
marker is missing. Run `popmux migrate --force` to overwrite, or
inspect both directories first.

### "v1 sessions don't show up after upgrade"

Your v1 hook is still pointing at `cc-tower.sock` (which is fine for
14 days). Run `popmux install-hooks` to disable the v1 plugin and
re-fire hooks against `popmux.sock`. Active sessions need to restart
once for the new hook to take effect.

### "Remote SSH jumps stall on first attempt"

You probably don't have ControlMaster configured. Run
`popmux check-ssh <host>` to see what's missing, then add the
suggested block to `~/.ssh/config`.

### "I want my Peek back"

popmux doesn't include Peek; the popup picker replaced its role. If
you really need read-only attach, the simplest workaround is
`tmux switch-client -r -t <pane>` outside popmux.

## Rolling back

cc-tower v1 is unaffected by anything popmux does — the only mutation
to your home directory is the rename of `~/.claude/plugins/cc-tower/
plugin.json` to `plugin.json.disabled`. Restore it manually if you
want to roll back.
