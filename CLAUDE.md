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

**현재 버전: 2.8.11**

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
| 2.8.0 | feat: Attention Banner — 세션이 running(thinking/executing/agent)→idle로 전이됐는데 사용자가 아직 그 세션에 진입(popmux Go 액션)하지 않았으면 대시보드 row에 인라인 배지(`⚠ 관심 필요`) 표시, Go 진입 시 해제. 전이 판정을 순수 함수 `computeNeedsAttention()`(`queued-status.ts`)으로 분리하고 `SessionStore.update()`의 명시적 opt-in 마커(`{statusEvent:true}`)로만 적용해 `/resume`·`/clear` FSM 리셋의 오탐을 원천 차단. `needsAttention`/`lastPersistedStatus`를 state.json에 영속화해 F12 popup 재시작 사이에도 전이 감지가 끊기지 않도록 함(deep-interview → omc-plan consensus 3회 반복 → ralph로 구현, Architect+Critic 양쪽 APPROVE) |
| 2.8.1 | fix: F12 popup(readOnly picker)이 tool 호출 없이 오래 "생각만" 하는 세션(hook 큐에 보정할 이벤트가 없음)을 매번 새 프로세스로 열 때마다 status를 하드코딩된 `'idle'`로 표시하던 버그 — `register()`가 caller가 이미 'idle'로 넘긴 경우에만(즉 진짜 정보가 없을 때만) 영속화된 `PersistedInstance.status`를 표시용 `session.status` 초기값으로 채우도록 수정(2.8.0에서 도입한 `lastPersistedStatus`와 별개로, 표시 자체도 보정). 이미 caller가 non-idle을 결정한 경우는 덮어쓰지 않아 stale-executing 부작용 방지 |
| 2.8.2 | fix: `~/.claude/settings.json`의 `SubagentStop` 훅이 실제로는 `popmux-hook.sh agent-stop`을 호출하는데 `queued-status.ts`의 `STATUS_MAP`엔 `agent-end`만 있어서 서브에이전트 완료 이벤트가 조용히 매핑 실패(`resolveQueuedStatus` → undefined)해 무시되던 버그 — `'agent-stop': 'idle'` 매핑 추가. OMC 서브에이전트/Task 위임을 많이 쓰는 세션에서 status가 stale하게 멈춰있던 근본 원인 |
| 2.8.3 | fix: readOnly picker 경로의 `STATUS_MAP`이 `post-tool`/`agent-stop`을 `'idle'`로 매핑해, 하나의 agentic turn 안에서 tool 호출이 끝날 때마다(실제로는 다음 tool 호출로 바로 이어지는데도) 대시보드가 idle로 깜빡이고 Attention Banner(`needsAttention`)까지 오탐하던 버그 — 정식 FSM(`state-machine.ts`의 `resolveNext()`: `post-tool`→`thinking`, `agent-stop`→이전 상태 복귀)과 일치하도록 두 매핑을 `'thinking'`으로 수정. 진짜 idle 전이는 `stop`(turn 완전 종료) 이벤트만 의미하도록 통일. 라이브 세션(20분+ 연속 작업 중인 interview 세션)에서 실시간 트레이싱으로 재현·검증 |
| 2.8.4 | refactor(구조적 수정): 2.8.3에서 `stop` 훅이 유실되면 status가 `thinking`에 영구 고착되는 새 실패 모드가 드러남(실제로 아무 동작 없는 manager 세션에서 재현·확인) — readOnly 경로의 훅-이벤트 기반 status 추론이 근본적으로 "훅 하나라도 유실/오순서/이름불일치되면 자가복구 불가"라는 구조적 한계였음. tmux `pane_title`(Claude Code가 직접 설정하는, 훅과 완전히 독립적인 실시간 스피너 글리프: 작업 중엔 `◐◓◑◒` 애니메이션, 대기 중엔 고정된 `✳`)을 ground truth로 삼아 매 3초 드레인 주기마다 status를 정정하는 `reconcilePaneTitles()` 추가(`pane-title-status.ts`). 훅 유실 여부와 무관하게 자가치유됨 — 실제 stuck 세션에서 fresh 프로세스 1회 실행만으로 즉시 정정 확인 |
| 2.8.5 | fix: Attention Banner(`needsAttention`)가 popmux Go 액션으로만 해제되도록 좁혀둔 스펙 범위가 실사용 사각지대였음 — tmux에서 직접 세션에 들어가 작업을 재개하는 경우(Go를 타지 않음) 배지가 영구히 안 지워짐. `computeNeedsAttention()`을 확장해 nextStatus가 running(thinking/executing/agent)이면 prevStatus와 무관하게 항상 해제하도록 변경 — "현재 확인된 running 상태"라면 이전 idle 주기의 stale한 배지는 더 이상 의미 없다는 판단. readOnly 프로세스가 재시작마다 단 하나의 전이만 관측 가능해 idle→running 엣지 자체를 놓칠 수 있는 문제도 함께 해결 |
| 2.8.6 | fix: popmux Go로 `needsAttention`을 정상적으로 clear해도, 동시에 살아있는 다른 readOnly picker 프로세스(닫혔지만 완전히 종료 안 된 orphan, 또는 겹쳐서 열린 팝업)가 자기 메모리 속 stale한 `true`를 3초 주기로 계속 재기록해 방금 지운 값을 다시 덮어쓰던 race condition 발견 및 수정 — 실제 두 프로세스로 재현 확인. 단순 "내가 건드렸는지" 플래그로는 오래된 결정과 최신 결정을 구분 못해(오래된 결정이 여전히 자기 걸 우선시함), `needsAttentionSetAt` 타임스탬프를 도입해 진짜 last-write-wins으로 재설계 — persist 시점에 디스크를 다시 읽어 더 최근 타임스탬프 쪽을 채택. 실제 프로세스 2개로 race 재현 후 수정 검증(더 이상 되돌아가지 않음 확인) |
| 2.8.7 | fix: picker에서 실제 사용자가 세션에 진입하는 주경로인 `Enter`(`handleSelect`)가 `handleGo`(`g` 키)와는 완전히 별개의 `{"action":"go",...}` 작성 코드 경로였는데, 2.8.0의 needsAttention 해제 로직이 `handleGo`에만 추가되고 `handleSelect`엔 빠져있던 버그 — 실제 tmux 창에서 진짜 picker 바이너리로 F12→scroll→Enter→F12 전체 플로우를 재현하다 발견. `handleSelect`에도 동일한 clear+persistSync 로직 추가, 두 "go" 작성 경로 모두 커버 확인 |
| 2.8.8 | style: Attention Banner(`⚠ 관심 필요`) 배지 색상을 yellow → red로 변경 — 시인성 개선 |
| 2.8.9 | feat: Attention Banner 배지에 500ms 주기 blink 효과 추가(red+bold ↔ 기본색 토글). `needsAttention`인 세션이 하나도 없으면 타이머를 돌리지 않아 불필요한 재렌더링 방지. 실제 picker에서 tmux capture-pane -e로 ANSI 컬러 코드가 토글되는 것을 확인 |
| 2.8.10 | fix: 2.8.4의 `reconcilePaneTitles()`가 서브에이전트에 위임 중인 세션("← 1 agent")에서 Claude Code가 pane title을 갱신하지 않는 케이스를 처리 못해, 훅이 같은 드레인 틱에서 정확히 감지한 `thinking`/`executing`을 곧바로 stuck idle 글리프로 덮어쓰던 버그 — 실시간 디버그 로그로 "훅 적용 → 같은 틱에서 즉시 idle로 재덮어씀"을 직접 확인. `applyQueuedEvent`에 `lastActivity` 갱신을 추가하고, `applyPaneTitles()`가 busy→idle 다운그레이드 방향에서만 "훅이 8초 이내 최근에 확인했으면 title보다 훅을 신뢰"하도록 gating 추가(idle→busy 업그레이드는 정보 손실 위험이 없어 그대로 즉시 적용). 실제 세션으로 재검증: thinking 유지 → 훅 침묵 8초 후에만 idle로 정정, 실제 상태와 일치 |
| 2.8.11 | fix: 2.8.10의 8초 grace가 서브에이전트 reasoning 간격(실측 9~12초)보다 짧아서, 서브에이전트가 실행 중인 세션이 훅 사이 공백마다 idle로 깜빡였다 다시 돌아오는 flapping이 재현됨 — pane title은 서브에이전트 활동을 전혀 반영하지 못하므로(foreground thread만 반영) 시간 기반 판단 자체의 한계. Grace를 30초로 늘려 실측 간격에 충분한 여유를 둠(2.8.4의 원래 목적인 "수시간 방치된 stuck 세션" 자가치유는 30초로도 여전히 충분히 빠름). 실제 4분 넘게 서브에이전트가 도는 세션으로 25초 연속 관찰해 flapping 없이 thinking 유지되는 것 확인 |
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
