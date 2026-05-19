# Claude ID Mapping

popmux/Tower가 세션을 추적할 때 사용하는 3가지 ID 레벨과 그 관계.

## ID 계층 구조

```
Instance Identity (pane)
    └── Session ID          ← sessions/<pid>.json의 sessionId
            └── Conversation ID  ← JSONL 파일명 (UUID)
```

## 각 ID 설명

### 1. Instance Identity

- **값**: tmux pane ID (`%5`, `%13`) 또는 PID 문자열 (`0`, `25142`)
- **출처**: `tmux list-panes`의 `#{pane_id}`
- **용도**: Tower의 세션 추적 기본 키 (`instances` map의 key)
- **특징**: 프로세스가 바뀌어도 같은 pane이면 동일한 identity
- **state.json 위치**: `instances["<identity>"].lastSessionId`

### 2. Session ID

- **값**: UUID (예: `01d73b84-dac8-4de0-be9b-eb0caefc2ab5`)
- **출처**: `~/.claude/sessions/<pid>.json`의 `sessionId` 필드
- **용도**: Tower의 내부 세션 식별자, `jsonlPaths` map의 key
- **특징**: 같은 Claude 프로세스 내에서 안정적. `/clear`나 새 세션 시작 시 변경될 수 있음
- **state.json 위치**: `sessions["<sessionId>"]`의 key, `instances["<identity>"].lastSessionId`

### 3. Conversation ID

- **값**: UUID (예: `a6215185-b139-438e-b03b-dd399351f2d7`)
- **출처**: `~/.claude/projects/<slug>/<conversationId>.jsonl` 파일명
- **용도**: 실제 JSONL 대화 파일 식별. `custom-title` 등 대화 이벤트 위치
- **특징**: `/clear` 시마다 새 UUID 생성. Session ID와 다를 수 있음
- **state.json 위치**: `instances["<identity>"].lastConversationId`

## ID 불일치 시나리오

### Session ID ≠ Conversation ID (가장 흔한 케이스)

```
sessions/25142.json → sessionId: "01d73b84"
projects/.../01d73b84.jsonl → 존재하지 않음!
projects/.../a6215185.jsonl → 실제 대화 파일 (최근 수정)
```

**발생 원인**: Claude Code가 `sessions/<pid>.json`의 sessionId와 다른 UUID로 JSONL 파일을 생성하는 경우.

**Tower의 처리** (`registerSession`):
1. `{sessionId}.jsonl` 존재 확인
2. 없으면 해당 프로젝트 디렉토리의 최신 JSONL로 fallback
3. 실제 JSONL path를 `jsonlPaths[sessionId]`에 저장
4. `instances[identity].lastConversationId`에 conversation UUID 저장

### 주의: JSONL 내부의 `sessionId` 필드

JSONL 파일 내부 각 라인에도 `sessionId` 필드가 있음. 이 값은 **파일명(conversation ID)** 과 동일:

```json
{"type":"custom-title","customTitle":"nss-new-nvme","sessionId":"a6215185-..."}
```

파일명 UUID = 내부 sessionId UUID → Conversation ID.

## state.json 구조 예시

```json
{
  "instances": {
    "%5": {
      "lastSessionId": "01d73b84-dac8-4de0-be9b-eb0caefc2ab5",
      "lastConversationId": "a6215185-b139-438e-b03b-dd399351f2d7"
    }
  },
  "sessions": {
    "01d73b84-dac8-4de0-be9b-eb0caefc2ab5": {
      "cwd": "/home/kevin.park/workspace/shared-storage",
      "label": "nss-new-nvme",
      "startedAt": 1778827264621
    }
  }
}
```

## JSONL 파일 위치 해석

```
~/.claude/projects/<slug>/<conversationId>.jsonl
```

- `<slug>`: cwd를 `-`로 변환한 경로 (예: `/home/user/foo` → `-home-user-foo`)
- `<conversationId>`: Conversation ID UUID

## Tower의 JSONL 경로 결정 우선순위

`rehydrateFromState` (picker 모드)에서 사용하는 순서:

1. `inst.lastConversationId` → `{convId}.jsonl` (가장 정확, 이전 Tower 실행에서 저장)
2. `{sessionId}.jsonl` (session ID와 동일한 경우)
3. 해당 프로젝트 디렉토리의 최신 수정 JSONL (최후 fallback)

## 관련 코드 위치

| 위치 | 역할 |
|------|------|
| `session-store.ts:PersistedInstance` | `lastConversationId` 필드 정의 |
| `session-store.ts:setInstanceConversationId()` | conversation ID 저장 메서드 |
| `tower.ts:registerSession()` | JSONL path 결정 + conversationId 저장 |
| `tower.ts:rehydrateFromState()` | picker 시작 시 JSONL 경로 해석 |
| `tower.ts:handleJsonlEvent()` | JSONL 이벤트 처리 (custom-title 포함) |
