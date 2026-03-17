# cc-tower: Claude Code Session Control Tower

## Product Requirements Document (PRD)

**Version:** 0.1.0-draft
**Date:** 2026-03-15
**Author:** jaeyoungs + Claude
**Language:** 한국어 설명 + 영어 기술 식별자 혼용

---

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | 2026-03-15 | Initial draft |
| 0.1.1 | 2026-03-15 | 리뷰 반영: Hook 포맷 검증, JSONL 필드 경로 수정, ppid 체인 워킹, 3-tier 키바인딩 분리, 스마트 알림, no-daemon 설계, session group Peek, 성공 지표, 테스트 전략 |
| 0.1.2 | 2026-03-16 | 구현 반영: Zoom 제거 → 2-Tier 상호작용(Send/Peek), LLM 요약 방식 변경(parallel claude --print), JSONL 경로 fallback, 세션 라이프사이클 개선(session-changed 이벤트, dead 세션 처리), TUI 개선(alt screen, SIGWINCH, cleanDisplayText), Hook sender shell script(socat/nc fallback), persistSync 종료 처리 |
| 0.1.3 | 2026-03-17 | Phase 2 재설계: WebSocket 서버 제거 → SSH 기반 원격 세션 지원(Phase 1.5)으로 대체. SSH socket forwarding(hooks: true) + JSONL polling(hooks: false) 2-mode 설계. Remote Peek/Send/Hook install. HOST 컬럼 추가. 기존 WebSocket 서버 아키텍처는 Phase 2(Web UI/팀 협업)로 이동. |

---

## Table of Contents

