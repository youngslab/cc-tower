# Instance-Session 매핑 알고리즘

## 개요

cc-tower의 instance-session 매핑 알고리즘은 Claude Code 프로세스 인스턴스(paneId/pid로 식별)와 해당 세션(sessionId로 식별)을 올바르게 연결하는 역할을 한다. 여러 인스턴스가 동일한 프로젝트 디렉토리에서 실행될 수 있고, 세션 메타데이터가 stale해질 수 있어 잘못된 매핑이 발생할 수 있으므로 이 매핑은 매우 중요하다.

**핵심 문제:** PID의 sessionId는 생애 주기 동안 변경될 수 있다(`/clear` 또는 `/resume` 명령어). 이때 주 discovery 소스(`~/.claude/sessions/{pid}.json`)는 즉시 stale 상태가 된다.

## 데이터 모델

### Instance

**Instance**는 실행 중인 단일 Claude Code 프로세스를 나타낸다:

```typescript
interface Instance {
  pid: number;
  paneId?: string;              // tmux pane ID (예: "%5", "%13")
  sessionId: string;            // 고유 세션 식별자 (UUID)
  hasTmux: boolean;
  detectionMode: 'hook' | 'jsonl' | 'process';
  cwd: string;                  // 작업 디렉토리
  projectName: string;          // basename(cwd)
  status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
  // ... 기타 필드 (lastActivity, currentTask 등)
}
```

**Identity:** 각 인스턴스의 identity는 다음과 같이 계산된다:

```typescript
sessionIdentity(s: { paneId?: string; pid: number }): string
  = s.paneId ?? String(s.pid)
```

paneId가 있으면 paneId를 키로 사용(재접속 시에도 안정적), 없으면 PID(임시, 재시작 시 변경됨)를 사용한다.

### SessionMeta

**SessionMeta**는 사용자가 제공한 메타데이터(label, tag, 요약)를 sessionId 기준으로 저장한다:

```typescript
interface SessionMeta {
  label?: string;               // 사용자 정의 이름 (/rename)
  tags?: string[];
  favorite?: boolean;
  favoritedAt?: number;
  goalSummary?: string;         // LLM 생성: 고수준 목표
  contextSummary?: string;      // LLM 생성: 최근 작업 방향
  nextSteps?: string;           // LLM 생성: 다음 권장 행동
}
```

SessionMeta는 **sessionId 기준**으로 저장되기 때문에 paneId 변경이나 `/resume` 이벤트 이후에도 메타데이터가 유지된다.

### 이중 맵 아키텍처

SessionStore는 두 개의 Map을 유지한다:

```typescript
export class SessionStore {
  private instances: Map<string, Instance> = new Map();        // key: identity (paneId ?? String(pid))
  private sessionMeta: Map<string, SessionMeta> = new Map();   // key: sessionId
}
```

**설계 이유:**
- **instances**: identity(pane/프로세스) 기준 → TUI에서 터미널 pane 당 하나의 행 표시
- **sessionMeta**: sessionId(대화) 기준 → `/clear`, `/resume` 이후에도 요약·label 유지
- 1:다 관계: 하나의 sessionId가 여러 identity에 매핑될 수 있음 (정상적으로는 발생하지 않아야 하나, 방어적으로 처리)

## Discovery → sessionId 결정

discovery 엔진은 다음 세 가지 fallback 경로로 PID의 현재 sessionId를 결정한다:

### 경로 1: `~/.claude/sessions/{pid}.json` (주 경로)

**위치:** `~/.claude/sessions/{pid}.json`
**우선순위:** 최고
**형식:**
```json
{
  "pid": 1234,
  "sessionId": "uuid-here",
  "cwd": "/path/to/project",
  "startedAt": 1704067200000
}
```

**동작 시점:** 콜드 스타트, session-start 훅 수신 시.
**실패 시점:** `/clear` 또는 `/resume` 이후. Claude Code가 새 sessionId를 비동기로 파일에 쓰기 때문에, 쓰기 완료 전 짧은 시간 동안 파일이 stale 상태가 된다.

