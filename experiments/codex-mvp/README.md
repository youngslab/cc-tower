# Codex MVP probe

Standalone local-only prototype for validating whether popmux can support OpenAI Codex CLI sessions before merging the feature into the main Claude-shaped core.

## Commands

```bash
npm run codex:mvp -- list
npm run codex:mvp -- list --json
npm run codex:mvp -- go <pane|pid|sessionId|cwd-substring>
npm run codex:mvp -- send <pane|pid|sessionId|cwd-substring> "continue"
```

## What it proves

- Running interactive native `codex` processes can be found without a SQLite dependency.
- `codex exec`, `codex review`, and other non-interactive forms are skipped.
- A native Codex child can be associated with its `node /usr/bin/codex` wrapper.
- Existing tmux process-tree/pane ideas are sufficient: the prototype maps native Codex PIDs to panes by walking mocked/live PPID + TTY data.
- Live navigation and send can be implemented with the same tmux primitives popmux already uses.

## Intentional limitations

- No remote Codex support.
- No Codex hook installation.
- No rich summaries or reliable thread IDs when Codex was not launched through `codex resume <id>`.
- No dependency on `~/.codex/state_5.sqlite`; SQLite can be evaluated later behind an adapter if stable resume metadata becomes necessary.

## Merge sketch

If this probe remains reliable, move the detector into `src/agents/codex/`, add an `agentId` seam, and have `DiscoveryEngine` merge Claude adapter sessions with Codex adapter sessions. The current fallback `codex-proc-<pid>` ID is enough for live jump/send; resume should only be enabled when a real thread ID is known.