1. [Overview](#1-overview)
2. [User Personas](#2-user-personas)
3. [Technical Discovery](#3-technical-discovery)
4. [Functional Requirements](#4-functional-requirements)
   - 4.1 Session Discovery & Registration
   - 4.2 Real-time State Tracking (Hook-Primary)
   - 4.3 TUI Dashboard
   - 4.4 Notifications
   - 4.5 Session Lifecycle
5. [Non-Functional Requirements](#5-non-functional-requirements)
6. [Architecture](#6-architecture)
7. [Data Flow](#7-data-flow)
8. [CLI Interface](#8-cli-interface)
9. [Configuration](#9-configuration)
10. [Key Interactions & Edge Cases](#10-key-interactions--edge-cases)
11. [Phase 1.5 — SSH Remote Support](#11-phase-15--ssh-remote-support)
12. [Phase 2 Considerations](#12-phase-2-considerations-web-ui--team-features)
13. [Milestones & Deliverables](#13-milestones--deliverables)
14. [Open Questions](#14-open-questions)
15. [Appendices](#appendix-a-competitive-analysis)

---

## Glossary

| 용어 | 정의 |
|------|------|
| **Turn** | 하나의 user→assistant 교환 단위. 사용자 메시지 전송부터 Claude가 `end_turn`으로 응답 완료할 때까지. |
| **Session** | 하나의 Claude Code 프로세스 실행 단위. PID + sessionId로 식별. |
| **Pane** | tmux 내 하나의 터미널 영역. pane ID (e.g., `%5`)로 식별. |
| **Slug** | cwd를 `/` → `-`로 치환한 프로젝트 디렉토리명 (e.g., `-home-user-workspace-app`). |

---

## 1. Overview

### 1.1 Project Name

**cc-tower** (Claude Code Control Tower)

관제탑 메타포: 여러 Claude Code 세션을 "항공기"로, 대시보드를 "관제탑"으로 비유한다.
- 활주로에 있는 비행기(세션) 모니터링
- 착륙(작업 완료) 시 알림
- 무선 통신(tmux send-keys)으로 명령 전달

### 1.2 Problem Statement

Claude Code를 tmux에서 여러 pane으로 동시 실행할 때:
- 어떤 세션이 어떤 작업을 하는지 한눈에 파악이 안 됨
- 작업 완료를 감지하려면 각 pane을 직접 확인해야 함
- 완료된 세션에 후속 명령을 주려면 해당 pane으로 직접 이동해야 함
- 세션 간 컨텍스트(프로젝트, 작업 내용, 상태)가 기록되지 않음

### 1.3 Solution

**핵심 가치:** cc-tower는 프로세스가 살아있는지가 아니라, Claude가 **무엇을 생각하고 있는지**를 보여준다.
htop은 CPU를 보여주지만, cc-tower는 "DB 마이그레이션 테스트 수정 중 — 9개 중 8개 통과"를 보여준다.
이 **semantic awareness**가 단순 프로세스 모니터링과의 차이이자, 병렬 Claude 세션 운용을 실용적으로 만드는 핵심이다.

tmux pane 정보 + Claude Code 내부 상태 파일을 결합하여:
1. 실행 중인 모든 Claude Code 세션을 자동 탐지
2. 각 세션의 상태(idle/thinking/executing)를 실시간 추적
3. TUI 대시보드에서 통합 모니터링
4. 작업 완료 알림 (desktop notification, sound, webhook)
5. 대시보드에서 직접 명령 전달 (tmux pane 연결)

### 1.4 Scope

| Phase | Scope | Target |
|-------|-------|--------|
| **Phase 1** | Local MVP — 단일 머신, tmux + Claude Code | ✓ Complete |
| **Phase 1.5** | SSH Remote Support — 원격 서버 세션 통합 | Next |
| **Phase 2** | Web UI + Team features — 팀 협업, 브라우저 대시보드 | Future |

이 PRD는 **Phase 1 (Local MVP)** 에 집중하되, Phase 1.5 SSH 원격 지원 및 Phase 2 확장을 위한 아키텍처 설계를 포함한다.

---

## 2. User Personas

### 2.1 Primary: Power User (Phase 1)

- tmux + Claude Code를 일상적으로 사용하는 개발자
- 동시에 2~8개의 Claude Code 세션을 운영
- 세션별로 다른 프로젝트/작업을 병렬 수행
- 한 화면에서 전체 상황을 파악하고 싶음

### 2.2 Secondary: Team Lead (Phase 2+)

- 여러 개발자의 Claude Code 세션을 원격 모니터링
- 팀 전체의 AI 사용 현황 파악
- 비용 추적 및 리소스 관리

---

## 3. Technical Discovery (사전 조사 결과)

### 3.1 Claude Code 세션 탐지 경로

```
~/.claude/sessions/<pid>.json
→ {"pid": 12345, "sessionId": "uuid", "cwd": "/path", "startedAt": 1234567890}
```

- 파일명이 PID → `kill -0 <pid>`로 생존 확인
- sessionId로 JSONL 대화 로그 접근 가능
- cwd로 프로젝트 식별

**JSONL 경로 해석 알고리즘 (검증됨):**

```
입력: session.cwd = "/home/jaeyoungs/workspace/cc-session"
      session.sessionId = "9445bc28-5fce-45ab-a37c-4d8586462a18"

1. slug = cwd.replace(/\//g, '-')
   → "-home-jaeyoungs-workspace-cc-session"

2. JSONL 경로 = ~/.claude/projects/{slug}/{sessionId}.jsonl
   → ~/.claude/projects/-home-jaeyoungs-workspace-cc-session/9445bc28-...jsonl

3. 서브에이전트 로그 = ~/.claude/projects/{slug}/{sessionId}/subagents/agent-{agentId}.jsonl
```

- leading dash(`-`) 포함 (root `/`가 `-`로 변환)
- 특수문자/공백은 미검증 — edge case로 관리

**JSONL 경로 Fallback (--continue/--resume 대응):**

`--continue` 또는 `--resume` 플래그로 Claude를 재시작하면 sessionId가 변경되어
`{sessionId}.jsonl`이 존재하지 않을 수 있다. 이 경우:

```
1. {sessionId}.jsonl 존재 확인
2. 없으면 → ~/.claude/projects/{slug}/ 디렉토리에서
   가장 최근에 수정된 .jsonl 파일을 사용
3. 해당 파일로 JSONL 모니터링 시작
```

이 fallback으로 --continue/--resume 세션도 정상 추적된다.

### 3.2 상태 추론 방법

| 상태 | 추론 방법 |
|------|----------|
| **Idle** (입력 대기) | JSONL `type=assistant`, `message.stop_reason="end_turn"` |
| **Thinking** (모델 응답 중) | JSONL `type=assistant`, `message.stop_reason=null` (streaming) |
| **Executing** (도구 실행) | JSONL `type=assistant`, `message.stop_reason="tool_use"` |
| **Agent** (서브에이전트) | JSONL `type=progress`, `data.type="agent_progress"` |

**JSONL 메시지 구조 (검증됨):**
- top-level `type`: `"user"` | `"assistant"` | `"progress"` | `"system"` | `"file-history-snapshot"`
- `stop_reason`은 **`message.stop_reason`** 으로 중첩 (`d.message.stop_reason`)
- `usage`(토큰)도 **`message.usage`** 로 중첩
- `progress` 타입의 서브타입은 `data.type`: `"hook_progress"` | `"agent_progress"`

### 3.3 tmux 연동 메커니즘

| 기능 | tmux API |
|------|----------|
| 세션/pane 목록 | `tmux list-panes -a -F '#{pane_id} #{pane_pid} #{pane_tty}'` |
| PID↔Pane 매핑 | `ps -o tty= -p <pid>` → tmux pane TTY 매칭 |
| 화면 캡처 | `tmux capture-pane -t <pane_id> -p -S -100` |
| 출력 스트리밍 | `tmux pipe-pane -t <pane_id> -O 'command'` |
| 명령 전달 | `tmux send-keys -t <pane_id> 'text' Enter` |
| 활동 감지 | tmux hooks (`alert-activity`, `alert-silence`) |

### 3.4 tmux 환경 보장 문제

Claude Code는 반드시 tmux 안에서 실행된다는 보장이 없다.
일반 터미널, VS Code 통합 터미널, SSH, screen 등 어디서든 실행 가능.

**탐지 메커니즘: PID → ppid 체인 워킹 → tmux pane 매칭**

Claude가 nvim 내 터미널에서 실행되면 Claude 자체의 TTY는 tmux pane과 매칭되지 않는다.
**ppid 체인을 따라 올라가며** 조상 프로세스의 TTY가 tmux pane과 매칭되는지 확인해야 한다.

```
실제 예시 (검증됨):
  PID=120410  claude    tty=pts/35  ppid=120399   ← Claude (pts/35는 nvim 내부 PTY)
  PID=120399  nvim      tty=?       ppid=120398
  PID=120398  nvim      tty=pts/34  ppid=120216   ← nvim (pts/34가 tmux pane의 TTY)
  PID=120216  zsh       tty=pts/34  ppid=95       ← tmux pane의 shell

  tmux: %7 = /dev/pts/34  ← 매칭!
```

```bash
# 알고리즘: ppid 체인 워킹
resolve_pane() {
  local pid=$1
  local pane_ttys=$(tmux list-panes -a -F '#{pane_tty} #{pane_id}')

  while [ $pid -gt 1 ]; do
    local tty=$(ps -o tty= -p $pid 2>/dev/null | tr -d ' ')
    if [ -n "$tty" ] && [ "$tty" != "?" ]; then
      local match=$(echo "$pane_ttys" | grep "/dev/$tty" | awk '{print $2}')
      if [ -n "$match" ]; then
        echo "$match"  # pane ID (e.g., %7)
        return 0
      fi
    fi
    pid=$(ps -o ppid= -p $pid 2>/dev/null | tr -d ' ')
  done
  return 1  # tmux pane 매칭 실패 → Monitor-only
}
```

- Claude 자체 TTY로 매칭 시도 → 실패 시 ppid 따라 올라감
- 조상 중 하나의 TTY가 tmux pane과 매칭되면 성공
- 끝까지 매칭 안 되면 Monitor-only (tmux 밖)

**세션 환경 분류: tmux 매칭 여부의 이진 판단**

ppid 체인 워킹으로 tmux pane 매칭을 시도.
성공/실패 두 가지만 구분 — nvim, vscode 등 중간 환경을 별도 처리하지 않음.

| 매칭 결과 | 기능 수준 | 대시보드 표시 |
|----------|----------|-------------|
| **pane 매칭 성공** | **Full** — 모니터링 + Peek/Send | 상단, 정상 색상 |
| **pane 매칭 실패** | **Monitor-only** — 상태/요약/알림만 | 하단, dim 처리 |

**대시보드 정렬 및 표시:**

tmux 세션이 항상 위, non-tmux 세션은 구분선 아래에 dim 색상으로 표시.
Peek/Send 키를 눌러도 동작하지 않고 안내 메시지만 표시.

```
#  PANE  LABEL            STATUS    TASK
1  %3   migration-api    ● EXEC    bash: npm test
2  %5   frontend-dash    ◐ THINK   "Add tooltip..."
3  %7   auth-refactor    ○ IDLE    ✓ Token refresh
──────────────────────────────────────────────────── (monitor-only)
4  —    vscode-work      ○ IDLE    ✓ API docs updated       (dim)
5  —    ssh-session      ◐ THINK   DB migration             (dim)
```

**전략: 단순한 이진 분류**

1. **모든 Claude 세션을 탐지** — `~/.claude/sessions/*.json`은 tmux와 무관
2. **ppid 체인 워킹으로 tmux pane 매칭 시도** — 성공 = Full, 실패 = Monitor-only
3. **Monitor-only 세션도 대시보드에 표시** — 상태/요약/알림은 동일하게 제공
4. **상호작용 시도 시 안내** — "이 세션은 tmux pane과 연결되지 않았습니다."

**cc-tower를 통한 세션 생성 시 tmux 보장:**

```bash
# cc-tower new 는 항상 tmux pane에서 Claude를 실행
cc-tower new --cwd ~/workspace/my-app --label "feature"

# 내부 동작:
tmux split-window -h -c ~/workspace/my-app "claude"
# → 반드시 tmux 안에서 생성되므로 Full 기능 보장
```

`cc-tower new`로 생성한 세션은 항상 tmux 안에서 실행되므로 Full 기능이 보장됨.
기존에 tmux 밖에서 실행된 세션은 Monitor-only로 graceful degradation.

### 3.5 기타 제약 사항

1. **네이티브 IPC 없음**: 실행 중인 Claude Code 인스턴스에 API로 접근 불가
2. **입력은 send-keys만**: tmux를 통한 키 입력이 유일한 명령 전달 방법
3. **nvim 중첩**: Claude가 nvim 내 터미널에서 실행될 경우 send-keys가 nvim으로 전달됨
4. **JSONL은 append-only**: 파일 크기가 계속 증가, tail -f 방식 모니터링 필요

---

## 4. Functional Requirements

### 4.1 Core: Session Discovery & Registration

#### FR-1: 자동 세션 탐지

- `~/.claude/sessions/*.json` 파일을 주기적으로 스캔 (기본 2초)
- 새로운 PID 파일 발견 시 자동 등록
- PID 생존 확인 (`kill -0`) 후 죽은 세션 정리
- tmux pane ID와 자동 매핑 (PID → TTY → pane)

#### FR-2: 세션 메타데이터 수집

각 세션에 대해 다음 정보를 수집/유지:

```typescript
interface Session {
  // Identity
  pid: number;
  sessionId: string;
  paneId?: string;          // tmux pane ID (e.g., %5). null = Monitor-only
  hasTmux: boolean;         // tmux pane 매칭 여부 (true=Full, false=Monitor-only)
  detectionMode: 'hook' | 'jsonl' | 'process';  // 상태 감지 방식 (FR-4 참조)

  // Context
  cwd: string;              // 작업 디렉토리
  projectName: string;      // cwd에서 추출한 프로젝트명

  // State
  status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
  lastActivity: Date;
  currentTask?: string;     // 마지막 user 메시지 요약
  currentSummary?: TurnSummary;  // 최신 턴 요약 (FR-5.1 참조)

  // Stats
  startedAt: Date;
  messageCount: number;
  toolCallCount: number;
  estimatedCost?: number;   // JSONL의 message.usage 데이터에서 추정

  // LLM Summary
  contextSummary?: string;  // LLM 요약 결과 (Tier 3)
  summaryLoading?: boolean; // 요약 로딩 중 여부 (대시보드 `⟳ summarizing...` 표시용)

  // User-defined
  label?: string;           // 사용자가 부여한 별칭
  tags?: string[];          // 분류 태그
}
```

#### FR-2.1: Hook 플러그인 설치 온보딩

cc-tower 첫 실행 시 hook 플러그인 미설치 감지 → 자동 설치 안내:

```
╭─ cc-tower ──────────────────────────────────────────────╮
│                                                          │
│  ⚠ cc-tower hook plugin이 설치되지 않았습니다.          │
│                                                          │
│  Hook 없이도 동작하지만 (JSONL fallback),                │
│  Hook을 설치하면 실시간 상태 감지 + 풍부한 정보를 받습니다. │
│                                                          │
│  [y] 지금 설치  [n] 나중에  [?] 차이점 보기              │
╰──────────────────────────────────────────────────────────╯
```

설치 명령: `cc-tower install-hooks`
- `~/.claude/plugins/cc-tower/hooks/hooks.json` 생성
- `~/.claude/plugins/cc-tower/plugin.json` 생성 (플러그인 매니페스트)
- 설치 후 **새로 시작하는 Claude 세션**부터 hook 활성화
  (이미 실행 중인 세션은 JSONL fallback 유지)

#### FR-3: 수동 세션 등록

자동 탐지 외에도 수동으로 세션을 추적 대상에 추가:
- `cc-tower watch <pane_id>` — 특정 tmux pane 모니터링 시작
- `cc-tower label <session> "migration work"` — 세션에 별칭 부여
- `cc-tower tag <session> backend urgent` — 태그 부여

### 4.2 Core: Real-time State Tracking

#### FR-4: 상태 감지 엔진 (Hook-Primary Architecture)

Claude Code는 네이티브 Hook 시스템을 제공한다 (plugin `hooks.json`).
cc-tower는 이를 **primary signal**로 활용하고, JSONL/프로세스를 fallback으로 사용.

##### Primary: Claude Code Hooks (지연 ~5ms (shell sender), 이벤트 드리븐)

cc-tower가 Claude Code 플러그인으로 hook을 등록하면,
**모든 상태 전이를 push로 즉시 수신** 가능:

```
Hook Event               →  상태 전이           →  cc-tower 동작
─────────────────────────────────────────────────────────────────
SessionStart             →  세션 생성            →  register session
UserPromptSubmit         →  idle → thinking     →  update status + extract task
PreToolUse               →  thinking → executing →  update status + tool name
PostToolUse              →  executing → thinking →  update status + tool result
SubagentStart            →  → agent             →  update status + agent type
SubagentStop             →  agent →             →  update status
Stop                     →  → idle              →  update status + trigger notification
SessionEnd               →  → dead              →  unregister session
```

**Hook 구현:**

```json
// ~/.claude/plugins/cc-tower/hooks/hooks.json
// 플러그인 hook 포맷: 이벤트명을 키로 하는 map 구조
// (검증: OMC, hookify, ralph-loop 등 실제 플러그인과 동일 포맷)
{
  "description": "cc-tower session monitoring hooks",
  "hooks": {
    "SessionStart": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook session-start", "timeout": 3 }]
    }],
    "UserPromptSubmit": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook user-prompt", "timeout": 3 }]
    }],
    "PreToolUse": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook pre-tool", "timeout": 3 }]
    }],
    "PostToolUse": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook post-tool", "timeout": 3 }]
    }],
    "SubagentStart": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook agent-start", "timeout": 3 }]
    }],
    "SubagentStop": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook agent-stop", "timeout": 3 }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook stop", "timeout": 3 }]
    }],
    "SessionEnd": [{
      "hooks": [{ "type": "command", "command": "cc-tower hook session-end", "timeout": 3 }]
    }]
  }
}
```

**Hook sender 구현 (shell script + socat/nc fallback):**
Hook command는 Node.js 실행 오버헤드(~100-150ms)를 피하기 위해 shell script로 구현.
`socat`이 없는 환경을 위해 `nc`(netcat) fallback을 제공:
```bash
#!/bin/sh
# cc-tower hook sender (lightweight shell script)
PAYLOAD="{\"event\":\"$1\",\"sid\":\"$CLAUDE_SESSION_ID\",\"ts\":$(date +%s%3N)}"
SOCK="${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock"
if command -v socat >/dev/null 2>&1; then
  echo "$PAYLOAD" | socat - UNIX-CONNECT:"$SOCK" 2>/dev/null
elif command -v nc >/dev/null 2>&1; then
  echo "$PAYLOAD" | nc -U "$SOCK" 2>/dev/null
fi
exit 0
```
레이턴시: ~5ms (socat/nc 경로)

**Hook → cc-tower 통신 (Fire-and-Forget):**

```
Hook command 실행 시:
1. cc-tower hook <event> 가 호출됨
2. 환경변수에서 세션 정보 추출 ($CLAUDE_SESSION_ID, $CLAUDE_CWD 등)
3. stdin으로 hook context (tool name, prompt 등) 수신
4. Unix socket (${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock) 으로 전송 시도
5. cc-tower가 돌고 있으면 → 수신, 상태 업데이트
   cc-tower가 안 돌고 있으면 → 연결 실패, 이벤트 유실 (OK)
6. hook command는 즉시 종료 (socket 연결 실패도 exit 0)
```

**설계 원칙: No Daemon, No Persistence**

- cc-tower는 **TUI 프로세스 하나**만 존재. 별도 daemon 없음.
- Hook 이벤트는 cc-tower가 안 돌고 있으면 **유실되며, 이는 의도된 동작**.
- cc-tower 시작 시 `sessions/*.json` + JSONL 끝부분 스캔으로 **현재 상태를 복원**.
  과거 이벤트 이력은 필요 없고, "지금 어떤 상태인가"만 알면 됨.

**cc-tower 시작 시 상태 복원 (Cold Start):**
```
1. ~/.claude/sessions/*.json 스캔 → 활성 세션 목록
2. 각 세션의 JSONL 파일 끝에서 역방향 라인 스캔:
   - 파일 끝에서 역순으로 완전한 JSON 라인을 읽음
   - type=assistant + message.stop_reason != null 인 라인을 찾을 때까지
   - 최대 50라인 또는 512KB 중 먼저 도달하는 지점까지
   (대형 tool output이 포함된 세션에서도 안정적으로 상태 복원)
3. 마지막 상태 결정 메시지로 현재 상태 추론
4. PID → ppid 체인 워킹 → tmux pane 매핑
5. 이후부터 Hook (실시간) + JSONL watch (fallback) 로 추적
```

이렇게 하면 cc-tower를 언제 켜든 즉시 현재 상태를 파악하고,
켜져 있는 동안만 실시간 추적. 끄면 추적 중단, 다시 켜면 복원.

**IPC 프로토콜 (Unix Socket):**

```typescript
interface HookEvent {
  event: 'session-start' | 'user-prompt' | 'pre-tool' | 'post-tool'
        | 'agent-start' | 'agent-stop' | 'stop' | 'session-end';
  sessionId: string;
  pid: number;
  cwd: string;
  timestamp: string;
  data?: {
    prompt?: string;        // UserPromptSubmit: 사용자 메시지
    toolName?: string;      // PreToolUse: 도구 이름
    toolInput?: string;     // PreToolUse: 도구 입력 요약
    toolResult?: string;    // PostToolUse: 도구 결과 요약
    agentType?: string;     // SubagentStart: 에이전트 타입
    agentId?: string;       // SubagentStart/Stop: 에이전트 ID
  };
}
```

##### Secondary: JSONL Tail (Fallback, hook 미설치 세션용)

Hook 플러그인이 설치되지 않은 Claude 세션도 모니터링 가능:

```
1. fs.watch로 JSONL 파일 변경 감지 (inotify 기반, 폴링 아님)
2. 변경 시 파일 끝에서 새 라인만 읽기 (seek to last known position)
3. JSON 파싱 → type + stop_reason으로 상태 추론
4. 불완전한 마지막 라인(mid-write) 무시 → 다음 이벤트에서 재시도
```

| JSONL 메시지 | 상태 추론 |
|-------------|----------|
| `type=user` | → thinking (+ `message.content`에서 currentTask 추출) |
| `type=assistant`, `message.stop_reason=null` | thinking (스트리밍 중) |
| `type=assistant`, `message.stop_reason="tool_use"` | → executing |
| `type=assistant`, `message.stop_reason="end_turn"` | → idle |
| `type=progress`, `data.type="agent_progress"` | → agent |
| `type=system`, `subtype="turn_duration"` | turn 완료 확인 (durationMs 포함) |

**JSONL 대형 파일 대응:**
- 파일 전체를 읽지 않음 — 마지막 읽은 offset부터만 읽기
- 세션 시작 시 파일 끝 64KB만 역방향 스캔하여 초기 상태 파악
- 장시간 세션 (10MB+) 에서도 일정한 메모리/CPU 사용

##### Tertiary: Process Monitor (최종 Fallback)

Hook도 없고 JSONL 접근도 실패한 경우:

```
1. kill -0 <pid> → 생존 확인 (5초 주기)
2. ps --ppid <pid> → 자식 프로세스로 도구 실행 감지
   - ephemeral 자식 (zsh, node) → executing
   - 상시 자식만 (MCP bridge) → thinking 또는 idle
3. /proc/<pid>/stat → CPU 사용률로 활성/비활성 구분
```

##### 감지 방식 비교

| | Hook (Primary) | JSONL (Secondary) | Process (Tertiary) |
|---|---|---|---|
| **지연** | ~5ms (shell sender + socket) | ~100ms (inotify) | 1~5초 (polling) |
| **정확도** | 정확 (event 기반) | 높음 (메시지 파싱) | 낮음 (추론) |
| **전제조건** | cc-tower 플러그인 설치 | JSONL 파일 접근 가능 | PID만 알면 됨 |
| **비용** | 0 (이벤트만) | 낮음 (파일 watch) | 낮음 (ps 호출) |
| **상세 정보** | tool name, prompt 등 | 전체 대화 내용 | 실행 중 여부만 |
| **설치 필요** | 예 (plugin) | 아니오 | 아니오 |

**선택 로직:**
```
세션 발견 시:
  if cc-tower plugin 활성 → Hook mode (Primary)
  else if JSONL 파일 접근 가능 → JSONL mode (Secondary)
  else → Process mode (Tertiary)
```

대시보드에서 감지 모드 표시:
```
#  LABEL            MODE    STATUS    TASK
1  migration-api    hook    ● EXEC    bash: npm test
2  frontend-dash    jsonl   ◐ THINK   "Add tooltip..."
3  vscode-work      proc    ● BUSY    (details unavailable)
```

#### FR-5: 상태 전이 이벤트

```
[idle] → UserPromptSubmit      → [thinking]
[thinking] → PreToolUse        → [executing]
[executing] → PostToolUse      → [thinking]
[thinking] → Stop (end_turn)   → [idle]
[*] → SubagentStart            → [agent]
[agent] → SubagentStop         → [previous state]
[*] → SessionEnd / PID 사망    → [dead]
```

각 상태 전이 시 이벤트 발행 → 알림/UI 업데이트/Turn Summary에 사용.

#### FR-5.1: 상태 전이 시 컨텍스트 요약 (Turn Summary)

상태가 변경될 때마다 해당 턴(turn)의 요약을 자동 생성하여 대시보드와 알림에 반영.

**요약 생성 시점:**

| 전이 | 요약 내용 |
|------|----------|
| `→ thinking` | **Task 시작**: user 메시지에서 요청 사항 추출 |
| `→ executing` | **도구 실행**: 어떤 도구를 왜 실행하는지 (tool name + 대상 파일) |
| `→ idle` | **Turn 완료**: 무엇을 했고, 결과가 어떤지 (성공/실패/대기) |
| `→ agent` | **서브에이전트**: 어떤 에이전트가 무슨 작업을 수행 중인지 |
| `→ dead` | **세션 종료**: 마지막 작업 상태 스냅샷 |

**요약 생성 방법 (3-tier, fallback chain):**

```
Tier 1: JSONL 구조적 추출 (즉시, 비용 0)
├─ user 메시지 → 첫 문장 또는 첫 80자 truncate
├─ tool_use → tool name + 입력 파라미터 요약 (파일명, 명령어)
├─ end_turn → assistant 마지막 text block 첫 문장
└─ 실패 시 Tier 2로

Tier 2: 규칙 기반 패턴 매칭 (즉시, 비용 0)
├─ 테스트 결과: "PASS/FAIL" 패턴 → "Tests: 8 passed, 1 failed"
├─ 빌드 결과: "error TS" 패턴 → "Build: 3 errors"
├─ Git 작업: "commit", "push" 패턴 → "Committed: abc1234"
├─ 파일 변경: Edit tool → "Edited: src/foo.ts:45-52"
└─ 실패 시 Tier 3로

Tier 3: LLM 요약 (비동기, 비용 발생, 선택적)
├─ spawn('sh', ['-c', 'claude --print ...']) 로 병렬 실행 (non-blocking)
├─ readRecentContext: 최근 15개 메시지 (user + assistant + tool), 512KB 범위
├─ 소요시간 ~8-10초/호출, 병렬 실행으로 여러 세션 동시 요약 가능
├─ 캐시: content hash 기반, state.json에 영속 저장 (cold start 즉시 복원)
├─ 대시보드: 요약 로딩 중 `⟳ summarizing...` 표시 (summaryLoading 필드)
└─ config로 활성화/비활성화 가능 (기본: 비활성)
```

**요약 데이터 구조:**

```typescript
interface TurnSummary {
  timestamp: Date;
  transition: string;        // e.g., "thinking → idle"
  summary: string;           // 한 줄 요약 (최대 120자)
  details?: {
    toolsUsed: string[];     // ["bash:npm test", "edit:src/foo.ts"]
    filesChanged: string[];  // ["src/foo.ts", "src/bar.ts"]
    testResult?: {
      passed: number;
      failed: number;
      total: number;
    };
    error?: string;          // 에러 발생 시
  };
  tier: 1 | 2 | 3;          // 어떤 방법으로 생성되었는지
}
```

**요약 활용처:**

| 위치 | 표시 방식 |
|------|----------|
| **대시보드 TASK 컬럼** | 최신 요약 한 줄 (실시간 갱신) |
| **세션 상세 뷰 Activity Log** | 상태 전이마다 요약 기록 누적 |
| **알림 (완료 시)** | 요약 + 상세 (도구 수, 파일, 테스트 결과) |
| **히스토리** | 세션별 요약 타임라인으로 보관 |
| **Peek 팝업** | 상단에 현재 요약 + 하단에 pane 캡처 |

**대시보드 표시 예시:**

```
#  PANE  LABEL            STATUS    TASK (자동 요약)
1  %3   migration-api    ● EXEC    bash: npm test (003.test.ts)
2  %5   frontend-dash    ◐ THINK   "Add tooltip dark mode variant"
3  %7   auth-refactor    ○ IDLE    ✓ Token refresh — 12 tests passed
4  %9   test-suite       ◑ AGENT   agent 2/3: running DB integration
```

상태별 요약 포맷:
- `● EXEC` → 실행 중인 도구: `bash: npm test`
- `◐ THINK` → 현재 처리 중인 요청: `"Add tooltip..."`
- `○ IDLE` → 마지막 완료 결과: `✓ Token refresh — 12 tests passed`
- `◑ AGENT` → 에이전트 진행 상황: `agent 2/3: running DB integration`

**알림 예시 (Turn 완료 시):**

```
╭─ ✓ Session #3 auth-refactor ──────────────────────────╮
│                                                        │
│  Task:     Add rate limiting to token refresh          │
│  Result:   ✓ Completed — all 12 tests passing          │
│  Duration: 2m 34s                                      │
│  Changes:  src/auth/token.ts, src/middleware/rate.ts   │
│  Tools:    Read ×3, Edit ×2, Bash ×4                   │
│                                                        │
╰────────────────────────────────────────────────────────╯
```

**설정:**

```yaml
# ~/.config/cc-tower/config.yaml
summary:
  enabled: true
  max_length: 120             # 요약 최대 길이 (자)
  llm_summary: false          # Tier 3 LLM 요약 활성화
  llm_model: "haiku"          # LLM 요약 시 사용할 모델
  llm_max_tokens: 50          # LLM 요약 최대 토큰
  history_retain: 100         # 세션당 요약 보관 수
```

### 4.3 Core: TUI Dashboard

#### FR-6: 메인 대시보드 뷰

터미널 기반 대시보드 (TUI). 실행: `cc-tower` 또는 `cc-tower dashboard`.

```
┌─ cc-tower ─────────────────────────────────────────────────────────┐
│                                                                     │
│  SESSION                PROJECT         STATUS     TASK             │
│  ─────────────────────────────────────────────────────────────────  │
│  #1 %3  migration-api   backend-api     ● EXEC     DB schema fix   │
│  #2 %5  frontend-dash   dashboard       ◐ THINK    Chart component │
│  #3 %7  test-runner     backend-api     ○ IDLE     (waiting)       │
│  #4 %9  auth-refactor   auth-service    ● EXEC     Token refresh   │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  [Enter] Detail  [p] Peek  [/] Send  [n] New  [q] Quit            │
│  [l] Label  [f] Filter  [s] Sort  [r] Refresh  [?] Help            │
└─────────────────────────────────────────────────────────────────────┘
```

**빈 상태 (세션 0개):**

```
╭─ cc-tower ──────────────────────────────────────────────╮
│                                                          │
│   활성 Claude Code 세션이 없습니다.                      │
│                                                          │
│   시작하려면:                                            │
│   • [n] 새 세션 시작                                     │
│   • 다른 터미널에서 claude 실행 시 자동 탐지됩니다       │
│                                                          │
│   ⚠ Hook 플러그인 미설치 — [h] 설치하면 실시간 추적     │
│                                                          │
╰─ [n] New  [h] Install hooks  [q] Quit ──────────────────╯
```

**에러 상태 (tmux 밖에서 실행):**

```
╭─ cc-tower ──────────────────────────────────────────────╮
│                                                          │
│  ⚠ tmux 환경이 아닙니다.                                │
│  cc-tower는 tmux 안에서 실행해야 Peek/Send가 동작합니다.│
│                                                          │
│  모니터링 전용 모드로 시작합니다.                        │
│                                                          │
╰──────────────────────────────────────────────────────────╯
```

**상태 아이콘:**
- `●` EXEC (초록, 도구 실행 중)
- `◐` THINK (노랑, 모델 응답 중)
- `◑` AGENT (파랑, 서브에이전트 작업 중)
- `○` IDLE (회색, 입력 대기)
- `✕` DEAD (빨강, 종료됨)

#### FR-6.1: TUI 구현 세부 사항 (구현됨)

**Alt Screen 모드:**
- TUI 진입 시 터미널 alt screen으로 전환 (전체화면 클리어)
- 종료 시 원래 터미널 상태 복원 (`process.exit(0)` 호출)

**동적 터미널 크기 조정 (SIGWINCH):**
- `SIGWINCH` 시그널 수신 시 터미널 크기 재측정 후 레이아웃 재렌더링
- 최소 터미널 크기 가드: 60×15 미만이면 경고 메시지 표시

**동적 TASK 컬럼 너비:**
- 터미널 너비에 따라 TASK 컬럼 너비를 동적으로 조절
- 좁은 터미널에서도 SESSION/STATUS 컬럼 우선 표시

**텍스트 정제 (cleanDisplayText):**
- XML 태그 제거: `<command-name>`, `<task-notification>` 등
- ANSI escape 코드 제거
- 내부 명령 필터링 (isInternalMessage): `/cost`, `<command-name>`, `<task-notification>` 포함 메시지는 대시보드 TASK 컬럼에 표시하지 않음

**persistedMeta (cold start 최적화):**
- cc-tower 시작 시 `state.json`을 미리 로드
- 세션 등록 시 저장된 label, tag, contextSummary를 즉시 병합
- LLM 요약 캐시가 재시작 후에도 즉시 표시됨

#### FR-7: 세션 상세 뷰

세션 선택 후 Enter → 상세 정보:

```
┌─ Session: migration-api (%3) ──────────────────────────────────────┐
│                                                                     │
│  Project:  /home/user/workspace/backend-api                        │
│  PID:      12345                                                    │
│  Status:   ● EXECUTING (bash: npm run test)                        │
│  Started:  2h 15m ago                                              │
│  Messages: 47  │  Tool Calls: 123  │  Cost: ~$2.34                 │
│                                                                     │
│  ── Recent Activity ───────────────────────────────────────────    │
│  14:32:05  [user]  Fix the failing migration test                  │
│  14:32:08  [claude] Analyzing test output...                       │
│  14:32:15  [tool]  bash: npm run test                              │
│  14:32:42  [tool]  edit: src/migrations/003.ts                     │
│  14:32:45  [tool]  bash: npm run test  (running...)                │
│                                                                     │
│  ── Live Output (last 10 lines) ──────────────────────────────    │
│  PASS src/migrations/001.test.ts                                   │
│  PASS src/migrations/002.test.ts                                   │
│  FAIL src/migrations/003.test.ts                                   │
│    ● should handle nullable columns                                │
│                                                                     │
│  [/] Send  [p] Peek  [b] Back                                      │
└─────────────────────────────────────────────────────────────────────┘
```

#### FR-8: 2-Tier Pane Interaction (Send / Peek)

대시보드에서 Claude Code 세션에 접근하는 두 가지 depth:

##### Tier 1: Send (대시보드 유지, 한 줄 전달)

`/` 키 → 텍스트 입력 → `tmux send-keys`로 대상 pane에 전달.
대시보드를 떠나지 않고 간단한 명령만 보낼 때.

```
╭─ cc-tower ───────────────────────────────────────────────╮
│  #   LABEL            STATUS     TASK                    │
│  1   migration-api    ● EXEC     DB schema fix           │
│▸ 2   frontend-dash    ○ IDLE     (waiting)               │
│                                                           │
│  ╭─ Send to #2 frontend-dash (○ IDLE) ────────────────╮ │
│  │ > Add dark mode variant for the tooltip█           │ │
│  │ [Enter] Send  [Esc] Cancel  [Tab] Quick commands   │ │
│  ╰────────────────────────────────────────────────────╯ │
╰──────────────────────────────────────────────────────────╯
```

Quick Commands (`Tab`):
- `/compact` — 컨텍스트 압축
- `/status` — 세션 상태
- `/cost` — 비용 확인
- `Ctrl+C` — 작업 중단

##### Tier 2: Peek (tmux popup, 실제 pane 라이브 뷰)

`p` 키 → `tmux display-popup` 안에서 **session group**을 통해 실제 pane을 라이브로 표시.
capture가 아닌 **동일한 pane을 두 번째 클라이언트로 직접 보는 방식**.

```
╭─ cc-tower ───────────────────────────────────────────────╮
│  ┏━ 🔴 LIVE ━ #1 migration-api ━ ● EXEC ━━━━━━━━━━━━┓  │
│  ┃                                                     ┃  │
│  ┃  Edit src/migrations/003.ts                        ┃  │
│  ┃  ┌────────────────────────────────────────────┐    ┃  │
│  ┃  │ - column: 'email',                        │    ┃  │
│  ┃  │ + column: 'email', nullable: true,        │    ┃  │
│  ┃  └────────────────────────────────────────────┘    ┃  │
│  ┃                                                     ┃  │
│  ┃  Bash: npm run test                                ┃  │
│  ┃  PASS  001.test.ts                                 ┃  │
│  ┃  PASS  002.test.ts                                 ┃  │
│  ┃  RUN   003.test.ts ...                             ┃  │
│  ┃                                                     ┃  │
│  ┃  > █  ← 직접 타이핑 가능 (실제 pane)              ┃  │
│  ┃                                                     ┃  │
│  ┃  [Esc] Close                                        ┃  │
│  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛  │
╰──────────────────────────────────────────────────────────╯
```

**구현: tmux session group**

```bash
# 1. 현재 세션과 window를 공유하는 임시 그룹 세션 생성
tmux new-session -d -s _cctower_peek -t ${current_session}

# 2. popup 안에서 그룹 세션에 attach + 대상 window 선택
tmux display-popup -E -w 80% -h 80% \
  "tmux attach -t _cctower_peek \; select-window -t :${target_window_index}"

# 3. popup 닫힐 때 (-E) 그룹 세션 자동 정리
tmux kill-session -t _cctower_peek 2>/dev/null
```

**session group이 capture보다 나은 이유:**

| | Session Group (채택) | capture-pane (대안) |
|---|---|---|
| 실시간성 | 동일 pane, 지연 0 | 0.5초 주기 폴링 |
| 색상/포맷 | 완벽 (네이티브 렌더링) | `-e` 필요, ANSI 파싱 |
| 입력 | **직접 타이핑** (native stdin) | send-keys 프록시 |
| 스크롤백 | tmux 네이티브 스크롤 | `-S` 범위 지정 |
| CPU | 추가 비용 0 | 폴링 루프 |
| 구현 복잡도 | tmux 명령 3줄 | 캡처+파싱+렌더 루프 |

**제약:**
- window 단위 공유이므로, 대상 pane이 다른 pane과 같은 window에 있으면 함께 보임
  → Claude는 보통 pane 1개에서 단독 실행하므로 실질적 문제 아님
- 그룹 세션에서의 레이아웃 변경은 원본에도 반영됨
  → popup 크기가 곧 뷰 크기이므로 별도 전체화면 전환 불필요

**Peek에서 직접 입력이 가능하므로**, send-keys 프록시 없이 실제 pane과 네이티브 상호작용이 가능하다.

##### Interaction Tier 요약

| 키 | Tier | 방식 | 용도 | 대시보드 |
|----|------|------|------|----------|
| `/` | **Send** | `send-keys` 프록시 | 한 줄 명령만 | 유지 |
| `p` | **Peek** | `display-popup` + session group | 라이브 뷰 + 직접 입력 | 오버레이 |

**키 바인딩 정리:**
- `Enter` → Detail (TUI 내 상세 뷰)
- `/` → Send (대시보드 안 떠남, 한 줄 전달)
- `p` → Peek (popup 오버레이, 실제 pane 라이브 + 직접 타이핑)

**흐름:** Detail → Peek (점진적 몰입)

### 4.4 Core: Notifications

**전제: cc-tower TUI가 실행 중일 때만 알림이 동작한다.**
cc-tower가 꺼져 있으면 알림 없음 (의도된 동작).

#### FR-9: 스마트 알림

모든 상태 전이가 아닌, **사용자에게 의미 있는 순간에만** 알림.

**알림 발생 조건 (AND 로직):**

| 조건 | 기본값 | 이유 |
|------|--------|------|
| Turn 소요시간 ≥ `min_duration` | 30초 | 짧은 응답은 알림 불필요 |
| 대시보드가 focus 상태가 아님 | 자동 감지 | 보고 있으면 알림 불필요 |
| 해당 세션이 peek 중이 아님 | 자동 감지 | 직접 보고 있으면 불필요 |
| cooldown 경과 | 30초 | 연속 알림 방지 |

즉, **오래 걸린 작업이 끝났고 + 사용자가 안 보고 있을 때**만 알림.

**알림 채널:**

| 채널 | 구현 | 기본 |
|------|------|------|
| **tmux** | `tmux display-message` + bell | 활성 |
| **Desktop** | `notify-send` (Linux) / `osascript` (macOS) | 활성 |
| **Sound** | `paplay` / `afplay` / `mpv` | 비활성 |
| **Webhook** | HTTP POST | Phase 2 |

**예외 알림 (항상 발생, duration 무관):**

| 이벤트 | 조건 |
|--------|------|
| **에러** | JSONL에서 에러 패턴 감지 시 |
| **비용 초과** | 세션 누적 비용 ≥ `cost_threshold` |
| **세션 죽음** | PID 사망 감지 시 |

**알림 내용:**
```
[cc-tower] ✓ migration-api completed (2m 34s)
DB schema nullable fix — 9 tests passed
```

#### FR-10: 알림 설정

```yaml
# ~/.config/cc-tower/config.yaml
notifications:
  enabled: true
  min_duration: 30           # 초, 이 시간 미만 turn은 알림 안 함
  cooldown: 30               # 초, 같은 세션 알림 최소 간격
  suppress_when_focused: true # 대시보드/peek 중이면 알림 안 함
  channels:
    desktop: true
    tmux_bell: true
    sound: false
  alerts:                    # 예외 알림 (항상 발생)
    on_error: true
    on_cost_threshold: 5.0   # USD
    on_session_death: true
  quiet_hours:
    enabled: false
    start: "23:00"
    end: "07:00"
```

### 4.5 Extended: Session Lifecycle

#### FR-5.2: 세션 라이프사이클 개선 사항 (구현됨)

**session-changed 이벤트 (resume/clear 감지):**

같은 PID에서 `--continue` 또는 `/clear`로 sessionId가 변경되는 경우를 감지:
```
SessionStart hook 수신 시:
  기존 PID와 일치하지만 sessionId가 다르면 → session-changed 이벤트
  → JSONL 경로 재계산 (fallback 포함)
  → 상태 리셋, 새 sessionId로 추적 재시작
```

**Dead 세션 처리:**
- `kill -0 <pid>` 실패 시 세션을 즉시 제거하지 않고 `dead` 상태로 표시 (dim)
- 30초 후 자동 제거 (사용자가 마지막 상태를 확인할 수 있도록)

**새 세션 자동 탐지:**
- `~/.claude/sessions/` 스캔 주기: 2초 이내에 새 세션 발견

**persistSync (종료 시 동기 저장):**
- cc-tower 종료 시(`q` 키, SIGINT, SIGTERM) `process.exit(0)` 호출 전
  `persistSync()`로 state.json을 동기적으로 저장
- LLM 요약 캐시가 다음 cold start에서 즉시 복원됨
- 비동기 persist가 완료되지 않은 채 종료되는 문제 방지

> **Note:** FR-11(새 세션 시작), FR-12(히스토리), FR-13(그룹)은 Phase 1.5로 지연.
> Phase 1은 기존 세션의 탐지/추적/상호작용에 집중.

#### FR-11: 새 세션 시작 (Phase 1.5)

대시보드에서 새 Claude Code 세션을 생성하는 기능. 미결 사항:
- tmux 어디에 pane을 만들지 (같은 window split / 새 window / 새 session)
- claude 실행 옵션 (cwd, model, permission mode, 초기 프롬프트)
- 생성 후 대시보드 유지 vs 자동 Peek
- `cc-tower new` vs 사용자가 직접 tmux + claude 실행 후 자동 탐지에 의존

#### FR-12: 세션 히스토리

종료된 세션의 이력 보관:

```
cc-tower history [--project <name>] [--since <date>]
```

```
  DATE        SESSION          PROJECT       DURATION  COST   TASKS
  2026-03-15  migration-api    backend-api   2h 15m    $3.42  DB schema fix
  2026-03-15  frontend-dash    dashboard     45m       $1.23  Chart component
  2026-03-14  auth-refactor    auth-service  1h 30m    $2.10  Token refresh
```

#### FR-13: 세션 그룹

관련 세션을 그룹으로 묶기:

```
cc-tower group create "sprint-23" --sessions 1,2,4
cc-tower group list
```

대시보드에서 그룹 단위 필터링/모니터링.

---

## 5. Non-Functional Requirements

### 5.1 Performance

| Metric | Target |
|--------|--------|
| 세션 탐지 지연 | < 3초 |
| 상태 업데이트 주기 | 1~2초 |
| 대시보드 렌더링 | < 50ms |
| 메모리 사용 (10 세션) | < 50MB |
| CPU (idle 대시보드) | < 1% |

### 5.2 Reliability

- cc-tower 크래시 시 모니터링 대상 세션에 영향 없음 (read-only 원칙)
- JSONL 파싱 실패 시 graceful degradation (프로세스 기반 상태 추론으로 fallback)
- tmux 세션 재시작 시 자동 재연결

### 5.3 Security

- `send-keys`를 통한 명령 전달 시 확인 프롬프트 (설정으로 끌 수 있음)
- 세션 데이터는 로컬 파일시스템에만 저장 (Phase 1)
- JSONL에 포함된 민감 정보 (API 키 등) 대시보드에 마스킹

### 5.4 Success Metrics

Phase 1은 로컬 CLI 도구이므로 서버 수집 방식 텔레메트리 없이,
cc-tower 자체 로그에서 측정 가능한 지표로 정의.

| 지표 | 정의 | 목표 |
|------|------|------|
| **일일 활성 세션 수** | cc-tower가 한 번이라도 추적한 세션 수/일 | ≥ 3 |
| **Hook 설치율** | hook 모드 세션 / 전체 세션 | ≥ 80% |
| **알림→행동 전환** | 완료 알림 후 5분 내 Send/Peek 사용 비율 | ≥ 50% |
| **Interaction 사용률** | Send/Peek 중 하나라도 사용한 세션 비율 | ≥ 30% |
| **오탐 알림률** | min_duration 이하 turn에서 울린 알림 / 전체 알림 | < 5% |

**가드레일 (악화 방지):**

| 지표 | 임계값 |
|------|--------|
| CPU (idle 대시보드) | < 1% |
| Hook 추가 지연 (Claude 응답 시간 영향) | < 10ms |
| Cold start 시간 | < 3초 |

cc-tower 종료 시 `~/.local/share/cc-tower/usage.json`에 세션 통계를 기록하여 자체 측정 가능.

---

## 6. Architecture

### 6.1 Phase 1: Local Architecture

```
  Claude Code 인스턴스들 (각각 독립 프로세스)
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Claude #1    │  │ Claude #2    │  │ Claude #3    │
  │ (tmux %3)    │  │ (tmux %5)    │  │ (terminal)   │
  │              │  │              │  │              │
  │ cc-tower     │  │ cc-tower     │  │ (plugin 없음) │
  │ plugin 활성  │  │ plugin 활성  │  │              │
  └──────┬───────┘  └──────┬───────┘  └──────────────┘
         │ hook              │ hook              │
         │ events            │ events            │ (no hooks)
         ▼                   ▼                   │
  ┌──────────────────────────────────────────────┤
  │         ${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock (Unix Socket)     │
  └──────────────────┬───────────────────────────┘
                     │
  ┌──────────────────▼──────────────────────────────────┐
  │              cc-tower (TUI process)                         │
  │                                                      │
  │  ┌──────────────┐  ┌───────────────┐                │
  │  │ Hook Receiver │  │ JSONL Watcher │ ← fallback    │
  │  │ (socket srv)  │  │ (fs.watch)    │   (Claude #3) │
  │  └──────┬────────┘  └──────┬────────┘                │
  │         │   push (~5ms)    │  inotify (~100ms)       │
  │         └────────┬─────────┘                         │
  │                  ▼                                    │
  │  ┌───────────────────────┐  ┌───────────────────┐   │
  │  │ State Machine         │  │ Turn Summarizer   │   │
  │  │                       │  │                   │   │
  │  │ per-session FSM:      │  │ JSONL extract     │   │
  │  │ idle↔think↔exec↔agent │  │ pattern match     │   │
  │  └───────────┬───────────┘  │ (opt) LLM summary│   │
  │              │               └────────┬──────────┘   │
  │              ▼                        ▼              │
  │  ┌───────────────────────────────────────────────┐  │
  │  │              Session Store (in-memory)         │  │
  │  │  sessions[], labels, tags, summaries, history  │  │
  │  └───────────────────┬───────────────────────────┘  │
  │                      │                               │
  │         ┌────────────┼────────────┐                  │
  │         ▼            ▼            ▼                  │
  │  ┌───────────┐ ┌──────────┐ ┌───────────────┐      │
  │  │ TUI       │ │ Notifier │ │ Pane          │      │
  │  │ Dashboard │ │          │ │ Interaction   │      │
  │  │ (ink/     │ │ desktop  │ │               │      │
  │  │  ratatui) │ │ sound    │ │ send (keys)   │      │
  │  │          │ │ tmux bell│ │ peek (session  │      │
  │  │          │ │ webhook  │ │       group)   │      │
  │  └───────────┘ └──────────┘ └───────────────┘      │
  └──────────────────────────────────────────────────────┘
         │              │              │
    ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
    │ tmux    │   │ claude  │   │ /proc   │
    │ server  │   │ files   │   │ (ps)    │
    └─────────┘   └─────────┘   └─────────┘
```

**데이터 흐름 요약:**
1. **Hook 설치된 세션** → Hook 이벤트 → Unix Socket → State Machine (~5ms)
2. **Hook 미설치 세션** → JSONL fs.watch → JSONL Parser → State Machine (~100ms)
3. **JSONL 접근 불가** → Process Monitor → State Machine (1~5초)
4. 상태 변경 → Session Store 업데이트 → TUI + Notifier + Summarizer 동시 갱신

**구현 핵심 원칙 (실제 구현 반영):**
- **Hook sender**: shell script (`socat`/`nc` fallback) — Node.js 실행 오버헤드 없음
- **LLM 요약**: `spawn('sh', ['-c', 'claude --print ...'])` 병렬 실행 — non-blocking, execSync 없음
- **Non-blocking**: 모든 I/O는 비동기(spawn/fs.watch/readline) — TUI 렌더링 블로킹 없음
- **종료 처리**: `process.exit(0)` 호출로 lingering 프로세스 정리, persistSync()로 캐시 보존

### 6.2 Phase 2: Server Architecture (설계 방향)

```
┌─────────────┐     ┌─────────────┐
│  Machine A  │     │  Machine B  │
│  cc-tower   │     │  cc-tower   │
│  --agent    │     │  --agent    │
└──────┬──────┘     └──────┬──────┘
       │                    │
       └────────┬───────────┘
                │ WebSocket / gRPC
         ┌──────▼──────┐
         │  cc-tower   │
         │  --server   │
         │             │
         │  Aggregator │
         │  + Web UI   │
         └─────────────┘
```

Agent 모드: 로컬 세션 정보를 수집하여 서버로 전송
Server 모드: 여러 Agent의 데이터를 수집, Web UI 제공

### 6.3 기술 스택 (Phase 1)

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **Language** | TypeScript (Node.js) | Claude Code 생태계와 일관성, npm 배포 용이 |
| **TUI Framework** | [ink](https://github.com/vadimdemedes/ink) (React for CLI) | 선언적 UI, 컴포넌트 기반, 빠른 개발 |
| **JSONL Parsing** | `tail -f` + `readline` | 실시간 스트리밍, 메모리 효율적 |
| **Process Monitoring** | Node.js `child_process` + `ps` | 크로스 플랫폼 |
| **tmux Integration** | `execa` (shell commands) | tmux CLI 래핑 |
| **Config** | YAML (`js-yaml`) | 사람 친화적 설정 |
| **State Persistence** | JSON 파일 (SQLite Phase 2) | 단순성, 의존성 최소화 |
| **Notification** | `node-notifier` | 크로스 플랫폼 데스크톱 알림 |

**Alternative: Rust + ratatui**
- 장점: 성능, 단일 바이너리 배포, 낮은 메모리
- 단점: 개발 속도, TUI 생태계 (ink 대비)
- Phase 2에서 성능 이슈 발생 시 고려

---

## 7. Data Flow

### 7.1 세션 탐지 흐름

```
1. [Scan] ~/.claude/sessions/*.json (2초마다)
2. [Parse] PID, sessionId, cwd 추출
3. [Validate] kill -0 <pid> → 생존 확인
4. [Map] ps -o tty= -p <pid> → TTY 획득
5. [Match] tmux list-panes -a -F '#{pane_id} #{pane_tty}' → pane 매칭
6. [Register] Session Store에 등록/업데이트
7. [Resolve] cwd → project JSONL path 계산
8. [Start] JSONL file watcher 시작
```

### 7.2 상태 추적 흐름

**Primary: Hook 경로 (~5ms 지연)**
```
1. [Hook] Claude Code가 상태 전이 시 cc-tower hook <event> 실행
2. [Parse] stdin + 환경변수에서 sessionId, event type, context 추출
3. [Send] Unix socket (${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock)으로 HookEvent 전송
4. [Receive] cc-tower TUI 프로세스의 Hook Receiver가 수신
5. [Transition] State Machine이 세션 상태 전이 처리
6. [Emit] StateChangeEvent → Dashboard + Notifier + Summarizer
```

**Secondary: JSONL 경로 (hook 미설치, ~100ms 지연)**
```
1. [Watch] fs.watch로 JSONL 파일 변경 감지 (inotify)
2. [Read] 마지막 읽은 offset부터 새 라인만 읽기
3. [Parse] JSON line → type, message.stop_reason 추출
4. [Classify]
   - type=user → thinking (+ message.content에서 currentTask)
   - type=assistant, message.stop_reason="tool_use" → executing
   - type=assistant, message.stop_reason="end_turn" → idle
   - type=progress, data.type="agent_progress" → agent
5. [Emit] StateChangeEvent → Dashboard + Notifier + Summarizer
```

**Tertiary: Process 경로 (최종 fallback, 1~5초 지연)**
```
1. [Poll] 5초마다 ps --ppid <claude_pid>
2. [Detect] ephemeral 자식 프로세스 존재 → executing, 없으면 → idle/thinking
3. [Emit] StateChangeEvent (상세 정보 제한적)
```

### 7.3 Pane Interaction 흐름

```
[Send] (/ 키)
1. [Input] 대시보드 인라인 입력창에 텍스트 입력
2. [Validate] 대상 세션 상태 확인 (실행 중이면 경고)
3. [Send] tmux send-keys -t <pane_id> '<command>' Enter
4. [Monitor] 상태 변화 추적 시작

[Peek] (p 키) — session group 방식
1. [Create] tmux new-session -d -s _cctower_peek -t ${current_session}
2. [Popup] tmux display-popup -E -w 80% -h 80% \
     "tmux attach -t _cctower_peek \; select-window -t :${target_window}"
3. [Interact] 실제 pane이므로 직접 타이핑 가능 (native stdin)
4. [Close] Esc/detach → popup 닫힘 → kill-session _cctower_peek
5. [Close] popup 닫고 대시보드로 복귀

```

---

## 8. CLI Interface

### 8.1 Commands

```bash
# 대시보드 (기본 명령)
cc-tower                          # TUI 대시보드 실행
cc-tower dashboard                # 동일

# 세션 관리
cc-tower list                     # 활성 세션 목록 (non-interactive)
cc-tower list --json              # JSON 출력
cc-tower status <session>         # 특정 세션 상태
cc-tower watch <pane_id>          # 수동으로 pane 모니터링 추가
cc-tower label <session> "name"   # 별칭 부여
cc-tower tag <session> <tags...>  # 태그 부여

# 명령 전달
cc-tower send <session> "message" # 세션에 메시지 전송 (send-keys)
cc-tower peek <session>           # tmux popup으로 pane 미리보기

# 세션 생성 (Phase 1.5)
# cc-tower new [--cwd <path>] [--label <name>]  # 미결 — Phase 1.5에서 설계

# 히스토리
cc-tower history [--project <name>] [--since <date>]

# 그룹
cc-tower group create <name> [--sessions <ids>]
cc-tower group list

# 설정
cc-tower config                   # 설정 편집
cc-tower config set <key> <value>

# 상태 확인 (non-interactive, 스크립트용)
cc-tower status                   # 전체 세션 상태 한 줄씩 출력 후 종료
```

### 8.2 Global Options

```
--config <path>     설정 파일 경로 (기본: ~/.config/cc-tower/config.yaml)
--no-color          컬러 비활성화
--json              JSON 출력 (스크립트 연동용)
--verbose           상세 로그
```

---

## 9. Configuration

```yaml
# ~/.config/cc-tower/config.yaml

# 세션 탐지
discovery:
  scan_interval: 2000          # ms, 세션 스캔 주기
  claude_dir: "~/.claude"      # Claude Code 설정 디렉토리
  auto_discover: true          # 자동 탐지 활성화

# 상태 추적
tracking:
  jsonl_watch: true            # JSONL 파일 모니터링
  process_scan_interval: 5000  # ms, 프로세스 트리 스캔 주기
  pane_capture_interval: 10000 # ms, pane 캡처 주기 (fallback)

# 대시보드
dashboard:
  refresh_rate: 1000           # ms, UI 갱신 주기
  default_sort: "status"       # status | project | name | activity
  show_cost: true              # 비용 표시
  show_dead: false             # 종료된 세션 표시

# 알림 (FR-9, FR-10 참조)
notifications:
  enabled: true
  min_duration: 30             # 초, 이 시간 미만 turn은 알림 안 함
  cooldown: 30                 # 초, 같은 세션 알림 최소 간격
  suppress_when_focused: true  # 대시보드/peek 중이면 알림 안 함
  channels:
    desktop: true
    tmux_bell: true
    sound: false
  alerts:                      # 예외 알림 (항상 발생, duration 무관)
    on_error: true
    on_cost_threshold: 5.0     # USD
    on_session_death: true
  quiet_hours:
    enabled: false
    start: "23:00"
    end: "07:00"

# 명령 전달
commands:
  confirm_before_send: true    # 전송 전 확인
  confirm_when_busy: true      # 실행 중인 세션에 전송 시 경고

# 히스토리
history:
  retain_days: 30              # 히스토리 보관 기간
  store_path: "~/.local/share/cc-tower/history"

# Phase 2: 서버 모드
server:
  enabled: false
  mode: "local"                # local | agent | server
  host: "0.0.0.0"
  port: 7700
  auth_token: null
```

---

## 10. Key Interactions & Edge Cases

### 10.1 tmux 밖 세션 (nvim/vscode/terminal 등)

Claude가 nvim 터미널, vscode 통합 터미널, 일반 터미널 등에서 실행되는 경우:
- ppid 체인 워킹으로 tmux pane 매칭 시도
- **매칭 성공** (nvim이 tmux 안에 있는 경우): `hasTmux=true`, Full 기능
  - 단, Send(`/`)는 nvim을 경유하므로 nvim이 normal mode면 키가 nvim 명령으로 해석될 수 있음
  - Peek이 더 안전한 상호작용 방법 (popup에서 직접 타이핑)
- **매칭 실패**: `hasTmux=false`, Monitor-only, 대시보드 하단에 dim 표시

### 10.2 다중 Claude 세션 (같은 프로젝트)

같은 cwd를 가진 여러 세션이 존재할 수 있음:
- sessionId가 고유하므로 구분 가능
- label로 사용자가 구분할 수 있도록 유도
- 대시보드에서 프로젝트 기준 그룹핑 시 모두 표시

### 10.3 Claude Code 업데이트

Claude Code 버전 업데이트 시 파일 구조가 변경될 수 있음:
- `sessions/*.json` 스키마 변경 → schema validation + graceful fallback
- JSONL 메시지 타입 추가/변경 → unknown type은 무시
- 경로 변경 → config로 override 가능

### 10.4 세션 복구

cc-tower 재시작 시:
- 기존 세션 정보를 `~/.local/share/cc-tower/state.json`에서 복원
- label, tag 등 사용자 메타데이터 보존
- JSONL watcher 재시작 (마지막 읽은 위치부터)

---

## 11. Phase 1.5 — SSH Remote Support

WebSocket 서버나 agent daemon 없이, SSH만으로 원격 서버의 Claude Code 세션을 로컬 대시보드에 통합한다.

### 11.1 설계 원칙

- **No WebSocket server, No agent daemon** — SSH만 사용
- 원격 세션이 로컬 세션과 **동일한 대시보드**에 표시
- Peek: `display-popup → ssh -t "tmux attach"`
- Send: `ssh <host> "tmux send-keys"`
- 호스트별 두 가지 모드: hooks(SSH socket forwarding) 또는 JSONL polling

### 11.2 설정 (Config)

```yaml
# ~/.config/cc-tower/config.yaml
hosts:
  - name: server-a
    ssh: user@192.168.1.10
    hooks: true          # SSH socket forwarding → 실시간 이벤트
  - name: server-b
    ssh: user@dev-server
    hooks: false         # JSONL polling fallback
```

### 11.3 원격 세션 탐지 (Remote Session Discovery)

- `ssh <host> "cat ~/.claude/sessions/*.json"` — 5초마다 폴링
- PID → TTY → pane 매핑은 로컬과 동일하지만 `ssh <host> "tmux list-panes -a"` 경유
- 세션에 host 이름 태그 부여 → 대시보드에 HOST 컬럼으로 표시

### 11.4 원격 상태 추적 — 두 가지 모드

#### Mode A: SSH Socket Forwarding (hooks: true)

- cc-tower 시작 시: `ssh -fN -R ${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock:${XDG_RUNTIME_DIR:-/tmp}/cc-tower.sock <host>`
- 원격 Claude hook이 동일한 소켓 경로로 전송 → 이벤트가 로컬 cc-tower로 터널링
- 원격 서버에 hook 플러그인 설치 필요: `cc-tower install-hooks --remote <host>`
- 레이턴시: ~5ms + 네트워크 (~50ms)
- 로컬 경험과 동일

#### Mode B: JSONL Polling (hooks: false)

- `ssh <host> "tail -c 262144 <jsonl_path>"` — 3초마다 폴링
- JSONL 파싱으로 상태 추론 (로컬 secondary fallback과 동일)
- 원격 설치 불필요
- 레이턴시: ~200-300ms per poll cycle

### 11.5 Remote Peek

```bash
# display-popup 안에서 로컬 tmux attach 대신 SSH로 연결
tmux display-popup -E -w 80% -h 80% \
  -T " <session> (<host>) | prefix+d to close " \
  "ssh -t <host> 'tmux attach -t <session>'"
```

### 11.6 Remote Send

```bash
ssh <host> "tmux send-keys -t <pane_id> 'text' Enter"
```

### 11.7 원격 Hook 설치 (Remote Hook Installation)

```bash
# 원격 서버에 hook 플러그인 SSH로 설치
cc-tower install-hooks --remote server-a

# 내부 동작:
# 1. scp hooks/ 디렉토리를 원격:~/.claude/plugins/cc-tower/ 로 복사
# 2. 검증: ssh <host> "ls ~/.claude/plugins/cc-tower/hooks/hooks.json"
```

### 11.8 원격 LLM 요약

원격 서버에서 직접 실행:
```bash
ssh <host> "cd /tmp && claude --print -p '...' --model haiku --no-session-persistence"
```
또는 프롬프트가 충분히 작은 경우 최근 메시지 텍스트만 가져와 로컬에서 실행.

### 11.9 대시보드 표시

HOST 컬럼 추가:

```
   #  HOST      PANE  LABEL           STATUS    TASK
   1  local     %7    cc-session      ● EXEC    ...
   2  local     %5    obsidian        ○ IDLE    ...
   3  server-a  %3    api-backend     ◐ THINK   ...
   4  server-b  %1    ml-training     ● EXEC    ...
```

- 로컬 세션: `local`
- 원격 세션: config의 host name

### 11.10 SSH 터널 관리

- cc-tower 시작/종료 시 SSH 터널 자동 관리
- 30초마다 SSH 연결 health check, 끊기면 자동 재연결
- `q` 종료 시: 모든 SSH 터널 정리

### 11.11 Session 인터페이스 확장

```typescript
interface Session {
  // ... 기존 필드 유지 ...

  // Phase 1.5 추가 필드
  host: string;           // 'local' 또는 config의 host name
  sshTarget?: string;     // e.g., 'user@192.168.1.10'
}
```

---

## 12. Phase 2 Considerations (Web UI & Team Features)

Phase 1.5 이후, 팀 협업과 브라우저 기반 접근이 필요한 경우를 위한 확장:

### 12.1 Agent-Server Protocol

```typescript
interface AgentReport {
  machineId: string;
  hostname: string;
  sessions: Session[];
  timestamp: Date;
}

interface ServerCommand {
  targetMachine: string;
  targetSession: string;
  action: 'send' | 'attach' | 'kill';
  payload?: string;
}
```

### 12.2 데이터 전송

- WebSocket으로 실시간 상태 스트리밍
- Agent → Server: 세션 상태 변화 이벤트
- Server → Agent: 명령 전달 요청
- 인증: JWT 기반 토큰

### 12.3 Web UI

- Phase 2에서 TUI 대시보드를 Web UI로 확장
- 동일한 Session Store를 REST API로 노출
- React/Svelte 기반 브라우저 대시보드

---

## 13. Milestones & Deliverables

### Phase 1: Local MVP

| Week | Milestone | Deliverables |
|------|-----------|-------------|
| **W1** | Foundation | 프로젝트 scaffolding, Discovery Engine, Session Store, Hook plugin |
| **W2** | Tracking | Hook Receiver, JSONL Watcher, State Machine, Turn Summarizer (Tier 1+2) |
| **W3** | Dashboard + Notification | TUI 메인 뷰, 상세 뷰, 키보드 네비게이션, 스마트 알림 |
| **W4** | Interaction + Polish | Send/Peek 2-tier, Config, 테스트 |

> **Phase 1 후속** (W5~W6): FR-12 히스토리, FR-13 그룹, `--json` 출력, LLM 요약 (Tier 3)
> **Phase 1.5** (W7~W8): SSH 원격 세션 지원 — 섹션 11 참조

### Definition of Done (Phase 1)

- [ ] `cc-tower` 실행 시 모든 활성 Claude Code 세션을 자동 탐지
- [ ] 각 세션의 상태(idle/thinking/executing)를 2초 이내에 반영
- [ ] TUI 대시보드에서 세션 목록, 상태, 상세 정보 확인 가능
- [ ] 대시보드에서 세션에 텍스트 명령 전송 가능 (Send: `/` 키)
- [ ] 대시보드에서 tmux popup으로 세션 미리보기 + 직접 타이핑 가능 (Peek: `p` 키)
- [ ] 작업 완료 시 데스크톱 알림 발생
- [ ] `cc-tower list --json` 으로 스크립트 연동 가능
- [ ] cc-tower TUI 실행 중일 때 작업 완료 알림 동작 확인

---

## 13.1 Testing Strategy

| 영역 | 테스트 방식 |
|------|-----------|
| **JSONL 파서** | 실제 JSONL 파일에서 추출한 fixture (user, assistant, progress 타입별). 불완전한 마지막 라인, 대형 tool output 포함 케이스. |
| **State Machine** | 상태 전이 단위 테스트. 모든 전이 경로 커버 (idle→thinking→executing→thinking→idle, agent 분기 등). |
| **Hook Receiver** | Unix socket mock. 올바른 HookEvent 파싱, 잘못된 JSON 무시, 소켓 연결 끊김 처리. |
| **Session Discovery** | `~/.claude/sessions/` 디렉토리의 mock 파일. 생존/죽은 PID, stale 파일, 빈 디렉토리. |
| **PID→Pane 매핑** | ppid 체인 워킹 mock. 직접 tmux, nvim 중첩, tmux 밖 케이스. |
| **Cold Start** | 다양한 크기의 JSONL fixture로 역방향 스캔. 0바이트, 50라인 미만, 512KB 초과 파일. |
| **tmux 연동** | `tmux` 명령 출력을 mock하는 wrapper. CI에서 실제 tmux 없이 테스트 가능. |
| **E2E** | 실제 tmux + 가짜 Claude 프로세스 (echo 스크립트)로 전체 흐름 검증. 로컬 개발 환경에서만 실행. |

**CI 전략:** tmux mock으로 unit/integration 테스트. E2E는 로컬 수동 실행.

---

## 14. Open Questions

| # | Question | Impact | Decision Needed By |
|---|----------|--------|-------------------|
| 1 | TUI 프레임워크: ink (React) vs blessed vs ratatui (Rust)? | 개발 속도 vs 성능 | W1 시작 전 |
| 2 | JSONL 파싱의 안정성 — Claude Code 내부 포맷이 공식 API가 아닌데, 버전 간 호환성 유지 방법은? | 유지보수 비용 | W2 |
| 3 | nvim 중첩 세션에 대한 send-keys 정책 — 차단? 경고? 그대로 전달? | UX | W4 |
| 4 | 비용 추정 정확도 — JSONL의 token usage로 충분한가, 별도 과금 API 필요한가? | 정보 정확성 | Phase 2 |
| 5 | ~~daemon 모드~~ → 해결: daemon 없음. TUI 프로세스만 존재, 이벤트 유실 허용 | - | 해결됨 |
| 6 | Phase 2 서버 프로토콜 — WebSocket vs gRPC vs SSE? | 확장성 | Phase 2 시작 전 |
| 7 | ~~Zoom 기능 필요성~~ → 해결: Zoom 제거. Peek(tmux popup + session group)로 충분. popup 안에서 직접 타이핑 가능하므로 전체화면 전환 불필요 | - | 해결됨 |
| 8 | ~~LLM 요약 구현 방식~~ → 해결: `spawn('sh', ['-c', 'claude --print ...'])` 병렬 비동기 실행. ~8-10초/호출, content hash 캐시, state.json 영속 저장. hidden tmux session 또는 Anthropic SDK 불사용 | - | 해결됨 |

---

## Appendix A: Competitive Analysis

| Tool | 유사점 | 차이점 |
|------|--------|--------|
| **tmux-resurrect/continuum** | tmux 세션 관리 | Claude Code 특화 기능 없음 |
| **htop/btop** | 프로세스 모니터링 | 세션 컨텍스트 없음 |
| **Warp terminal** | AI 터미널 | 자체 터미널, tmux 연동 아님 |
| **oh-my-claudecode HUD** | Claude 상태 표시 | 단일 세션, 대시보드 아님 |

cc-tower는 "Claude Code 세션"이라는 특정 도메인에 특화된 모니터링 + 제어 도구.

## Appendix B: Key File Paths Reference

| Path | Purpose | Access |
|------|---------|--------|
| `~/.claude/sessions/<pid>.json` | PID → Session 매핑 | Read (scan) |
| `~/.claude/projects/<slug>/<uuid>.jsonl` | 대화 로그 | Read (tail) |
| `~/.claude/.session-stats.json` | 도구 사용 통계 | Read |
| `~/.claude/settings.json` | Claude 설정 | Read |
| `~/.config/cc-tower/config.yaml` | cc-tower 설정 | Read/Write |
| `~/.local/share/cc-tower/state.json` | 세션 메타 (label, tag) | Read/Write |
| `~/.local/share/cc-tower/history/` | 히스토리 데이터 | Read/Write |
