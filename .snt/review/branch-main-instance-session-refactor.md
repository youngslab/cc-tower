# Code Review: Instance-Session Mapping Refactor

> 30 commits, 7 files, +323/-231. Hook-authoritative sessionId 교정, instance-level favorite, discovery dedup. 핵심 설계는 건전하나 shared state race + 메모리 누수 수정 필요.

## 개요

| 항목 | 내용 |
|------|------|
| 대상 | branch main, 30 commits (8467c63..9723368) |
| 변경 규모 | +323/-231, 7 files |
| 핵심 변경 | Hook이 sessionId 교정의 유일한 authority, favorite을 instance-level로 이동 |
| 리뷰 에이전트 | critic, architect, code-reviewer, analyst, security-reviewer, qa-tester |

## 종합 판정

`REQUEST_CHANGES`

CRITICAL 2건 (shared state race + command injection) 수정 필요.

**머지 조건**:
- [MUST FIX] `lastResolveDepth` shared state → return value로 변경
- [MUST FIX] tmux kill-session command injection → execFileSync 사용
- [MUST FIX] `hookLocked` Set cleanup on session-lost
- [FOLLOW-UP] Unix socket 권한 제한 (chmod 0600)
- [FOLLOW-UP] Hook input validation
- [FOLLOW-UP] 테스트 추가 (dedup, hookLocked, favorite round-trip, lastSessionId cache)

## 리뷰 결과

### CRITICAL

#### [Code Reviewer / Architect / Critic] `lastResolveDepth` shared mutable state — race condition

**내용**: `resolveIdentity()`가 class field `lastResolveDepth`에 depth를 저장하고, `handleHookEvent()`가 이를 읽음. 단일 스레드에서 현재는 안전하나, future async 변경 시 silent corruption.

**코드**:
```typescript
// tower.ts:1113
private lastResolveDepth = 0;
// tower.ts:1139 — set
this.lastResolveDepth = depth;
// tower.ts:1200 — read
const isDirectChild = this.lastResolveDepth <= 3;
```

**수정 가이드 (Before/After)**:
```typescript
// Before
private resolveIdentity(...): string | null { ... this.lastResolveDepth = depth; return id; }
let identity = this.resolveIdentity(hookSid, event.cwd, event.pid, event.event);
const isDirectChild = this.lastResolveDepth <= 3;

// After
private resolveIdentity(...): { identity: string; depth: number } | null { ... return { identity: id, depth }; }
const resolved = this.resolveIdentity(hookSid, event.cwd, event.pid, event.event);
if (!resolved) { ... return; }
let identity = resolved.identity;
const isDirectChild = resolved.depth <= 3;
```

#### [Security] Command injection via tmux kill-session (`tower.ts:147`)

**내용**: `execSync(`tmux kill-session -t ${name}`)` — name에 shell metacharacter 포함 시 임의 명령 실행 가능.

**수정 가이드 (Before/After)**:
```typescript
// Before
execSync(`tmux kill-session -t ${name} 2>/dev/null`);

// After
import { execFileSync } from 'node:child_process';
execFileSync('tmux', ['kill-session', '-t', name], { stdio: 'ignore' });
```

### WARNING

#### [MUST FIX] `hookLocked` Set never cleaned — memory leak + PID reuse risk (`discovery.ts:26`)

**내용**: PID가 `hookLocked`에 추가되지만 session-lost 시 제거 안 됨. PID 재사용 시 잘못된 lock.

**수정 가이드**:
```typescript
// discovery.ts — session-lost paths (~line 117, ~line 170)
this.known.delete(info.pid);
this.hookLocked.delete(info.pid);  // ADD
```

#### [MUST FIX] Unix socket permissions not restricted (`hook-receiver.ts:62`)

**내용**: `/tmp/cc-tower.sock`이 0777로 생성됨. 로컬 다른 사용자가 hook 이벤트 주입 가능.

**수정 가이드**:
```typescript
this.server.listen(this.socketPath, () => {
  fs.chmodSync(this.socketPath, 0o600);
});
```

#### [FOLLOW-UP] `onDisplayOrderChange` called during render (`Dashboard.tsx:54`)

**내용**: React render phase에서 parent callback 호출 → cascading re-render 위험.

**수정**: `useEffect`로 이동.

#### [FOLLOW-UP] In-memory `sessionMeta` leaks on `/clear` (`tower.ts:1214`)

**내용**: sessionId 변경 시 old sessionMeta 엔트리 미삭제 → 장시간 실행 시 메모리 증가.

**수정**: hook stale correction 시 `this.sessionMeta.delete(oldSessionId)` (resume이 아닌 경우).

#### [FOLLOW-UP] `fs.watch` directory watcher leak on rapid `/clear`

**내용**: 연속 `/clear` 시 동일 directory에 여러 watcher 생성. identity별 watcher 추적 필요.

### SUGGESTION

#### [PM] `session-rekeyed` event not subscribed in TUI

**내용**: paneId upgrade 시 TUI가 `session-rekeyed` 이벤트를 구독하지 않아 일시적 stale 표시.

#### [PM] favorite이 Instance에 있음 — 요구사항 spec 업데이트 필요

**내용**: 원래 spec은 favorite을 SessionCache(sessionId 키)로 정의. 현재 구현은 Instance(identity 키). 의도적 변경이므로 `doc/algorithms.md` TODO 섹션 업데이트.

#### [Critic] PID ancestry depth threshold 3은 magic number

**내용**: `isDirectChild = depth <= 3` — Claude Code 프로세스 트리 변경 시 silent breakage. 상수로 추출 + 문서화.

#### [QA] 핵심 시나리오 테스트 부재

**내용**: 4개 CRITICAL 테스트 갭:
1. Same-CWD dedup
2. hookLocked/updateKnown
3. lastSessionId cache correction
4. PID ancestry depth filtering

### GOOD

- [Architect] favorite을 Instance로 이동 — 올바른 설계 (session 변경에 영향 안 받음)
- [Architect] Sequential cold-start registration — JSONL fallback race 제거
- [Code Reviewer] `_buildPersistData()` DRY 리팩토링
- [Code Reviewer] PID ancestry walk depth 제한 (15)
- [Security] `isPidAlive` PID ≤ 0 guard
- [Security] SSH BatchMode, ControlMaster, ConnectTimeout
- [PM] CWD 기반 auto-merge 제거 확인
- [PM] /resume vs /clear 구분 정확

## 리뷰어별 판정

| 리뷰어 | 판정 | CRITICAL | WARNING | SUGGESTION |
|--------|------|----------|---------|------------|
| Critic | ACCEPT-WITH-RESERVATIONS | 1 (lastResolveDepth) | 1 (hookLocked) | 3 |
| Architect | REQUEST_CHANGES | 1 (lastResolveDepth) | 2 | 2 |
| Code Reviewer | REQUEST_CHANGES | 1 (lastResolveDepth) | 3 | 2 |
| Security | REQUEST_CHANGES | 1 (command injection) | 4 | 3 |
| QA | REQUEST_CHANGES | 4 (test gaps) | 4 | 1 |
| PM/Analyst | COMMENT | 0 | 3 | 3 |
