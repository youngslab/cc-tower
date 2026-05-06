# CC-Tower Algorithms and State Management

This document describes the key algorithms and state management logic in popmux. It focuses on the actual implementation details, not aspirational design.

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
9. [Ephemeral Session Filtering](#ephemeral-session-filtering)
10. [Hook Event Resolution](#hook-event-resolution)
11. [ps Command — Live State Snapshot](#ps-command--live-state-snapshot)

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

**File:** `~/.local/share/popmux/tower.lock`

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

## Ephemeral Session Filtering

Claude Code spawns short-lived subprocesses with `/tmp`-based working directories for internal tasks (LLM summarization, hook execution, etc.). These must be excluded from the dashboard.

### Why /tmp Sessions Appear

Several code paths produce ephemeral Claude processes:

| Source | CWD | Example |
|--------|-----|---------|
| LLM summarizer | `/tmp/popmux-llm` | `claude --print` for goal/context summaries |
| Tool execution shells | `/tmp/claude-<hash>/...` | Claude Code's bash tool subshells |
| Hook scripts | `/tmp/...` | Shell snapshot environments |

Without filtering, these appear as real sessions in the dashboard — potentially hundreds at once during active tool use.

### Filter Points

Filtering is applied at two independent layers:

**1. Discovery (session file scan)**

`src/core/discovery.ts:scanOnce()`

After parsing each `~/.claude/sessions/*.json` file, skip entries whose `cwd` starts with `/tmp`:

```typescript
if (info.cwd.startsWith('/tmp')) {
  logger.debug('discovery: skipping /tmp session', { filePath, cwd: info.cwd });
  continue;
}
```

This prevents `/tmp` sessions from ever emitting `session-found` events.

**2. Registration guard**

`src/core/tower.ts:registerSession()`

Secondary guard that rejects any registration attempt for `/tmp` cwds, regardless of how the session was discovered (hook path, remote discovery, etc.):

```typescript
if (info.cwd.startsWith('/tmp')) return;
```

**Why two layers?** The discovery filter covers session-file-based detection. The registration guard covers all other paths (hook-based fast-registration, remote sessions, manual registration). Defense in depth.

**Process scan filter** (existing, unchanged):

`src/core/discovery.ts:scanProcesses()`

The fallback process scanner already filtered `/tmp` at line 150–151. The session file scan now applies the same rule for consistency.

### Criteria

Only `cwd.startsWith('/tmp')` is checked. This excludes:
- `/tmp/popmux-llm`
- `/tmp/claude-<hash>/...`
- Any other `/tmp/...` path

Real user sessions always reside under home directories (e.g., `/home/user/project`, `/root/project`, `/Users/user/project`) and are unaffected.

**Files:** `src/core/discovery.ts`, `src/core/tower.ts`

---

## Hook Event Resolution

When a Claude Code hook fires, Tower must map the hook's `session_id` to an internally tracked session. This is non-trivial because session IDs can differ between the hook payload and Tower's internal keys (especially for remote sessions).

### Resolution Algorithm

`src/core/tower.ts:resolveSessionId(hookSid, hookCwd)`

Four-step lookup in priority order:

**Step 1: Direct match**
```typescript
if (this.stateMachines.has(hookSid)) return hookSid;
```
Fastest path. Works when hook SID equals internal session ID (local sessions).

**Step 2: Cached mapping**
```typescript
const cached = this.hookSidToSessionId.get(hookSid);
if (cached && this.stateMachines.has(cached)) return cached;
```
O(1) fast path for previously resolved remote sessions. Cache populated by Steps 3–4.

**Step 3: Composite key suffix match**
```typescript
for (const key of this.stateMachines.keys()) {
  if (key.endsWith(`::${hookSid}`)) return key;
}
```
Remote sessions use composite keys: `host::bareSessionId`. Hook payloads send only the bare ID. This step matches `host::abc123` when hook sends `abc123`.

**Step 4: CWD fallback**
```typescript
for (const session of this.store.getAll()) {
  if (session.cwd === hookCwd && session.status !== 'dead') return session.sessionId;
}
```
Last resort when session ID is unavailable (`sid='unknown'`) or not yet registered. Matches by working directory.

### Unknown Session Path

If all four steps fail, the session is unknown. For `session-start` events on unknown non-`/tmp` sessions:

1. Search store for a session with the same CWD (`dyingSession`)
2. Clean up the dying session immediately
3. Register the new session using `hookSid` and `hookCwd`
4. Migrate favorite status only (labels/tags belong to the previous conversation)

This handles `/clear` and `/resume`-to-new-project scenarios where the hook fires before the discovery scan detects the change.

### session-start on Idle Session (/resume Detection)

When `session-start` hook fires for a session that is already `idle`, Tower checks whether a newer JSONL exists for that session. This handles `/resume`:

**Why this is needed:**
- `/resume` in an active Claude Code session does NOT update `~/.claude/sessions/{pid}.json`
- The sessions file retains the old session ID → discovery never emits `session-changed`
- `/resume` creates a new JSONL file but the FSM stays `idle→idle` (no `state-change` event)
- Without intervention, stale summaries from the old session persist indefinitely

**Algorithm:** `refreshSessionAfterResume(sessionId)`

1. Read current JSONL path from `jsonlPaths` map
2. Scan project directory for all `.jsonl` files sorted by mtime
3. If newest JSONL differs from current path:
   - Switch `jsonlPaths` to the newer file
   - Unwatch old JSONL, start watching new JSONL
   - Clear stale `goalSummary`, `contextSummary`, `nextSteps` from store
4. Trigger `refreshGoalSummary` + `refreshContextSummary` from the (possibly new) JSONL

**Trigger condition:** `event.event === 'session-start' && fsm.getState() === 'idle'`

**File:** `src/core/tower.ts:refreshSessionAfterResume()`, `handleHookEvent()`

---

### resume vs. clear Detection

After a `/resume` or `/clear`, `session-changed` is emitted by the discovery engine. Tower distinguishes the two cases to decide which metadata to migrate:

```typescript
const nextJsonl = path.join(claudeDir, 'projects', slug, `${next.sessionId}.jsonl`);
const isResume = (() => {
  try { return fs.statSync(nextJsonl).size > 0; } catch { return false; }
})();
```

| Operation | JSONL file for new sessionId | `isResume` | Metadata migrated |
|-----------|------------------------------|------------|-------------------|
| `/resume` | Exists and has content       | `true`     | All (label, tags, favorite, summaries restored from persisted store) |
| `/clear`  | Empty or missing             | `false`    | Favorite only (label/tags belong to previous conversation) |

**Rationale:** `/resume` restores a previous conversation — its metadata was already persisted and is automatically restored via `persistedMeta` in `store.register()`. `/clear` starts a fresh conversation in the same project — only the user's affinity (favorite) should carry over.

**File:** `src/core/tower.ts:handleHookEvent()`, `session-changed` listener

---

## ps Command — Live State Snapshot

`popmux ps` prints the current state of all sessions without starting a new Tower instance. It queries the running Tower via the Unix socket, with a fallback to `state.json` if Tower is not running.

### Query Protocol

Tower's Unix socket (`/tmp/popmux.sock` or `$XDG_RUNTIME_DIR/popmux.sock`) supports two message types:

| `event` field | Direction | Description |
|---------------|-----------|-------------|
| `session-start`, `hook-event`, etc. | Client → Tower | One-way hook notifications (existing) |
| `query` | Client → Tower → Client | Request/response: Tower writes JSON and closes |

**Query flow:**
1. Client connects to socket
2. Client sends `{"event":"query"}\n`
3. Tower serializes `store.getAll()` and writes `[...sessions...]\n`
4. Tower closes the connection
5. Client parses and displays

**Timeout:** Client times out after 2 seconds if Tower does not respond.

### Fallback: state.json

If the socket is unavailable (Tower not running), `ps` reads `state.json` directly:
- Path: `~/.local/share/popmux/state.json` (or `~/.config/popmux/state.json`)
- Contains: persisted metadata (label, tags, goalSummary, etc.) but NOT live status
- All sessions show `status: ?` in this mode

Output header indicates the source: `source: live` or `source: state.json (Tower not running)`.

### Output Format

```
source: live  (6 sessions)

SID     LABEL             STATUS     CWD                           GOAL
────────────────────────────────────────────────────────────────────────────────
9ec2f593popmux          idle       ~/workspace/popmux          Fixing /tmp session filtering bug
a099dd85shared-storage    thinking   ~/workspace/ccu-2.0/shared-s  Writing performance analysis doc
```

`--json` flag outputs raw JSON including `source` and `sessions` array.

### Implementation

**HookReceiver** (`src/core/hook-receiver.ts`):
- Detects `event === "query"` in incoming messages
- Emits `query` event with the raw `net.Socket` connection (instead of `hook-event`)

**Tower** (`src/core/tower.ts`):
- Listens for `query` event on `hookReceiver`
- Calls `this.store.getAll()`, serializes, writes to socket, closes

**index.tsx** — `ps` command:
- Tries socket query first (2s timeout)
- Falls back to state.json
- Formats output in columns or `--json` mode

**Files:** `src/core/hook-receiver.ts`, `src/core/tower.ts`, `src/index.tsx`

---

## tmux Session Auto-Rename

When a new Claude session is registered, popmux automatically renames the containing tmux session to `claude-{projectName}` so session names are predictable and identifiable.

### Trigger

Called from `Tower.registerSession()` after the session is added to the store:

```
if mapping.paneId is set AND session is local (not SSH)
  → ensureTmuxSessionName(paneId, projectName)
```

`paneId` comes from:
1. Hook payload `pane` field (`$TMUX_PANE` sent by `popmux-hook.sh`)
2. Fallback: PID→TTY→pane resolution

### Rename Algorithm

```
targetName = "claude-" + projectName

1. tmux.listPanes() → find pane with paneId
2. If pane not found → abort (no-op)
3. If pane.sessionName === targetName → already correct, abort
4. If pane.sessionName === "claude-popmux" → never rename (Tower's own session)
5. If pane.sessionName starts with "claude-" and ≠ targetName → skip
   (already claimed by another project — don't clobber)
6. Otherwise → tmux.renameSession(pane.sessionName, targetName)
```

### Guard Conditions

| Condition | Action | Reason |
|-----------|--------|--------|
| `paneId` not in tmux | no-op | pane may have closed |
| Already named correctly | no-op | idempotent |
| Session is `claude-popmux` | skip | Tower's own session is sacred |
| Session already `claude-*` | skip | Another project owns it |
| `tmux rename-session` fails | log debug, swallow | non-fatal |

### Example

```
Project: my-app  →  tmux session renamed to: claude-my-app
Project: popmux →  tmux session: claude-popmux (never renamed away)
```

### Implementation

**`tmux.renameSession(target, newName)`** (`src/tmux/commands.ts`):
```
execa('tmux', ['rename-session', '-t', target, newName])
```

**`Tower.ensureTmuxSessionName(paneId, projectName)`** (`src/core/tower.ts`):
- Lists all panes, finds the one matching `paneId`
- Applies guard conditions, calls `tmux.renameSession` if needed

**Files:** `src/tmux/commands.ts`, `src/core/tower.ts`

---

## Remote Session Discovery Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          STARTUP                                    │
│                                                                     │
│   Tower.start()                                                     │
│       │                                                             │
│       ├─ store.restore()           ← load dal::uuid from state.json │
│       ├─ remoteDiscovery.addKnown() ← pre-populate known map        │
│       └─ remoteDiscovery.start(5000ms)                              │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                    ┌───────────▼───────────┐
                    │   every 5s per host   │◄──────────────────────┐
                    └───────────┬───────────┘                       │
                                │                                   │
                    ┌───────────▼───────────┐                       │
                    │  SSH: cat sessions    │                       │
                    │  *.json on remote     │                       │
                    └───────────┬───────────┘                       │
                                │                                   │
                    ┌───────────▼───────────┐                       │
                    │    SSH success?       │                       │
                    └──────┬────────┬───────┘                       │
                     Yes   │        │ No                            │
          ┌────────────────┘        └──────────────────┐            │
          │                                            │            │
┌─────────▼──────────┐                    ┌────────────▼─────────┐  │
│   Parse JSON       │                    │  emit host-offline   │  │
│  [{pid,sessionId,  │                    │  sessions → dim      │  │
│    cwd,startedAt}] │                    │  (not removed)       │  │
└─────────┬──────────┘                    └────────────┬─────────┘  │
          │                                            │            │
┌─────────▼──────────────────────────┐       SSH      │            │
│  Batch PID liveness check (SSH)    │    recovers?   │            │
│  for pid in ...; do                │    ┌───Yes─────┘            │
│    kill -0 $pid && echo $pid       │    │                        │
│  done  (uses commandPrefix)        │    └─► emit host-online ───►┘
│  → filter dead PIDs                │        sessions → bright
│  SSH fail → keep all (no false neg)│
└─────────┬──────────────────────────┘
          │
┌─────────▼──────────────────────────┐
│      Diff vs known map             │
└────────┬───────────────┬───────────┘
         │               │
   new session      missing session
         │               │
┌────────▼────────┐  ┌───▼──────────────────────────────────┐
│ emit            │  │ emit session-lost                     │
│ session-found   │  │                                       │
└────────┬────────┘  │  FSM → dead                          │
         │           │  store.update(status: dead)           │
         │           │  30s delay → store.unregister()       │
         │           └───────────────────────────────────────┘
         │
┌────────▼────────────────────────────────────────────────────────┐
│                  registerRemoteSession()                        │
│                                                                 │
│  compositeId = "dal::uuid"                                      │
│                                                                 │
│  already in store? ──Yes──► skip                                │
│       │ No                                                      │
│       ▼                                                         │
│  SSH: ls *.jsonl | head -1   → resolve JSONL path               │
│       │                                                         │
│       ▼                                                         │
│  SSH: tail {jsonlPath}       → coldStartScan → initialState     │
│       │                                                         │
│       ▼                                                         │
│  SSH: tmux list-panes + ps   → try to find paneId               │
│       │                        (fails for docker sessions —     │
│       │                         PID crosses container boundary) │
│       ▼                                                         │
│  store.register(session)                                        │
│    hasTmux: true   ← always (even without paneId)               │
│    paneId:  may be undefined                                    │
│       │                                                         │
│  initialState === idle                                          │
│  AND goalSummary/contextSummary missing?                        │
│       │ Yes                                                     │
│       ▼                                                         │
│  refreshAllRemoteSummaries()                                    │
│    summaryLoading = true                                        │
│    Promise.all([goalSummary, contextSummary, nextSteps])        │
│    summaryLoading = false                                       │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

Each remote host is defined in `~/.config/popmux/config.yaml`:

```yaml
hosts:
  - name: dal
    ssh: dal                          # SSH alias or user@host
    ssh_options: ""                   # extra ssh flags (e.g. ProxyJump)
    hooks: false                      # true if Claude Code hook is installed on remote
    command_prefix: "docker exec devenv"  # prefix for Claude process commands
    claude_dir: "~/.claude"           # remote Claude data directory
```

`command_prefix` is used to run commands **inside** the container where Claude runs.
tmux management commands (peek, go) always run on the **SSH host**, never inside the container.

---

### Startup: Pre-populate known sessions

Before the first scan, Tower pre-populates `RemoteDiscovery.known` with sessions restored from `state.json`. This ensures the first scan correctly emits `session-lost` for dead sessions (e.g. after server reboot).

```
Tower.start()
  store.restore()                  ← loads dal::uuid sessions from state.json
  for each remote session in store:
    remoteDiscovery.addKnown(session)  ← pre-populate known map
  remoteDiscovery.start(5000ms)    ← begin polling
```

---

### Poll Cycle (every 5 seconds per host)

```
scanHost("dal", config)
│
├── remoteReadSessions(config)
│     ssh dal "cat ~/.claude/sessions/*.json"
│     (uses commandPrefix if set — session files live inside container)
│
├── Parse JSON → [{ pid, sessionId, cwd, startedAt }, ...]
│
├── PID liveness check (batch, single SSH call)
│     cmd: "for pid in 123 456; do kill -0 $pid 2>/dev/null && echo $pid; done"
│     (uses commandPrefix — Claude PIDs are inside container)
│     → filter sessions to alive PIDs only
│     → on SSH failure: keep all (conservative — avoid false negatives)
│
├── host-online emit
│
├── Diff against known map:
│     new session  (not in known) → session-found emit → registerRemoteSession()
│     dead session (in known, not in current) → session-lost emit → deregisterSession()
│
└── Update known map
```

---

### registerRemoteSession()

Called on `session-found`. Runs several SSH calls to bootstrap the session:

```
compositeId = "dal::uuid"
if store.get(compositeId) → skip (already registered)

1. SSH: ls -t {claudeDir}/projects/{slug}/*.jsonl | head -1
   → resolve JSONL path (use newest file)

2. SSH: tail {jsonlPath}
   → coldStartScan: determine initialState (idle/thinking/executing)
   → coldStartLastTask: find last user message

3. SSH: tmux list-panes + ps ancestry walk
   → try to find paneId by walking Claude PID → parent PIDs → tmux pane PID
   → NOTE: fails when commandPrefix (docker exec) is used — PID ancestry crosses container boundary
   → result: paneId = undefined for docker-based sessions

4. store.register(session)
   hasTmux: true   ← always true for remote (even without paneId)
   paneId:  may be undefined

5. if initialState === idle AND (goalSummary/contextSummary missing):
   → refreshAllRemoteSummaries()
```

---

### session-lost → deregisterSession()

```
session-lost emitted when:
  - Session file deleted on remote (Claude Code cleared session)
  - PID no longer alive (process killed, server rebooted)
  - SSH fails repeatedly (host-offline path handles separately)

deregisterSession(compositeId):
  → FSM.transition(session-end) → state = dead
  → store.update(status: dead)
  → 30s delay → store.unregister() → removed from dashboard
```

---

### host-offline / host-online

```
SSH to remote fails → host-offline emit
  → all sessions for host: hostOnline = false
  → dashboard shows sessions as dimmed (hostOnline indicator)
  → sessions NOT removed — SSH outage is transient

SSH succeeds again → host-online emit
  → all sessions for host: hostOnline = true
  → next scan resumes normal session-found/lost detection
```

---

### Peek / Go for Remote Sessions

```
Peek (p key):
  → ssh -t -o LogLevel=ERROR {sshTarget} "{setupCmd}"
  → setupCmd uses paneId if available (links specific window in popup)
  → setupCmd falls back to "tmux attach" if paneId unknown
  → commandPrefix NOT used — tmux is on SSH host, not inside container

Go (g key):
  → requires paneId (returns early if missing)
  → same setupCmd pattern as peek, full-screen popup
  → commandPrefix NOT used
```

---

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| `commandPrefix` for session reads/PID check | Claude process lives inside container; session files and PIDs are container-scoped |
| `commandPrefix` NOT for tmux | tmux sessions are on the SSH host; container doesn't have tmux |
| `hasTmux: true` always for remote | Even without `paneId`, remote sessions are accessible via SSH; prevents "monitor-only" display |
| Pre-populate `known` from state.json | Ensures first scan detects sessions killed by reboot as `session-lost` |
| PID check on SSH failure: keep all | Avoids removing live sessions due to transient SSH errors |

**Files:** `src/ssh/remote-discovery.ts`, `src/ssh/remote-commands.ts`, `src/core/tower.ts` (`registerRemoteSession`, `startRemoteJsonlPoller`), `src/ui/hooks/useTmux.ts` (peek), `src/ui/App.tsx` (go)

---

## Summary & Next Action Update Workflow

Three LLM-generated fields are maintained per session:

| Field | Question answered | Source messages |
|-------|-------------------|-----------------|
| `goalSummary` | What is this session trying to do? | First 15 user/assistant messages |
| `contextSummary` | What is the current state? | Last 15 user/assistant messages |
| `nextSteps` | What should happen next? | Last 15 user/assistant messages |

### LLM Cache Layer

All three fields use in-memory hash-based caching in `src/core/llm-summarizer.ts`:

```
generateGoalSummary(sessionId, text)
  hash = simpleHash(text)
  if cache[sessionId].hash === hash → return cached (no LLM call)
  if inflight[sessionId] → return cached (dedup concurrent calls)
  else → spawn "claude --print", cache result
```

**Cache is in-memory only** — clears on Tower restart. First run after restart always calls LLM.

---

### Local Session: Trigger Points

```
1. Tower startup (line 242-244 in tower.ts)
   ├── refreshGoalSummary          ← always (re-checks via hash cache)
   ├── refreshContextSummary       ← only if contextSummary missing
   └── refreshNextSteps            ← only if nextSteps missing AND status === 'idle'

2. /resume detected (refreshSessionAfterResume)
   ├── refreshGoalSummary
   └── refreshContextSummary

3. FSM: any state → idle  [MAIN PATH]
   ├── refreshGoalSummary
   ├── refreshContextSummary
   └── refreshNextSteps

4. FSM: session-start on idle session (idle→idle, /resume hook)
   ├── refreshGoalSummary
   └── refreshContextSummary

5. Manual refreshSession()
   ├── refreshGoalSummary
   ├── refreshContextSummary
   └── refreshNextSteps
```

### Remote Session: Trigger Points

All remote refreshes go through a single entry point `refreshAllRemoteSummaries`:

```
refreshAllRemoteSummaries(compositeId, config, jsonlPath)
  summaryLoading: true
  await Promise.all([
    refreshRemoteGoalSummary    ← SSH read + LLM
    refreshRemoteContextSummary ← SSH read + LLM
    refreshRemoteNextSteps      ← SSH read + LLM
  ])
  summaryLoading: false (finally)
```

Trigger points:

```
1. registerRemoteSession (initial registration)
   → only if goalSummary OR contextSummary missing
   → refreshAllRemoteSummaries

2. Remote JSONL poller → FSM idle transition
   → refreshAllRemoteSummaries

3. Manual refreshSession()
   → refreshAllRemoteSummaries
```

### summaryLoading Behavior

| Session type | set true | set false |
|---|---|---|
| Local | inside `refreshContextSummary` (mid-way) | `refreshContextSummary` complete/fail |
| Remote | `refreshAllRemoteSummaries` start | `refreshAllRemoteSummaries` finally |

> **Known issue (local):** If only `goalSummary` completes before `contextSummary` starts, `summaryLoading` may briefly be unset between the two. Remote sessions avoid this via the wrapper.

### /clear Behavior

After `/clear`, new session is registered with `skipJsonlFallback: true`:
- New JSONL exists but is empty → no messages → all three fields skip LLM call
- Fields remain empty until user types and session goes idle

### Guard: Skip Re-generation on Tower Restart

Remote sessions skip initial summary generation if both `goalSummary` and `contextSummary` are already populated in the store (restored from `state.json`).

Local sessions rely on the LLM hash cache — if JSONL content hasn't changed, `generateGoalSummary` returns cached result immediately without calling LLM.

### Files

| File | Role |
|------|------|
| `src/core/tower.ts` | Trigger logic, `refresh*` methods, `refreshAllRemoteSummaries` |
| `src/core/llm-summarizer.ts` | `generateGoalSummary`, `generateContextSummary`, `generateNextSteps`, hash cache |
| `src/core/jsonl-watcher.ts` | `readRecentContext` — reads local JSONL for LLM input |
| `src/ssh/remote-commands.ts` | `remoteReadJsonlTail` — SSH JSONL read for remote sessions |

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


---

## TODO: Instance vs Session 분리 리팩토링

### 배경

현재 `SessionStore`는 두 가지 개념을 하나의 객체(`Session` 타입)에 혼재하고 있다.

### 개념 정의

**Instance** — Claude Code 실행 프로세스 그 자체
- Key: `paneId ?? String(pid)` (불변, 프로세스 수명과 동일)
- Data: `pid`, `paneId`, `status`, `currentTask`, `messageCount`, `toolCallCount`, `hasTmux`, ...
- Lifecycle: 프로세스 시작/종료와 함께 생성/소멸 (in-memory only)

**Session** — Instance가 실행 중 변경할 수 있는 논리적 단위
- Key: `sessionId` (UUID, `/clear`·`/resume`로 변경 가능)
- Data: `label`, `tags`, `favorite`, `goalSummary`, `contextSummary`, `nextSteps`, `cwd`, `startedAt`
- Lifecycle: TTL 30일, `favorite`이면 영구 보존 (`state.json`에 persist)

### 현재 문제

- `SessionStore.register()`은 instance 등록이지만 session metadata도 같은 객체에 포함
- persist(`state.json`)는 `sessionId` key로 저장 — session 개념
- runtime store는 `identity(paneId/pid)` key — instance 개념
- 두 개념이 `Session` 타입 하나에 섞여 있어 책임 불명확

### 목표 구조

```
InstanceStore (in-memory)
  key: identity = paneId ?? String(pid)
  type: Instance

SessionMetaStore (persistent, state.json)
  key: sessionId
  type: SessionMeta
```

`Instance`가 `currentSessionId`를 참조해 `SessionMeta`를 조회하는 방식으로 분리.

### 핵심 문제: 새 instance에 이전 session 메타데이터 오염

현재 `restore()`는 같은 cwd를 가진 이전 sessionId의 label/tags/goalSummary를 새 instance에 자동 병합한다.
결과: 완전히 새로운 instance(새 pid, 새 sessionId)인데 이전 session 정보가 표기됨.

**올바른 동작 (분리 후):**
- 새 instance 시작 → Instance는 항상 clean state
- SessionMeta는 sessionId 일치 시에만 적용 (새 sessionId → 빈 메타)
- 이전 session 정보는 "과거 세션 목록"(`getPastSessionsByCwd`)에서만 조회
- `/resume` 시에만 명시적으로 이전 SessionMeta를 현재 instance에 연결

### 목표 아키텍처 상세

**Instance (no cache, in-memory only)**
- Discovery가 live 상태 관리 (pid alive 여부로 판단)
- peek/go/detail 등 요청 시 on-demand validate → 없으면 dead 처리
- persist 없음 — 재시작 시 항상 fresh discovery

**Session Cache (state.json)**
- key: `sessionId` (UUID)
- data: `label`, `tags`, `favorite`, `goalSummary`, `contextSummary`, `nextSteps`
- Instance의 현재 `sessionId`로 lookup → 있으면 표시, 없으면 빈 상태 (clean start)
- `/clear` → 새 sessionId → 빈 메타로 시작, 이전 건 archive에 보존
- `/resume` → 이전 sessionId 복원 → 해당 캐시 load
- label 편집 = session cache 업데이트, instance와 무관

**변경 사항**
- `restore()`의 cwd 기반 자동 병합 제거 → 새 instance는 항상 clean
- `SessionStore`가 instance lifecycle을 관리하지 않음 → discovery/tower 담당
- TUI 구독 구조 변경: discovery 이벤트 → instance list 갱신, session cache 변경 → 표시 데이터 갱신