### 경로 2: `CLAUDE_SESSION_ID` 환경 변수 (Fallback 1)

**소스:** 훅 이벤트 페이로드 → `/proc/{pid}/environ`에서 프로세스 환경 변수 읽기
**사용 시점:** 정확한 `{sessionId}.jsonl` 파일이 없을 때 (discovery.ts lines 179–188)
**우선순위:** JSONL 파일명보다 높음, session 파일보다 낮음

**구현 (discovery.ts:179–188):**
```typescript
try {
  const environPath = `/proc/${pid}/environ`;
  const environData = readFileSync(environPath, 'utf-8');
  const environ = environData.split('\0');
  const claudeSessionIdEntry = environ.find(entry => entry.startsWith('CLAUDE_SESSION_ID='));
  if (claudeSessionIdEntry) {
    sessionId = claudeSessionIdEntry.replace('CLAUDE_SESSION_ID=', '');
  }
} catch {}
```

Claude Code가 프로세스 생애 초반에 `CLAUDE_SESSION_ID`를 설정하고 (JSONL 파일 생성 전), `/clear`/`/resume` 이후에도 유지되므로 신뢰성이 높다.

### 경로 3: JSONL 파일명 (Fallback 2)

**소스:** `~/.claude/projects/{slug}/` 디렉토리의 `.jsonl` 파일 스캔
**사용 시점:** CLAUDE_SESSION_ID 없고 `{sessionId}.jsonl` 파일도 없을 때
**우선순위:** 최하
**실패 모드:** 같은 디렉토리에 여러 `.jsonl` 파일 존재 시(여러 세션 동시 실행), 가장 최근 수정 파일을 선택
**완화책:** `watchedJsonls` 체크로 이미 다른 세션이 사용 중인 JSONL 재할당 방지

## registerSession: JSONL 경로 선택

세션이 발견되면 `registerSession` (tower.ts)에서 어떤 `.jsonl` 파일을 감시할지 결정한다.

### 우선순위 0: lastConversationId (이전 등록 시 저장된 값)

**조건:** `{sessionId}.jsonl` 없음 + `opts.skipJsonlFallback` 아님 + 해당 pane의 `lastConversationId` 존재
**동작:** 저장된 `lastConversationId`에 해당하는 JSONL 파일이 존재하면 그것을 사용. Newest-JSONL 스캔을 건너뜀.

```typescript
const persistedConvId = this.store.getPersistedInstanceEntries()
  .find(([id]) => id === earlyIdentity)?.[1]?.lastConversationId;
if (persistedConvId) {
  const persistedPath = path.join(projectDir, `${persistedConvId}.jsonl`);
  if (fs.existsSync(persistedPath)) {
    jsonlPath = persistedPath;
  }
}
```

### 우선순위 1: 정확한 파일 일치 (Exact Match)

**조건:** `{sessionId}.jsonl` 존재
**동작:** 해당 파일을 즉시 사용. 파일이 비어 있어도 (`size === 0`) fallback 하지 않음.

**중요 세부사항:**
- `exactExists && size > 0` → 파일 사용 (대화 진행 중)
- `exactExists && size === 0` → 그래도 파일 사용 (신선한 `/clear`, 곧 데이터 채워질 예정)
- `!exactExists` → Fallback으로 넘어감 (stale discovery)

### 우선순위 2: Fallback (Newest JSONL 스캔)

**조건:** 위 조건 모두 실패 + `!opts.skipJsonlFallback`

```typescript
const watchedJsonls = new Set(this.jsonlPaths.values());
// 다른 instance의 lastConversationId도 제외 (등록 순서 race 방지)
const claimedConvIds = new Set(
  this.store.getPersistedInstanceEntries()
    .filter(([id]) => id !== earlyIdentity)
    .map(([, v]) => v.lastConversationId)
    .filter(Boolean)
);
const candidate = files.find(f => {
  const convId = path.basename(f.path, '.jsonl');
  return f.path !== jsonlPath
    && !watchedJsonls.has(f.path)
    && !claimedConvIds.has(convId);
});
```

