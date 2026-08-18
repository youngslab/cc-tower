# popmux Development Guidelines

## Verification-First Development

Every implementation MUST have a verification method that Claude can execute directly.
If direct verification is not possible, report to the user with clear instructions for manual testing.

### Verification Tiers

| Tier | Method | Example |
|------|--------|---------|
| **1. Automated** | Unit test (`npx vitest run`) | JSONL parser, state machine, summarizer |
| **2. CLI** | Run CLI command + check output | `LOG_LEVEL=error popmux list` |
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

## Version Strategy

**현재 버전: 2.7.6**

### 규칙: 코드 변경 시 반드시 버전을 올려야 한다.

```bash
# patch: 버그 수정, 소규모 개선 (1.0.0 → 1.0.1)
npm version patch

# minor: 새 기능 추가, 하위 호환 (1.0.0 → 1.1.0)
npm version minor

# major: breaking change, 아키텍처 변경 (1.0.0 → 2.0.0)
npm version major
```

### 버전 변경 체크리스트

코드를 변경하고 커밋하기 전에:
1. `npm version patch|minor|major` 실행 (package.json 자동 업데이트)
2. CLAUDE.md의 **현재 버전** 줄 업데이트
3. `npx tsc && npx vitest run` 통과 확인 후 publish

### 버전 이력

| 버전 | 변경 내용 |
|------|-----------|
| 1.0.0 | 초기 릴리즈 |
| 1.1.0 | paneId-primary session identity 리팩토링 — /clear 시 label/tags 보존, state.json v2 TTL eviction |
| 1.1.1 | fix: pane 기반 hook identity resolution 추가 — ephemeral PPID로 PID ancestry walk 실패 시 TMUX_PANE으로 직접 매칭 |
| 2.0.1 | fix: picker readOnly mode에서 /rename label 미반영 — JSONL extractLabel 폴백(newest JSONL 포함), stale label 덮어쓰기, drainEventQueue PID liveness check, legacy non-pane identity 필터링 |
| 2.2.3 | fix: session label/summary cross-contamination — resolver persistedMatch tightened; register() requires chosenConvId match; stale-sid path drops conversation-scoped meta (Claim D); lastSeenAt TTL eviction; doctor command |
| 2.2.4 | fix: /rename label not visible on first popup open — updateMeta label changes now persist synchronously (bypass 2s debounce) |
| 2.2.5 | fix: LLM summarization — single combined claude call (3→1), readEarlyContext for goal (head not tail), stderr separated, sha256 hash |
| 2.4.0 | feat: Dashboard 2-line block 레이아웃 — `이름 · workspace` / `=> summary` / `↳ next` 구조로 변경. 이름(label) 미설정 시 session id 대신 workspace만 표시 (raw id 노이즈 제거), remote는 `(remote)` 표기, summary 전폭 사용 |
| 2.3.1 | refactor: tmux session 자동 리네임 기능 제거 — `tmux.renameSession()`, `ensureTmuxSessionName()` 및 호출부/테스트 삭제 (더 이상 세션 이름을 `claude-{projectName}`으로 바꾸지 않음) |
| 2.3.0 | feat: `popmux setup-tmux` + shipped `bin/popmux-toggle` — F12 popup toggle now a package artifact. Single-source PID-liveness lock (self-heals on crash), consistent XDG lock path, absolute sibling-bin resolution (no tmux PATH dependency), idempotent managed block in ~/.tmux.conf. Replaces hand-made orphan toggle + dual-layer if-shell logic. |
| 2.5.0 | feat: `/` 키를 명령 전송 → 이름(label) 있는 세션 fuzzy-search 오버레이로 교체. 선택 시 대시보드 cursor를 해당 세션으로 이동(이동/종료 아님), `g`는 기존 Go 유지. Send 기능 전면 제거 — `SendInput`/`useTmux`/`popmux send` CLI/picker `send` action/`commands` config 삭제, `fuzzyMatch`를 `src/ui/fuzzy.ts`로 추출 |
| 2.6.0 | feat: `R` 키로 dead/past 세션 fuzzy-search 부활 오버레이 추가 — `getAllPastSessions()`(label+cwd basename 검색)에서 선택 시 `claude --resume <id>`로 새 tmux 세션 생성(기존 `handleNewSession` 재사용). picker 모드에서는 remote past 제외(`popmux spawn` remote=B4 stub). `resolveHostBySsh` 헬퍼 추출 |
| 2.6.1 | fix: resume 오버레이가 cwd당 1개로 축소되던 버그 — `getAllPastSessionsUngrouped()`(cwd dedup 없음, sessionId별 전부) 추가해 ResumeSearch가 사용. 같은 cwd 다중 세션 구분 위해 summary를 이름으로(미설정 시)·age 표시·summary도 fuzzy 검색 대상에 포함 |
| 2.7.3 | fix: resume 오버레이 3종 버그 — (1) 로컬 orphan 세션(state.json엔 있지만 JSONL 없음, 컨테이너 강제종료 등)을 스캔 완료 후 목록에서 숨김(`getAllResumableSessions(scanned, scanComplete)`), remote는 예외; (2) 커서를 배열 index 대신 sessionId 기반으로 관리해 스캔 완료로 목록이 줄어들 때 화살표가 씹히던 문제 해결(Dashboard의 `cursorIdentity` 패턴과 동일); (3) 뷰포트 스크롤 추가— 커서를 화면 중앙에 유지, `↑/↓ N more` 힌트; (4) F12 팝업 경로(`tmux run-shell` → `popmux spawn`)가 물려받는 bare PATH(`/usr/bin` 등)에 `~/.local/bin`이 없어 `claude` 실행이 "command not found"로 즉시 죽고 창이 사라지던 버그 — `resolveClaudeBin()`으로 절대경로 직접 확인 |
| 2.7.5 | refactor: `NewSession`의 `list`/`custom` 모드를 단일 `pick` 모드로 통합 — 입력창 하나(`query`)가 filter와 path를 겸용. `/`,`~`,`.`로 시작하면 path로 해석해 최상단에 `▸ Start in: <expanded>` 행(Tab 자동완성) 표시, Enter 시 그 경로에서 fresh 시작; 그 외에는 기존 workspace fuzzy filter. 경로를 타이핑하면 filter로 흡수되어 "No matches"가 뜨고 custom 모드로 넘어가도 입력값이 버려지던 버그 해결. j/k는 더 이상 네비게이션이 아니며(화살표 전용) query에 타이핑됨 |
| 2.7.6 | fix: picker(`--no-cold-start` readOnly) 프로세스가 F12 토글마다 재시작되지 않고 며칠씩 재사용되면서, 최초 1회성 hook-queue drain 스냅샷이 굳어 대시보드 상태(IDLE/EXECUTING)가 stale해지던 버그 — readOnly 모드에 3초 주기 `drainEventQueue()` 재실행(`setInterval`, `unref`)을 추가해 프로세스 수명과 무관하게 최신 상태 반영 |
| 2.7.4 | refactor: `NewSession`을 순수 workspace(작업 디렉터리) picker로 단순화 — resume/recent/label/summary UI 전부 제거(그건 `R` ResumeSearch 오버레이 담당), 모드를 `host → list → custom` 3단으로 통합. 목록 소스를 단일화해 항상 `getPastSessionsByTarget(selectedHost?.ssh)`(cwd dedup, 최신순) 사용 — 기존 `recentProjects`(slug 기반 경로 복원, 하이픈/점 포함 디렉터리에서 조용히 누락되던 버그) 제거. 모든 선택 경로는 resumeSessionId 없이 fresh `onSelect(cwd, host)`. `projects`/`getPastSessions`/`getAllPastSessions`/`onDeleteSession` prop 및 `PastSession` 인터페이스, `src/utils/recent-projects.ts` 모듈 삭제 |
| 2.7.2 | fix: picker(readOnly) 상태가 항상 idle로 고정되던 버그 — drain 가드가 `event.pid`(hook이 쓰는 `$PPID` = ephemeral wrapper, drain 시점엔 죽음)로 liveness를 판정해 thinking/executing/agent를 전부 idle로 강제. pane liveness 기준으로 교체하고 `resolveQueuedStatus()` 순수 함수로 추출 + 단위 테스트. |
| 2.7.1 | fix: resume 오버레이 — 스캐너가 JSONL의 `custom-title`(=`/rename` 이름) 추출해 label로 사용, 이름(label/summary) 없는 세션은 목록에서 제외, fuzzy 검색은 이름만(workspace 경로 제외). |
| 2.7.0 | feat: resume 오버레이가 `~/.claude/projects/**/*.jsonl` 전체를 스캔(`src/core/session-scanner.ts`, lazy on first R, 16KB head-read·content 기반 cwd·디렉터리 mtime 증분 캐시)하여 디스크상의 모든 재개 가능 세션 노출(state.json 31 → ~340+). `store.getAllResumableSessions(scanned)`가 sessionId로 merge(state.json이 label/summary/sshTarget 우선, active 제외). ResumeSearch는 `generation` prop으로 스캔 완료 시 갱신, cold 스캔 중 "scanning…" footer 표시 |

