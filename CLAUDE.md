# cc-tower Development Guidelines

## Verification-First Development

Every implementation MUST have a verification method that Claude can execute directly.
If direct verification is not possible, report to the user with clear instructions for manual testing.

### Verification Tiers

| Tier | Method | Example |
|------|--------|---------|
| **1. Automated** | Unit test (`npx vitest run`) | JSONL parser, state machine, summarizer |
| **2. CLI** | Run CLI command + check output | `LOG_LEVEL=error cc-tower list` |
| **3. Headless** | Script that starts Tower, waits, checks state | Cold start, LLM summary, session discovery |
| **4. Manual (report to user)** | Cannot automate — describe what to test | TUI dashboard, Peek popup, keyboard input |

### Before claiming "done":

```bash
# 1. TypeScript compiles
npx tsc --noEmit

# 2. All tests pass
npx vitest run

# 3. CLI works
LOG_LEVEL=error npx tsx src/index.tsx list

# 4. If TUI changed: tell user to run `npx tsx src/index.tsx` and verify
```

### Tier 4 Reporting Template

When a change requires manual verification, report:

```
Manual test needed:
1. Run: npx tsx src/index.tsx
2. Expected: [describe what should appear]
3. Action: [describe what to do]
4. Expected result: [describe expected outcome]
```

## Self-Diagnosis via Logs

Use `LOG_LEVEL=debug` to diagnose issues without user intervention:

```bash
# Debug session discovery
LOG_LEVEL=debug npx tsx src/index.tsx list 2>&1 | grep "discover\|register\|session"

# Debug LLM summarization
LOG_LEVEL=debug npx tsx src/index.tsx list 2>&1 | grep "summary\|context\|llm"

# Debug state tracking
LOG_LEVEL=debug npx tsx src/index.tsx list 2>&1 | grep "state\|transition\|hook"

# Headless test with timeout (for background features)
cat > /tmp/test-tower.ts << 'EOF'
import { Tower } from './src/core/tower.js';
const tower = new Tower();
await tower.start();
await new Promise(r => setTimeout(r, 15000));
for (const s of tower.store.getAll()) {
  console.log(`${s.projectName}: status=${s.status} summary="${s.contextSummary ?? 'none'}"`);
}
process.exit(0);
EOF
LOG_LEVEL=debug npx tsx /tmp/test-tower.ts 2>/tmp/debug.log
grep "error\|warn\|fail" /tmp/debug.log
```

## Build & Publish

```bash
# Build (TypeScript → dist/)
npx tsc

# Test
npx vitest run

# Publish to npm (see memory/reference_npm_publish.md)
npx tsc && npm publish
```

## Git Push Rules

- Remote uses SSH alias `github-youngslab` (configured in `~/.ssh/config`)
- Before push, amend author to: `Jaeyoung Park <jaeyoungs.park@gmail.com>`
- Remote URL: `git@github-youngslab:youngslab/cc-tower.git`

## Project Structure

- `src/` — TypeScript source (ESM-only, ink v5 + React)
- `dist/` — Compiled JS (committed to git for npm install)
- `bin/cc-tower.js` — Entry point (imports dist/index.js)
- `hooks/` — Claude Code hook plugin files
- `test/` — Vitest tests
- `doc/` — Architecture and algorithm documentation

## Documentation

- [`doc/algorithms.md`](./doc/algorithms.md) — State machine, discovery, JSONL inference, LLM summarization 등 핵심 알고리즘 레퍼런스

## Key Patterns

- **ESM-only**: `"type": "module"` in package.json, `.js` extensions in imports
- **Non-blocking**: Use `spawn('sh', ['-c', ...])` for async shell commands, never `execSync` in UI path
- **State tracking**: Hook (primary) → JSONL fs.watch (fallback) → Process scan (tertiary)
- **Session discovery**: `~/.claude/sessions/*.json` if available, else process scan + CWD matching
- **LLM summarization**: `claude --print` via `spawn`, parallel, cached in state.json
- **tmux interaction**: All commands via `execa('tmux', [...])` wrapper in `src/tmux/commands.ts`