**두 가지 배제 조건:**
1. `watchedJsonls` — 이미 watch 중인 JSONL (현재 활성 세션이 사용 중)
2. `claimedConvIds` — 다른 instance의 `lastConversationId` (등록 순서 race condition 방지)

**override:** `skipJsonlFallback: true` → 훅에서 `/clear` 감지 시 사용. 훅이 정확한 sessionId를 제공하므로 fallback 불필요.

### 콜드 스타트 추출

JSONL 경로 결정 후 파일에서 초기 상태 추출:

```typescript
const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);      // 'idle' | 'thinking' | 'executing'
const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);      // 마지막 사용자 메시지
const customTitle = this.jsonlWatcher.coldStartCustomTitle(jsonlPath);  // /rename 이름
```

### lastConversationId 저장

JSONL 경로가 결정되면 즉시 `lastConversationId`를 state.json에 저장:

```typescript
this.store.setInstanceConversationId(identity, path.basename(jsonlPath, '.jsonl'));
```

다음 번 Tower 재시작 시 우선순위 0에서 이 값을 활용.

## rehydrateFromState: Picker/ReadOnly 모드

picker(`--no-cold-start`) 또는 readOnly 모드에서는 state.json만 읽고 JSONL watcher를 시작하지 않는다.
`rehydrateFromState()`가 저장된 상태에서 세션을 복원한다.

### JSONL 경로 결정 (rehydrateFromState 내)

```
Priority 1: lastConversationId (저장된 값, 아직 다른 instance가 claim하지 않은 경우)
Priority 2: {sessionId}.jsonl
Priority 3: 가장 최근 unclaimed JSONL (fallback)
```

**중복 convId 배제:**

```typescript
const assignedConvIds = new Set<string>();
// ...
const convId = inst.lastConversationId && !assignedConvIds.has(inst.lastConversationId)
  ? inst.lastConversationId : undefined;
```

같은 loop에서 이미 다른 instance에게 할당된 convId는 건너뜀. 두 pane이 동일한 `lastConversationId`를 가진 경우(stale state) 두 번째 instance는 다음 unclaimed JSONL로 fallback한다.

**Fallback JSONL 신뢰도:**

```typescript
let jsonlTrusted = true;
if (!fs.existsSync(jsonlPath)) {
  jsonlTrusted = false; // fallback JSONL은 이 세션의 것이 아닐 수 있음
  // newest unclaimed JSONL 탐색
}
// fallback JSONL이면 entry.label 우선 사용 (JSONL 라벨 무시)
if (jsonlTrusted || !entry.label) {
  sessionFileName = agents.claude.extractLabel(jsonlPath);
}
```

신뢰할 수 없는 fallback JSONL에서 label을 추출하면 다른 세션의 label이 덮어씌워질 수 있다. `entry.label`(sessions 맵에 저장된 label)이 있으면 그것을 우선한다.

## 훅 기반 세션 보정

초기 등록 이후 훅이 런타임 보정을 제공한다 (`handleHookEvent`).

### Identity 해석 (resolveIdentity)

훅 이벤트에 `event.sid` (sessionId)가 포함되면 세 경로로 identity를 결정:

**경로 1: 캐시 조회 (O(1))**
```typescript
const cached = this.hookSidToIdentity.get(hookSid);
if (cached && this.stateMachines.has(cached)) return cached;
```
`CLAUDE_SESSION_ID` → identity 매핑. 훅이 도착할 때 지연 빌드됨.

**경로 2: 복합 키 매칭 (원격 세션)**
```typescript
for (const key of this.remoteStateMachines.keys()) {
  if (key.endsWith(`::${hookSid}`)) { ... return key; }
}
```
원격 세션은 `"host::sessionId"` 키 사용; 훅은 순수 sessionId만 전송.

