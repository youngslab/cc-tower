# Codex MVP merge assessment

## Verdict

Merge is feasible, but the prototype should be merged as an adapter-backed local MVP rather than pasted into the Claude-specific core.

## Evidence from the standalone MVP

- Live process discovery works without adding a dependency: `ps -eo pid=,ppid=,tty=,comm=,args=` is enough to find native interactive `codex` processes.
- Duplicate avoidance is straightforward: list only native `codex` children and keep the `node /usr/bin/codex` wrapper as metadata.
- Non-interactive filtering is testable: `exec`, `review`, `mcp`, `completion`, `help`, `--help`, and version invocations are excluded.
- Existing tmux strategy transfers: Codex child -> wrapper/shell ancestor -> tmux pane can be resolved by PID chain or TTY.
- Live `npm run codex:mvp -- list --json` found local Codex sessions across multiple workspaces and mapped them to tmux pane ids.

## Recommended merge plan

1. Move `experiments/codex-mvp/discover.ts` into `src/agents/codex/detector.ts`.
2. Add a minimal `agentId: 'claude' | 'codex'` model seam while defaulting missing legacy values to `claude`.
3. Rename/comment `mapPidToPane(claudePid)` generically and reuse it for Codex instead of maintaining duplicate pane logic.
4. Update `DiscoveryEngine` to merge Claude session files with Codex live process sessions.
5. Update picker action JSON, dashboard labels, and send/go flows to preserve `agentId`.
6. Enable spawn/resume separately:
   - spawn: `codex -C <cwd>`;
   - resume: only `codex resume <threadId> -C <cwd>` when a real thread id is known.

## Do not merge yet

- SQLite reading of `~/.codex/state_5.sqlite`; the MVP proves it is not needed for live jump/send.
- Remote Codex support.
- Codex hooks.
- Rich Codex summaries or next-step inference.

## Risks to handle during merge

- Fallback `codex-proc-<pid>` session ids are live-only; do not use them for resume.
- Linux `/proc` and `ps` assumptions match current deployment, but macOS support would need a different cwd/ppid reader.
- The current app has Claude names hardcoded in CLI descriptions, tmux session names, and remote paths; keep the first merge narrowly focused to avoid a broad rename/refactor.
