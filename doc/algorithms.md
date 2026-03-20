# CC-Tower Algorithms and State Management

This document describes the key algorithms and state management logic in cc-tower. It focuses on the actual implementation details, not aspirational design.

---

## Table of Contents

1. [Session State Machine](#session-state-machine)
2. [Session Discovery](#session-discovery)
3. [JSONL State Inference](#jsonl-state-inference)
4. [JSONL Path Resolution](#jsonl-path-resolution)
5. [Session Registration](#session-registration)
6. [LLM Summarization](#llm-summarization)
7. [Session Metadata Migration](#session-metadata-migration)
8. [Single Instance Lock](#single-instance-lock)

---

## Session State Machine

The session state machine tracks the lifecycle of a Claude Code session across five states: `idle`, `thinking`, `executing`, `agent`, and `dead`.

### States

- **idle**: Session is ready for input. No active computation.
- **thinking**: Claude is processing input, streaming a response (stop_reason=null).
- **executing**: Claude is calling tools (stop_reason=tool_use).
- **agent**: A subagent was spawned and is running.
- **dead**: Session has ended and will be cleaned up.

### State Transition Diagram

```
                    ┌─────────────────┐
                    │      idle       │◄─────────────────────┐
                    └────────┬────────┘                       │
                             │                                │
              ┌──────────────┼──────────────┐                 │
              │              │              │                 │
         user-prompt    session-start   session-end           │
              │              │              │                 │
              v              v              v                 │
         ┌─────────┐    ┌────────┐    ┌──────────┐           │
         │thinking │    │ idle   │    │   dead   │           │
         └────┬────┘    └────────┘    └──────────┘           │
              │                                               │
    ┌─────────┼─────────┐                                     │
    │         │         │                                     │
pre-tool   jsonl:null  jsonl:end_turn                         │
    │    (streaming)   (stop)                                 │
    │         │         │                                     │
    v         v         └──────────────────────────────────┐  │
┌──────────┐ └─────────────────────────────────────────────┤  │
│executing │                                               │  │
└────┬─────┘                                               │  │
     │                                                     │  │
     ├──post-tool─┐                                        │  │
     │            v                                        │  │
     │        thinking                                     │  │
     │            │                                        │  │
     │     (tool_use or end_turn)                          │  │
     │            │                                        │  │
     └────────────┼────────────────────────────────────────┘  │
                  │                                           │
           agent-start                                        │
                  │                                           │
                  v                                           │
              ┌───────┐                                       │
              │ agent │                                       │
              └───┬───┘                                       │
                  │                                           │
            agent-stop                                        │
                  │                                           │
                  └───────────────────────────────────────────┘
                 (return to previous state)

        inactivity timeout (60s) from thinking/executing/agent → idle
```

### Transition Table

| From | Event | Condition | To | Notes |
|------|-------|-----------|----|----|
| idle | session-start | always | idle | Acknowledge but no transition |
| idle | user-prompt | always | thinking | User input received |
| idle | session-end | always | dead | Session ended |
| idle | agent-start | always | agent | Spawn subagent |
| thinking | pre-tool | always | executing | Tool call detected |
| thinking | jsonl | stopReason=null | thinking | Streaming (no change) |
| thinking | jsonl | stopReason=tool_use | executing | Tool use detected |
| thinking | jsonl | stopReason=end_turn | idle | Turn ended |
| thinking | stop | always | idle | Inactivity timeout |
| executing | post-tool | always | thinking | Tool completed |
| executing | jsonl | stopReason=null | thinking | Streaming |
| executing | jsonl | stopReason=end_turn | idle | Turn completed |
| executing | stop | always | idle | Inactivity timeout |
| agent | agent-stop | always | {previousState} | Return to state before agent-start |
| * | session-end | always | dead | Terminal state |
| dead | * | always | dead | No transitions from dead |

### Implementation Details

**File:** `src/core/state-machine.ts`

Key fields:
- `state`: Current state (one of the five states)
- `previousState`: State before agent-start (for agent-stop recovery)
- `stateEnteredAt`: Timestamp of state entry (ms)
- `inactivityTimer`: Timer for 60-second inactivity timeout

**Inactivity Timeout:**
- When entering thinking/executing/agent: start a 60-second timer
- If no events during that window: automatically transition to idle
- Timer clears on state exit or next event
- Idle and dead states do not have timeout timers

**Hook vs JSONL Events:**
- **Hook events** (primary, preferred): Direct event notifications from Claude Code process hooks
- **JSONL events** (fallback): Inferred from JSONL file changes when hooks are not available
  - `stopReason=null` → thinking (streaming)
  - `stopReason=tool_use` → executing
  - `stopReason=end_turn` → idle

Priority: Hook events take precedence. JSONL transitions are only processed if `detectionMode !== 'hook'`.

---

## Session Discovery

The discovery engine locates running Claude Code sessions through two strategies with automatic fallback.

### Strategy 1: Session Files (Preferred)

**Path:** `~/.claude/sessions/*.json`

Each file contains:
```typescript
{
  pid: number,
  sessionId: string,
  cwd: string,
  startedAt: number,
  host?: string,          // undefined = local
  sshTarget?: string      // undefined = local
}
```

**Algorithm:**
1. Read all `.json` files in `~/.claude/sessions/`
2. For each file:
   - Parse and validate structure
   - Check if PID is still alive (via `process.kill(pid, 0)`)
   - Detect changes (new, lost, or sessionId changed)
   - Emit events: `session-found`, `session-lost`, `session-changed`
3. Periodic scan (default: 2000ms) via `setInterval`

**PID Lifecycle:**
- **Found:** New PID not in `known` map → emit `session-found`
- **Lost:** PID exists in `known` but is now dead → emit `session-lost`
- **Changed:** Same PID but `sessionId` differs → emit `session-changed` (metadata migration occurs)

### Strategy 2: Process Scanning (Fallback)

Activated when `~/.claude/sessions/` is empty or inaccessible.

**Algorithm:**
1. `ps -eo pid,comm | grep 'claude'` → list all running claude processes
2. For each PID:
   - Read CWD from `/proc/<pid>/cwd`
   - Skip if CWD is `/tmp` or `/tmp/` (ephemeral processes like `claude --print`)
   - Verify project directory exists: `~/.claude/projects/<slug>/`
   - Determine sessionId (in priority order):
     1. Read `CLAUDE_SESSION_ID` from `/proc/<pid>/environ`
     2. Use newest `.jsonl` filename in project directory as fallback
     3. Synthesize as `proc-<pid>` if neither available
3. Emit discovery events as above

**Process Scan Filter:**
- Skip `/tmp` processes (excluded because they're typically transient)
- Require matching project directory (ensures we only track real sessions, not random claude processes)

**File:** `src/core/discovery.ts`

---

## JSONL State Inference

The JSONL watcher reads session logs to infer state at cold start and real-time.

### Cold Start Scan Algorithm

**Method:** `coldStartScan(jsonlPath)`

Reads the last 64KB of the JSONL file and walks backwards to find the last state-determining message.

**Priority Order (highest to lowest):**
1. System message with `subtype` in [turn_duration, stop_hook_summary, local_command] → idle
2. Assistant with `stopReason=end_turn` → idle
3. Assistant with `stopReason=tool_use` → executing
4. Assistant with `stopReason=null` → thinking (streaming)
5. User message alone → thinking
6. No messages → idle

**Rationale:** System turn-duration messages are authoritative (turn definitively ended). Assistant stop_reason is the primary signal. User messages alone are unreliable because internal commands (e.g., `/rename`, skill invocations) create entries without assistant responses.

**Complexity:** O(n) where n = lines in last 64KB; typical ~100-500 lines.

### Cold Start Last Task

**Method:** `coldStartLastTask(jsonlPath)`

Extracts the last user message text for `currentTask` display.

Algorithm: Walk backwards through last 64KB, find first non-internal user message, return cleaned text (first 80 chars).

Internal messages detected via `isInternalMessage()` (e.g., skill invocations, system commands).

### Cold Start Custom Title

**Method:** `coldStartCustomTitle(jsonlPath)`

Extracts the latest `/rename` (custom-title message) from JSONL.

Algorithm: Walk backwards through last 64KB, find first `type=custom-title` with non-null `customTitle`, return it.

### Real-Time JSONL Watching

**Method:** `watch(sessionId, jsonlPath)`

Uses `fs.watch()` for real-time file monitoring:
1. Start at end of current file (offset = file size)
2. On file change:
   - Read new bytes from offset to new size
   - Split by `\n` and parse each complete line
   - Emit `jsonl-event` for each parsed message
   - Update offset to new size
3. Reconcile timer (30s interval) re-reads in case fs.watch missed events

**Non-blocking:** Events are emitted to `jsonlWatcher.on('jsonl-event', ...)` listeners.

**File:** `src/core/jsonl-watcher.ts`

---

## JSONL Path Resolution

The mapping from sessionId to JSONL file is non-trivial because Claude Code reuses session IDs across conversations.

### Why sessionId ≠ conversationId

Claude Code maintains session IDs across `/clear` and `/resume` operations. However, each new conversation gets a new JSONL file with a different name. The system tracks both:
- **sessionId**: Long-lived identity for the Claude process (used in `~/.claude/sessions/` files)
- **conversationId**: Each JSONL file has its own ID (unique per conversation within the session)

### Newest JSONL Strategy

**Algorithm:**
1. Construct expected path: `~/.claude/projects/<slug>/<sessionId>.jsonl`
2. If file exists, use it
3. Otherwise, scan project directory for all `.jsonl` files
4. Sort by modification time (newest first)
5. Use the most recently modified JSONL file
6. Log warning if newest differs from expected

**Rationale:** After `/clear` or `/resume`, a new conversation JSONL exists but the sessionId may still point to the old conversation. Using mtime ensures we always watch the active conversation, not stale files.

**Re-check on Idle Transition:** When session transitions to idle, re-scan the project directory. If a newer JSONL exists (indicating a conversation change):
- Stop watching the old JSONL
- Switch to watching the new one
- Request new summaries from the new conversation

This handles cases where the sessionId was reused but a different JSONL file is now active.

**File:** `src/core/tower.ts:registerSession()` (lines 410-431)

---

## Session Registration

Cold start sequence that initializes a session when first discovered.

### Parallel Registration

**File:** `src/core/tower.ts:start()`

After discovery, all discovered sessions are registered in parallel:
```typescript
await Promise.all(sessions.map(info => this.registerSession(info)));
```

Each registration:
1. Resolve tmux pane (parallel via pane mapper)
2. Compute JSONL path (with newest-file fallback)
3. Cold start scan (state, task, custom title)
4. Create state machine
5. Start JSONL watcher
6. Register in store

### Pane Mapping

**Algorithm:** `mapPidToPane(claudePid)`

Maps a Claude PID to a tmux pane ID via ppid chain walking.

1. Fetch all tmux panes (cached 5s): `tmux list-panes -aF "#{pane_id}:#{pane_tty}"`
2. Walk ppid chain from claudePid upward:
   - Read `/proc/<pid>/fd/0` → get controlling TTY (e.g., `/dev/pts/34`)
   - Compare against pane TTY list
   - If match found: return paneId
   - Otherwise: get ppid from `/proc/<pid>/stat` (field 3), move to parent
3. Stop at pid=1 or ppid=null

**TTY Matching:** Only matches `/dev/pts/*` (pseudoterminal) devices. Pipes or other redirection (no TTY) cause early exit.

**Return Value:**
- `{ paneId, hasTmux: true }` — Found pane
- `{ paneId: undefined, hasTmux: true }` — tmux available but no pane found
- `{ paneId: undefined, hasTmux: false }` — tmux not available

**File:** `src/tmux/pane-mapper.ts`, `src/utils/pid-resolver.ts`

### Cold Start Initialization

```typescript
const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);
const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);
const customTitle = this.jsonlWatcher.coldStartCustomTitle(jsonlPath);
```

Creates session with initial state inferred from JSONL, not hook events.

### State Machine Creation

```typescript
const fsm = new SessionStateMachine(info.sessionId, initialState);
fsm.on('state-change', (change) => {
  // Update store, trigger summaries, emit notifications
});
```

Wires up state change listener to:
- Update store with new status
- Trigger LLM summaries on idle transition
- Emit notifications
- Re-check JSONL path (newest-file strategy)

---

## LLM Summarization

Three types of summaries generated via parallel `claude --print` calls:

### Summary Types

**1. Goal Summary** (`goalSummary`)
- **Trigger:** Cold start + idle transition
- **Input:** Early conversation messages (first ~512KB / 15 messages)
- **Output:** One-line current intent/goal (max 50 words)
- **Prompt:** "What is the user currently trying to accomplish right now?"
- **Cache:** By content hash (re-generated only if messages changed)

**2. Context Summary** (`contextSummary`)
- **Trigger:** Cold start + idle transition
- **Input:** Recent conversation messages (last ~512KB / 15 messages)
- **Output:** One-line outcome/result (max 50 words)
- **Prompt:** "Summarize what was accomplished (the result/outcome) in one line."
- **Cache:** By content hash

**3. Next Steps** (`nextSteps`)
- **Trigger:** Idle transition only (not cold start)
- **Input:** Recent messages
- **Output:** Suggested next action or "NONE" if complete (max 30 words)
- **Prompt:** "Suggest what the user should do next. Output NONE if work is complete."
- **Cache:** By content hash

### Implementation

**File:** `src/core/llm-summarizer.ts`

Non-blocking parallel execution:
```typescript
export async function generateContextSummary(
  sessionId: string,
  recentMessages: string,
): Promise<string | undefined>
```

**Algorithm:**
1. Compute hash of message content
2. Return cached summary if hash matches (content unchanged)
3. If request already inflight, return cached value
4. Otherwise: spawn `claude --print` via `spawn()`
5. Write prompt to stdin, read stdout/stderr, wait for close
6. Extract first line, clean text, cache by hash
7. Update store with result

**Cache Structure:**
```typescript
const cache = new Map<string, { summary: string; hash: string }>();
const inflight = new Set<string>(); // sessions with pending requests
```

**Inflight Handling:** If multiple idle transitions occur before first summary completes, subsequent requests return cached value instead of spawning duplicates.

**Timeout:** 30-second timeout per `claude --print` call; returns empty string on timeout.

**Non-blocking:** Uses `spawn()` not `execSync`. Event loop unblocked during LLM request.

### Model and Caching

**Model:** `haiku` (fast, low-cost)
**Flags:** `--no-session-persistence` (don't pollute session store)

Cache persisted in session store (`state.json`):
- On idle: summaries auto-saved
- On cold start: summaries loaded from store
- Fast cold starts: no LLM calls needed

---

## Session Metadata Migration

When a session's `sessionId` changes (e.g., `/clear`, `/resume`, reconnect), user-created metadata (labels, tags, favorites) is migrated to the new session ID.

### Metadata Fields (Migrated)

- `label`: User-set custom title
- `tags`: Array of tags
- `favorite`: Boolean
- `favoritedAt`: Timestamp

### Fields NOT Migrated (Re-computed)

- `goalSummary`: Old summary no longer applicable
- `contextSummary`: Old summary no longer applicable
- `nextSteps`: Re-generated for new conversation
- `status`, `messageCount`, etc.: Reset for new session

**Rationale:** Identity metadata (label, tags, favorite) follows the user's intent. Context-specific metadata (summaries) is conversation-specific and should not carry over.

### Migration Trigger Points

**1. Discovery-detected change:**
```typescript
this.discovery.on('session-changed', async ({ prev, next }) => {
  const oldSession = this.store.get(prev.sessionId);
  const migratedMeta = { label, tags, favorite, favoritedAt };
  this.cleanupSession(prev.sessionId);
  await this.registerSession(next);
  this.store.update(next.sessionId, migratedMeta);
});
```

**2. Hook-detected session-start for unknown session:**
```typescript
if (event.event === 'session-start' && !sessionId) {
  const dyingSession = this.store.getAll()
    .find(s => s.cwd === event.cwd && s.status === 'dead');
  // Migrate metadata, re-scan discovery
}
```

**File:** `src/core/tower.ts:start()` (lines 169-196), `handleHookEvent()` (lines 790-839)

---

## Single Instance Lock

Prevents multiple Tower instances from running concurrently.

### Lock Mechanism

**File:** `~/.local/share/cc-tower/tower.lock`

**Format:**
```
<PID>
```

**Algorithm:**

1. **Acquire:**
   - Try `fs.openSync(lockPath, 'wx')` (fail if exists)
   - If success: write PID, return true
   - If fail:
     - Read PID from file
     - Check if PID alive via `process.kill(pid, 0)`
     - If alive: return false (another instance running)
     - If dead: delete stale lock, retry create, return true

2. **Release:**
   - `fs.unlinkSync(lockPath)` on exit
   - Cleanup on `SIGINT`, `SIGTERM`, `exit`

**Stale PID Detection:** If lock file exists but PID is dead, automatically reclaim the lock.

**File:** `src/core/tower.ts:acquireLock()` (lines 67-90)

---

## Remote Sessions (SSH)

Tower also supports monitoring Claude sessions on remote hosts via SSH.

### Remote Session Info

Extends local `SessionInfo` with:
- `host`: Remote hostname from config
- `sshTarget`: SSH target string (user@host)
- `sshOptions`: Optional SSH arguments

### Remote Discovery Algorithm

For each configured host:
1. SSH tunnel to remote host (if `hooks: true`)
2. Scan remote `~/.claude/sessions/` files
3. Emit `session-found`, `session-lost` events
4. Register remote session with composite ID: `host::sessionId`

**Composite ID:** Allows same sessionId on multiple hosts without collision.

### Remote JSONL Polling

For hosts without hooks enabled, poll remote JSONL via SSH every 3 seconds:
1. `remoteReadJsonlTail(config, jsonlPath)` — Read last ~32KB of remote file
2. Parse tail for state-determining messages
3. Transition FSM based on latest message
4. Update currentTask from last user message

**File:** `src/core/tower.ts:registerRemoteSession()`, `startRemoteJsonlPoller()`

---

## Appendix: JSONL Message Types

### User Message
```json
{ "type": "user", "message": { "content": [...] }, "timestamp": "..." }
```

### Assistant Message
```json
{ "type": "assistant", "message": { "stop_reason": "end_turn|tool_use|null", "content": [...] }, "timestamp": "..." }
```

### Progress Message
```json
{ "type": "progress", "data": { "type": "hook_progress|agent_progress", "agentId": "..." }, "timestamp": "..." }
```

### System Message
```json
{ "type": "system", "subtype": "turn_duration|stop_hook_summary|local_command", "durationMs": 123, "timestamp": "..." }
```

### Custom Title Message
```json
{ "type": "custom-title", "customTitle": "My Session Name", "timestamp": "..." }
```

**Parser:** `src/utils/jsonl-parser.ts:parseJsonlLine()`