**경로 3: PID 조상 탐색**
```typescript
if (hookPid && hookPid > 0) {
  let current = hookPid;
  while (current > 1 && depth < 15) {
    // 알려진 세션 PID와 매칭 시도
    // 실패하면 부모 PID로 이동
    current = getPpid(current);
  }
}
```
훅 PID에서 프로세스 부모 체인을 최대 15단계까지 탐색하여 알려진 세션 PID와 매칭. `CLAUDE_SESSION_ID`가 없는 경우(`'unknown'`) 사용.

### Stale sessionId 감지

```typescript
if (hookSid !== 'unknown' && hookSid !== session.sessionId) {
  // 이전 JSONL watch 해제
  this.jsonlWatcher.unwatch(session.sessionId);
  // sessionId 갱신
  this.store.update(identity, { sessionId: hookSid });
  // 새 JSONL watch 시작
  if (fs.existsSync(newJsonl)) {
    this.jsonlPaths.set(hookSid, newJsonl);
    this.jsonlWatcher.watch(hookSid, newJsonl);
  }
}
```

identity(paneId/pid)는 유지하고 sessionId만 인-플레이스 보정. 세션이 사라지지 않음.

### paneId 업그레이드

discovery 초기에 PID만 알고 paneId를 몰랐다가 훅에서 pane 정보가 오면:

```typescript
// identity 재키: String(pid) → paneId
this.store.rekey(oldIdentity, newIdentity);
this.stateMachines.delete(oldIdentity);
this.stateMachines.set(newIdentity, fsm);
```

## session-changed 이벤트 처리

discovery 엔진이 같은 PID에서 sessionId 변경을 감지하면 `session-changed`를 emit한다.

### /resume vs /clear 판별

```typescript
const nextJsonl = path.join(claudeDir, 'projects', slug, `${next.sessionId}.jsonl`);
const isResume = (() => { try { return fs.statSync(nextJsonl).size > 0; } catch { return false; } })();
```

- **isResume=true:** 새 sessionId의 JSONL이 존재하고 내용 있음 → 이전 대화 재개, 메타데이터 이전
- **isResume=false:** JSONL 없거나 비어있음 → `/clear`로 새 대화 시작, 이전 메타데이터 이전 안 함

### 메타데이터 재연결

```typescript
if (isResume) {
  this.store.reassociateMeta(prev.sessionId, next.sessionId);
}
this.store.update(identity, { sessionId: next.sessionId });
```

`reassociateMeta`는 SessionMeta를 이전 sessionId에서 새 sessionId로 이동시킨다. 요약, label, tag가 `/resume` 이후에도 유지된다.

## /clear 플로우 (미등록 sessionId)

훅에서 `event.event === 'session-start'`가 왔는데 매칭 세션을 찾지 못한 경우:

### 감지

```typescript
const dyingSession = this.store.getAll()
  .find(s => s.cwd === event.cwd && (!event.pid || s.pid === event.pid));
```

CWD + PID로 매칭. 같은 프로세스임을 확인해야 `/clear`로 판단 (새 병렬 세션이 아님).

### 메타데이터 이전

```typescript
const migratedMeta = dyingSession ? {
  label: dyingSession.label,        // label 유지 (단, /clear는 초기화 가능)
  favorite: dyingSession.favorite,  // 즐겨찾기 유지
  favoritedAt: dyingSession.favoritedAt,
} : undefined;
```

`/clear` 시 즐겨찾기는 유지, 요약은 초기화.

### 직접 등록

```typescript
await this.registerSession(info, { skipJsonlFallback: true });
```

훅이 권위 있는 sessionId를 제공하므로 `skipJsonlFallback: true`로 등록. `sessions/{pid}.json`은 stale이지만 훅 데이터를 신뢰.

## 알려진 실패 모드와 완화책

### 1. Stale Session 파일

**문제:**
- 사용자가 `/clear` 실행
- Claude Code가 새 sessionId를 비동기로 파일에 씀
- Tower가 쓰기 완료 전에 이전 sessionId를 읽음
- 잘못된 JSONL 감시, 잘못된 요약 적용

**완화책:**
- 훅 기반 stale 감지: 훅에서 실제 sessionId 수신 시 인-플레이스 보정
- `/clear` 훅 등록 시 `skipJsonlFallback: true`
- 오프라인 환경: discovery 재스캔으로 결국 수정됨