## Build & Publish

```bash
# Build (TypeScript → dist/)
npx tsc

# Test
npx vitest run

# Publish to npm (see memory/reference_npm_publish.md)
npx tsc && npm publish
```

## Project Structure

- `src/` — TypeScript source (ESM-only, ink v5 + React)
- `dist/` — Compiled JS (committed to git for npm install)
- `bin/popmux.js` — Entry point (imports dist/index.js)
- `hooks/` — Claude Code hook plugin files
- `test/` — Vitest tests
- `doc/` — Architecture and algorithm documentation

## Documentation

- [`doc/algorithms.md`](./doc/algorithms.md) — State machine, discovery, JSONL inference, LLM summarization 등 핵심 알고리즘 레퍼런스
  - **Summary & Next Action Update Workflow** — `goalSummary` / `contextSummary` / `nextSteps` 세 필드의 트리거 조건, LLM 캐시, local vs remote 차이, /clear 동작 상세 정리

## Key Patterns

- **ESM-only**: `"type": "module"` in package.json, `.js` extensions in imports
- **Non-blocking**: Use `spawn('sh', ['-c', ...])` for async shell commands, never `execSync` in UI path
- **State tracking**: Hook (primary) → JSONL fs.watch (fallback) → Process scan (tertiary)
- **Session discovery**: `~/.claude/sessions/*.json` if available, else process scan + CWD matching
- **LLM summarization**: `claude --print` via `spawn`, parallel, cached in state.json
- **tmux interaction**: All commands via `execa('tmux', [...])` wrapper in `src/tmux/commands.ts`