### 2. 동일 CWD JSONL 충돌

**문제:**
- 두 Claude 인스턴스가 같은 프로젝트 디렉토리에서 실행
- 두 인스턴스가 비슷한 시점에 `registerSession` 호출
- stale discovery로 두 인스턴스에 같은 sessionId 할당
- JSONL fallback이 같은 파일을 선택

**완화책:**
- `watchedJsonls` 체크: 이미 watch 중인 JSONL 제외
- `claimedConvIds` 체크: 다른 instance의 `lastConversationId` 제외
- 콜드 스타트 시 순차 등록으로 race window 축소

### 3. 같은 lastConversationId 충돌 (Stale State)

**문제:**
- 두 instance가 state.json에 동일한 `lastConversationId` 저장
- `rehydrateFromState`에서 둘 다 같은 JSONL → 같은 label 표시

**완화책:**
- `assignedConvIds` set으로 rehydration 루프 내 convId 중복 배제
- 두 번째 instance는 unclaimed JSONL로 fallback
- Fallback JSONL의 label은 신뢰하지 않고 `entry.label` 우선 사용

### 4. SDK-cli 세션 false 매칭

**문제:**
- PID 조상 탐색이 모든 세션 PID에 매칭 시도
- 헤드리스 SDK-cli 세션(사용자 코드에서 spawned)이 같은 부모를 가짐
- 사용자 코드의 훅 이벤트가 SDK-cli 조상에 귀속

**완화책:**
- SDK-cli 세션: discovery 시점에 필터링
- 훅 해석 시 SDK-cli 세션 건너뜀
- PID 조상 탐색 최대 깊이 15로 제한

## 완화책 요약

| 실패 모드 | 주 완화책 | 보조 완화책 |
|-----------|-----------|-------------|
| Stale session 파일 | 훅 기반 인-플레이스 보정 | Discovery 재스캔 |
| 동일 CWD JSONL 충돌 | watchedJsonls + claimedConvIds 체크 | 훅 원자성 |
| Race condition | 콜드 스타트 순차 등록 | Pane 기반 eviction |
| SDK-cli false 매칭 | Discovery 필터 + 훅 필터 | PID 조상 깊이 제한 (15) |
| /clear 미등록 sessionId | 훅 이벤트 감지 + 직접 등록 | CWD 매칭으로 메타데이터 복구 |
| 중복 lastConversationId | assignedConvIds 중복 배제 | entry.label 우선 사용 |

## 플로우 다이어그램

### 콜드 스타트 시퀀스

```
start() [tower.ts]
  ↓
restore() [session-store.ts]  — state.json에서 영속 메타데이터 로드
  ↓
hookReceiver.start()  — 훅 소켓 바인딩
  ↓
discovery.scanOnce()  — sessions/ 디렉토리 + 프로세스 목록 스캔
  ↓
각 session info에 대해 (순차):
  registerSession(info)
    ↓
    mapPidToPane(pid) → { paneId?, hasTmux }
    ↓
    JSONL 경로 결정:
      0. lastConversationId (저장된 값, 해당 파일 존재 시)
      1. {sessionId}.jsonl (정확한 매칭)
      2. Newest unclaimed JSONL (watchedJsonls + claimedConvIds 체크)
    ↓
    coldStartScan(jsonlPath) → 초기 상태
    ↓
    store.register(session)
    ↓
    setInstanceConversationId(identity, convId) → state.json 저장
    ↓
    SessionStateMachine 생성
    ↓
    ensureTmuxSessionName(paneId, projectName)
  ↓
  이벤트 연결: session-found, session-lost, session-changed, jsonl-event, hook-event
  ↓
discovery.start() — 주기적 스캔 시작
```

### 훅 이벤트 플로우

```
훅 소켓: { event, sid, pid, cwd, pane } 수신
  ↓
handleHookEvent()
  ↓
1. SDK-cli 세션 필터링
  ↓
2. identity 결정:
   a. hookSidToIdentity 캐시
   b. remoteStateMachines 복합 키
   c. PID 조상 탐색
  ↓
  NOT FOUND인 경우:
    session-start + 미등록 세션 확인
      ↓
      CWD + PID로 dyingSession 탐색
      ↓
      즐겨찾기 메타데이터 이전
      ↓
      registerSession(hookSid, skipJsonlFallback=true)
      ↓
      Return
  ↓
  FOUND인 경우:
    3. Stale sessionId 감지
      ↓
      hookSid ≠ 저장된 sessionId 시:
        이전 JSONL watch 해제
        sessionId 갱신
        새 JSONL watch 시작
    ↓
    4. paneId 업그레이드 감지
      ↓
      새 paneId가 있으면:
        identity 재키 (oldIdentity → newIdentity)
        FSM 맵 갱신
    ↓
    5. FSM 전환
      ↓
      mapHookToInput(event) → InputEvent
      fsm.transition(inputEvent)
    ↓
    6. 사후 갱신
      ↓
      session-start + idle 상태: refreshSessionAfterResume()
      user-prompt: 요약 갱신
      pre-tool: toolCallCount 증가
```

### /resume 감지

```
훅: event.event === 'session-start', fsm.getState() === 'idle'
  ↓
refreshSessionAfterResume()
  ↓
projectDir/ 스캔 → mtime 내림차순 정렬
  ↓
최신 파일 ≠ 현재 JSONL인 경우:
  jsonlPaths[sessionId] → 최신 파일로 교체
  이전 JSONL unwatch, 새 JSONL watch
  stale 요약 초기화 (goalSummary, contextSummary, nextSteps)
  ↓
재개된 JSONL에서 요약 재생성
```

## 3-Level ID 계층

```
Instance Identity (pane)   — paneId (%5) 또는 String(pid) ("25142")
    └── Session ID          — sessions/<pid>.json의 sessionId (UUID)
            └── Conversation ID  — JSONL 파일명 (UUID), lastConversationId로 추적
```

| 레벨 | 예시 | 저장 위치 |
|------|------|-----------|
| Instance Identity | `%5` | `instances` 맵의 key |
| Session ID | `01d73b84-...` | `instances["%5"].lastSessionId` |
| Conversation ID | `a6215185-...` | `instances["%5"].lastConversationId` |

## 코드 위치 요약

| 개념 | 파일 | 설명 |
|------|------|------|
| Discovery → sessionId | discovery.ts | sessions 파일 → 환경변수 → JSONL 파일명 |
| registerSession JSONL 선택 | tower.ts | lastConvId → sessionId.jsonl → newest 순서 |
| lastConversationId 저장 | session-store.ts | `setInstanceConversationId()` |
| rehydrateFromState | tower.ts | picker/readOnly 모드 세션 복원 |
| 훅 identity 해석 | tower.ts | `resolveIdentity()` |
| Stale sessionId 감지 | tower.ts | 훅 기반 인-플레이스 보정 |
| paneId 업그레이드 | tower.ts | `store.rekey()` |
| /clear 플로우 | tower.ts | `skipJsonlFallback=true`로 직접 등록 |
| /resume 플로우 | tower.ts | `refreshSessionAfterResume()` |
| 이중 맵 저장소 | session-store.ts | instances + sessionMeta |
| reassociateMeta | session-store.ts | /resume 시 메타데이터 이전 |
| watchedJsonls 체크 | tower.ts | 활성 세션 간 JSONL 충돌 방지 |
| claimedConvIds 체크 | tower.ts | 등록 순서 race condition 방지 |
| assignedConvIds 체크 | tower.ts | rehydration 중 convId 중복 배제 |
| PID 조상 탐색 | tower.ts | `resolveIdentity()` 내 while 루프 |

## 관련 문서

- **`doc/claude_id_mapping.md`** — 3-level ID 계층 구조 상세 설명 및 state.json 구조
- **`doc/algorithms.md`** — 상태 머신, JSONL 추론, LLM 요약 워크플로우
