# Instance-Session Mapping Algorithm

## Overview

The cc-tower instance-session mapping algorithm is responsible for correctly associating Claude Code process instances (identified by paneId/pid) with their corresponding sessions (identified by sessionId). This mapping is critical because multiple instances can run in the same project directory, and stale session metadata can cause wrong associations.

**Key challenge:** A PID's sessionId can change during its lifetime (via `/clear` or `/resume` commands), and the primary discovery source (`~/.claude/sessions/{pid}.json`) becomes stale immediately after these events.

## Data Model

### Instance

An **Instance** represents a single running Claude Code process:

```typescript
interface Instance {
  pid: number;
  paneId?: string;              // tmux pane ID (e.g., "0:1.2")
  sessionId: string;            // Unique session identifier (UUID)
  hasTmux: boolean;
  detectionMode: 'hook' | 'jsonl' | 'process';
  cwd: string;                  // working directory
  projectName: string;          // basename(cwd)
  status: 'idle' | 'thinking' | 'executing' | 'agent' | 'dead';
  // ... other fields (lastActivity, currentTask, etc.)
}
```

**Identity:** Each instance has an identity computed as:

```typescript
sessionIdentity(s: { paneId?: string; pid: number }): string
  = s.paneId ?? String(s.pid)
```

This means instances are keyed by paneId when available (stable across reconnections), else by PID (ephemeral, varies on restart).

### SessionMeta

**SessionMeta** stores user-provided metadata (labels, tags, summaries) keyed by sessionId:

```typescript
interface SessionMeta {
  label?: string;               // custom name
  tags?: string[];
  favorite?: boolean;
  favoritedAt?: number;
  goalSummary?: string;         // LLM-generated: high-level goal
  contextSummary?: string;      // LLM-generated: recent work direction
  nextSteps?: string;           // LLM-generated: suggested next action
}
```

SessionMeta is **sessionId-keyed** (not identity-keyed), so metadata persists across paneId changes and /resume events.

### Dual-Map Architecture

The SessionStore maintains two Maps:

```typescript
export class SessionStore {
  private instances: Map<string, Instance> = new Map();        // key: identity (paneId ?? String(pid))
  private sessionMeta: Map<string, SessionMeta> = new Map();   // key: sessionId
}
```

**Rationale:**
- **instances** groups by identity (pane/process) → displays one row per terminal pane
- **sessionMeta** groups by sessionId (conversation) → persists summaries across /clear and /resume
- One-to-many: A single sessionId can map to multiple identities (shouldn't happen, but handled defensively)

## Discovery → sessionId Resolution

The discovery engine determines a PID's current sessionId via three fallback paths:

### Path 1: `~/.claude/sessions/{pid}.json` (Primary)

**Location:** `~/.claude/sessions/{pid}.json`
**Precedence:** Highest
**Format:**
```json
{
  "pid": 1234,
  "sessionId": "uuid-here",
  "cwd": "/path/to/project",
  "startedAt": 1704067200000
}
```

**When it works:** At cold start, on session-start hook.
**When it fails:** After `/clear` or `/resume`, Claude Code writes a new sessionId to `sessions/{pid}.json` but this is asynchronous. During the window before the write completes, the file is stale.

### Path 2: `CLAUDE_SESSION_ID` Environment Variable (Fallback 1)

**Source:** Hook event payload → read from process environment via `/proc/{pid}/environ`
**When used:** If exact `{sessionId}.jsonl` file doesn't exist (discovery.ts lines 179–188)
**Precedence:** Higher than JSONL filename, lower than session file

**Implementation (discovery.ts:179–188):**
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

This is reliable because Claude Code sets `CLAUDE_SESSION_ID` early in the process lifecycle (before creating the JSONL file), and it persists even after `/clear`/`/resume`.

### Path 3: JSONL Filename (Fallback 2)

**Source:** Scan `~/.claude/projects/{slug}/` directory for `.jsonl` files
**When used:** If CLAUDE_SESSION_ID unavailable and exact `{sessionId}.jsonl` missing
**Precedence:** Lowest
**Failure mode:** If multiple `.jsonl` files exist in the same directory (multiple concurrent sessions), picks the most recently modified file
**Mitigation:** watchedJsonls check prevents reassigning JSONL already in use by another session (discovery.ts:745–751)

**Implementation (discovery.ts:190–211):**
```typescript
if (sessionId.startsWith('proc-')) {
  try {
    const usedSessionIds = new Set(
      Array.from(this.known.values())
        .filter(s => s.cwd === cwd && s.pid !== pid)  // Same dir, different PID
        .map(s => s.sessionId),
    );
    const jsonls = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => { try { return { name: f, mtime: statSync(join(projectDir, f)).mtimeMs }; } catch { return { name: f, mtime: 0 }; } })
      .sort((a, b) => b.mtime - a.mtime);
    for (const j of jsonls) {
      const candidate = j.name.replace('.jsonl', '');
      if (!usedSessionIds.has(candidate)) {
        sessionId = candidate;
        break;
      }
    }
  } catch {}
}
```

## registerSession: JSONL Path Selection

When a session is discovered, `registerSession` (tower.ts lines 706–803) determines which `.jsonl` file to watch.

### Exact Match (Primary)

**Condition:** `{sessionId}.jsonl` exists and has size > 0
**Line:** tower.ts:742–743

```typescript
const exactExists = fs.existsSync(jsonlPath);
const exactSize = exactExists ? fs.statSync(jsonlPath).size : 0;
```

**Behavior:** Use exact file immediately. No fallback logic applied.

**Important detail (tower.ts:735–740):**
> "After /clear, Claude Code immediately creates the new JSONL as an empty file, so exactExists===true but size===0 → do NOT fallback (it's a fresh session). After stale discovery (sessions/{pid}.json has old sessionId), the exact file is missing entirely → use newest JSONL in the directory."

This means:
- `exactExists && size > 0` → Use exact file (conversation already in progress)
- `exactExists && size === 0` → Use exact file anyway (fresh /clear, will fill shortly)
- `!exactExists` → Fallback to newest JSONL (stale discovery)

### Fallback Match (Secondary)

**Condition:** Exact file missing + `!opts.skipJsonlFallback`
**Lines:** tower.ts:744–759

```typescript
if (!exactExists && !opts.skipJsonlFallback) {
  const watchedJsonls = new Set(this.jsonlPaths.values());
  const files = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl') && !f.includes('/'))
    .map(f => ({ name: f, path: path.join(projectDir, f), mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const candidate = files.find(f => f.path !== jsonlPath && !watchedJsonls.has(f.path));
  if (candidate) {
    logger.debug('tower: using fallback JSONL (exact missing — stale discovery)', {
      sessionId: info.sessionId,
      exact: path.basename(jsonlPath),
      fallback: candidate.name,
    });
    jsonlPath = candidate.path;
  }
}
```

**Watchlist check:** Skips any `.jsonl` already watched by another active session (prevents concurrent sessions from sharing the same file).

**Override:** `skipJsonlFallback: true` disables this fallback. Used when `/clear` is detected via hook event (tower.ts:1249) because the session file is stale but the hook provides the exact sessionId.

### Cold Start Extraction

After JSONL path is determined, extract initial state from file (tower.ts:770–773):

```typescript
const initialState = this.jsonlWatcher.coldStartScan(jsonlPath);      // 'idle' | 'thinking' | 'executing'
const lastTask = this.jsonlWatcher.coldStartLastTask(jsonlPath);      // Last user message
const customTitle = this.jsonlWatcher.coldStartCustomTitle(jsonlPath);  // From /rename
```

These are used to:
- Initialize FSM state (state-machine.ts)
- Populate `currentTask` field (fallback display text)
- Apply custom `/rename` label (overrides persisted label)

## Hook-Based Session Correction

After initial discovery/registration, hooks provide runtime corrections via `handleHookEvent` (tower.ts lines 1173–1369).

### Identity Resolution (tower.ts:1135–1170)

When a hook event arrives with `event.sid` (sessionId), resolve it to an identity via three paths:

```typescript
private resolveIdentity(hookSid: string, hookCwd: string | undefined, hookPid?: number): string | null
```

**Path 1: Cached lookup (O(1))**
```typescript
const cached = this.hookSidToIdentity.get(hookSid);
if (cached && this.stateMachines.has(cached)) return cached;
```

Maps `CLAUDE_SESSION_ID` → identity. Built lazily as hooks arrive.

**Path 2: Composite key match (remote sessions)**
```typescript
for (const key of this.remoteStateMachines.keys()) {
  if (key.endsWith(`::${hookSid}`)) {
    this.hookSidToIdentity.set(hookSid, key);
    return key;
  }
}
```

Remote sessions use `"host::sessionId"` keys; hooks send bare sessionId.

**Path 3: PID ancestry walk (new mitigation, tower.ts:1149–1167)**
```typescript
if (hookPid && hookPid > 0) {
  let current = hookPid;
  let depth = 0;
  while (current > 1 && depth < 15) {
    for (const session of this.store.getAll()) {
      const id = sessionIdentity(session);
      if (session.pid && session.pid === current && session.status !== 'dead' && this.stateMachines.has(id)) {
        this.hookSidToIdentity.set(hookSid, id);
        logger.debug('tower: hook sid mapped to session via PID ancestry', { hookSid, identity: id, hookPid, matchedPid: current });
        return id;
      }
    }
    const ppid = getPpid(current);
    if (ppid === null || ppid === current || ppid <= 1) break;
    current = ppid;
    depth++;
  }
}
```

Walks the process parent chain from hook's PID up to 15 levels, matching against known session PIDs. This handles the case where `CLAUDE_SESSION_ID` is unavailable (encoded as `'unknown'` in hook payload) but the process hierarchy reveals the parent Claude instance.

**Limitation:** SDK-cli sessions (headless service spawns) are explicitly filtered to prevent false ancestor matches (tower.ts:1180–1191).

### Stale sessionId Detection

**Line:** tower.ts:1282–1305

When hook has actual sessionId (`hookSid !== 'unknown'`) and it differs from stored sessionId:

```typescript
if (hookSid !== 'unknown' && hookSid !== session.sessionId) {
  logger.info('tower: hook detected session change (stale session file)', {
    identity, oldSessionId: session.sessionId, newSessionId: hookSid,
  });
  const claudeDir = this.config.discovery.claude_dir.replace('~', os.homedir());
  const slug = cwdToSlug(session.cwd);
  const newJsonl = path.join(claudeDir, 'projects', slug, `${hookSid}.jsonl`);
  
  // Unwatch old JSONL
  this.jsonlWatcher.unwatch(session.sessionId);
  this.jsonlPaths.delete(session.sessionId);
  
  // Update sessionId in store
  this.store.update(identity, { sessionId: hookSid });
  
  // Watch new JSONL if it exists
  if (fs.existsSync(newJsonl)) {
    this.jsonlPaths.set(hookSid, newJsonl);
    this.jsonlWatcher.watch(hookSid, newJsonl);
    const customTitle = this.jsonlWatcher.coldStartCustomTitle(newJsonl);
    if (customTitle) {
      this.store.updateMeta(identity, { label: customTitle });
    }
  }
  this.hookSidToIdentity.set(hookSid, identity);
}
```

This corrects the mapping in-place without dropping the session. The identity (paneId/pid) remains stable; only the sessionId changes.

### paneId Upgrade Path

If hook provides a paneId (`event.pane`) that differs from stored paneId, rekey the session (tower.ts:1311–1327):

```typescript
if (event.pane && event.pane !== session.paneId) {
  const oldIdentity = sessionIdentity(session);
  patch['paneId'] = event.pane;
  patch['hasTmux'] = true;
  
  if (Object.keys(patch).length > 0) this.store.update(oldIdentity, patch);
  const newIdentity = sessionIdentity({ ...session, paneId: event.pane });
  
  if (oldIdentity !== newIdentity) {
    this.store.rekey(oldIdentity, newIdentity);
    const fsm2 = this.stateMachines.get(oldIdentity);
    if (fsm2) { this.stateMachines.delete(oldIdentity); this.stateMachines.set(newIdentity, fsm2); }
    for (const [hSid, id] of this.hookSidToIdentity) {
      if (id === oldIdentity) this.hookSidToIdentity.set(hSid, newIdentity);
    }
    identity = newIdentity;
  }
}
```

This handles the case where discovery initially found a PID without a pane (identity = `String(pid)`), then a hook reveals the pane (identity upgrades to `paneId`).

## session-changed Event Handling

The discovery engine emits `session-changed` when it detects a sessionId change for the same PID (discovery.ts:118–125):

```typescript
if (prev.sessionId !== info.sessionId) {
  logger.debug('discovery: session-changed', { pid: info.pid, old: prev.sessionId, new: info.sessionId });
  this.known.set(info.pid, info);
  this.emit('session-changed', { prev, next: info });
}
```

Tower listens for this event (tower.ts:204–250) to handle `/resume` and `/clear`:

### /resume vs /clear Detection

```typescript
const nextJsonl = path.join(claudeDir, 'projects', slug, `${next.sessionId}.jsonl`);
const isResume = (() => { try { return fs.statSync(nextJsonl).size > 0; } catch { return false; } })();
```

- **isResume=true:** New sessionId's JSONL exists and has content → resuming a previous conversation, migrate metadata
- **isResume=false:** New sessionId's JSONL missing/empty → `/clear` started a fresh conversation, don't migrate

### Metadata Reassociation

```typescript
if (isResume) {
  this.store.reassociateMeta(prev.sessionId, next.sessionId);
}
this.store.update(identity, { sessionId: next.sessionId });
```

`reassociateMeta` (session-store.ts:225–231) moves SessionMeta from old sessionId to new:

```typescript
reassociateMeta(oldSessionId: string, newSessionId: string): void {
  if (oldSessionId === newSessionId) return;
  const meta = this.sessionMeta.get(oldSessionId);
  if (!meta) return;
  this.sessionMeta.set(newSessionId, meta);
  this.sessionMeta.delete(oldSessionId);
}
```

This ensures summaries, labels, and tags follow the user's conversation through `/resume` events.

### JSONL Watching Setup

```typescript
if (fs.existsSync(nextJsonl) && fs.statSync(nextJsonl).size > 0) {
  this.jsonlPaths.set(next.sessionId, nextJsonl);
  this.jsonlWatcher.watch(next.sessionId, nextJsonl);
} else {
  // /clear: JSONL not yet created — watch for it
  const projectDir = path.dirname(nextJsonl);
  const watcher = fs.watch(projectDir, (event, filename) => {
    if (filename === `${next.sessionId}.jsonl` && fs.existsSync(nextJsonl) && fs.statSync(nextJsonl).size > 0) {
      this.jsonlPaths.set(next.sessionId, nextJsonl);
      this.jsonlWatcher.watch(next.sessionId, nextJsonl);
      watcher.close();
    }
  });
  setTimeout(() => watcher.close(), 60_000);
}
```

For `/resume`, immediately start watching. For `/clear`, watch the directory and start watching once the file appears.

## /clear Flow (Unknown sessionId)

When a hook event arrives with `event.event === 'session-start'` but no matching session found (tower.ts:1199–1263):

### Detection

```typescript
if (event.event === 'session-start' && event.cwd && !event.cwd.startsWith('/tmp')) {
  // Find the dead/dying session with same CWD for metadata migration.
  // Only match if the hook pid matches the session pid (same claude process = /clear).
  const dyingSession = event.cwd
    ? this.store.getAll().find(s => s.cwd === event.cwd && (!event.pid || s.pid === event.pid))
    : undefined;
```

Matches by CWD + PID. Only migrates metadata if it's the same process (confirms it's `/clear`, not a new parallel session).

### Metadata Migration

```typescript
const migratedMeta = dyingSession ? {
  label: dyingSession.label,
  tags: dyingSession.tags,
  favorite: dyingSession.favorite,
  favoritedAt: dyingSession.favoritedAt,
} : undefined;

if (dyingSession) {
  this.cleanupSession(sessionIdentity(dyingSession));
}
```

Only favorite is migrated by `/clear`. Labels, tags, and summaries reset (fresh conversation).

### Direct Registration

```typescript
const info: SessionInfo = {
  pid: dyingSession?.pid ?? 0,
  sessionId: hookSid,
  cwd: event.cwd!,
  startedAt: Date.now(),
};
await this.registerSession(info, { skipJsonlFallback: true });
```

Register immediately with `skipJsonlFallback: true` because the hook provides the authoritative sessionId (sessions/{pid}.json is stale).

## Known Failure Modes and Mitigations

### 1. Stale Session File

**Problem:**
- User runs `/clear` in a session
- Claude Code writes new sessionId to file asynchronously
- Tower's discovery reads old sessionId from file before write completes
- Wrong JSONL watched, wrong summaries applied

**Mitigation:**
- Hook-based stale detection (tower.ts:1282–1305) corrects sessionId in-place when hook arrives with actual sessionId
- `skipJsonlFallback: true` when registering from hook event ensures we use hook's sessionId, not fallback logic
- For offline/no-hook scenarios, eventually the discovery re-scan will pick up the change

### 2. Same-CWD JSONL Collision

**Problem:**
- Two Claude instances run in the same project directory
- Both call `registerSession` around the same time
- Stale discovery gives both the same sessionId
- JSONL fallback picks the most recent file
- Both instances watch the same JSONL

**Mitigation:**
- `watchedJsonls` set (tower.ts:746) filters out files already claimed by other sessions
- Sequential registration (tower.ts:169–172) during cold start reduces race window
- Hook events provide authoritative sessionId, correcting collisions at runtime

### 3. Concurrent Registration Race

**Problem:**
- Discovery finds two PIDs in quick succession
- Both trigger `registerSession` asynchronously
- Both read directory state, both pick same fallback JSONL
- watchedJsonls check is racy

**Mitigation:**
- During cold start, sessions are registered sequentially (tower.ts line 169–172: `for ... await this.registerSession(info)`)
- At runtime, hooks provide atomic sessionId updates
- Pane-based eviction (tower.ts:720–727) ensures new session in same pane overwrites old

### 4. Process Scan with SDK-cli Sessions

**Problem:**
- PID ancestry walk (tower.ts:1149–1167) matches against any session.pid
- A headless SDK-cli session (spawned by user code) has same parent
- Hook event from user's code gets attributed to SDK-cli ancestor, not the interactive session

**Mitigation:**
- SDK-cli sessions are filtered at discovery time (discovery.ts:85–89)
- SDK-cli sessions are skipped in hook resolution (tower.ts:1180–1191)
- Only interactive Claude Code sessions contribute to PID ancestry chain

## Current Mitigations Summary

| Failure Mode | Primary Mitigation | Secondary Mitigation |
|--------------|-------------------|----------------------|
| Stale session file | Hook-based correction (tower.ts:1282) | Discovery re-scan |
| Same-CWD collision | watchedJsonls check + sequential registration | Hook atomicity |
| Race condition | Sequential cold start registration | Pane-based eviction |
| SDK-cli false match | Discovery filter + hook filter | PID ancestry depth limit (15) |
| /clear unknown sessionId | Hook event detection + direct registration | Metadata recovery via CWD match |

## Flow Diagrams

### Cold Start Sequence

```
start() [tower.ts:113]
  ↓
restore() [session-store.ts:437]  — Load persisted metadata from state.json
  ↓
hookReceiver.start() [tower.ts:157]  — Bind socket for hooks
  ↓
discovery.scanOnce() [tower.ts:166]  — Scan sessions/ dir and process list
  ↓
FOR EACH session info:
  registerSession(info) [tower.ts:171, sequential]
    ↓
    mapPidToPane(pid) → { paneId?, hasTmux }
    ↓
    Resolve JSONL path:
      1. Exact: {sessionId}.jsonl
      2. Fallback: newest file (watchedJsonls check)
    ↓
    coldStartScan(jsonlPath) → initial state
    ↓
    store.register(session)
    ↓
    Create SessionStateMachine
    ↓
    ensureTmuxSessionName(paneId, projectName)
  ↓
  wire up events: session-found, session-lost, session-changed, jsonl-event, hook-event
  ↓
discovery.start() — Begin periodic scanning
```

### Hook Event Flow

```
Hook socket receives: { event, sid, pid, cwd, pane }
  ↓
handleHookEvent() [tower.ts:1173]
  ↓
1. Filter sdk-cli sessions [tower.ts:1180]
  ↓
2. Resolve identity via:
   a. hookSidToIdentity cache [tower.ts:1137]
   b. remoteStateMachines composite key [tower.ts:1141]
   c. PID ancestry walk [tower.ts:1149]
  ↓
  IF NOT FOUND:
    Check if session-start from unknown session [tower.ts:1199]
      ↓
      Find dyingSession by CWD + PID [tower.ts:1223]
      ↓
      Migrate favorite metadata [tower.ts:1226]
      ↓
      registerSession(hookSid, skipJsonlFallback=true) [tower.ts:1249]
      ↓
      Return
  ↓
  IF FOUND:
    3. Detect stale sessionId [tower.ts:1282]
      ↓
      IF hookSid !== stored sessionId:
        Unwatch old JSONL
        Update sessionId in store
        Watch new JSONL
    ↓
    4. Detect paneId upgrade [tower.ts:1311]
      ↓
      IF event.pane and new paneId:
        Rekey session: oldIdentity → newIdentity
        Update FSM maps
        Update hookSidToIdentity cache
    ↓
    5. Transition FSM [tower.ts:1337]
      ↓
      mapHookToInput(event) → InputEvent
      ↓
      fsm.transition(inputEvent)
    ↓
    6. Post-event refreshes [tower.ts:1346]
      ↓
      IF session-start and already idle: refreshSessionAfterResume()
      IF user-prompt: refresh summaries
      IF pre-tool: increment toolCallCount
```

### /resume Detection

```
Hook: event.event === 'session-start', fsm.getState() === 'idle'
  ↓
refreshSessionAfterResume() [tower.ts:495]
  ↓
Scan projectDir/ for .jsonl files, sort by mtime desc
  ↓
IF newest file !== current JSONL:
  Switch jsonlPaths[sessionId] to newest
  Unwatch old JSONL, watch new JSONL
  Clear stale summaries (goalSummary, contextSummary, nextSteps)
  ↓
Regenerate summaries from resumed JSONL
```

## Testing and Verification

### Unit Tests

- `discovery.ts`: sessionId resolution paths (file → env → filename)
- `session-store.ts`: dual-map consistency (instances vs sessionMeta)
- `tower.ts:resolveIdentity()`: hook identity resolution (cache → composite → ancestry)

### Integration Tests

1. **Stale session file + hook correction:**
   - Register session with old sessionId (stale file)
   - Fire hook with new sessionId
   - Verify: sessionId updated, old JSONL unwatched, new JSONL watched

2. **Same-CWD collision:**
   - Start two parallel Claude instances in same cwd
   - Verify: watchedJsonls prevents both from claiming same JSONL
   - Fire hooks for each with distinct sessionIds
   - Verify: correct JSONL associations

3. **/clear flow:**
   - Session running with sessionId="old"
   - User runs `/clear`
   - Fire hook: event.event='session-start', hookSid="new"
   - Verify: old session cleaned up, new session registered
   - Verify: favorite flag preserved, label/tags reset

4. **/resume flow:**
   - Session running with sessionId="old"
   - User runs `/resume` → creates new JSONL with different sessionId="new"
   - Discovery detects sessionId change → emits session-changed
   - Verify: reassociateMeta moves metadata from old to new
   - Hook: session-start on idle → refreshSessionAfterResume()
   - Verify: summaries regenerated from resumed JSONL

5. **PID ancestry walk:**
   - Parent claude PID=1000, ppid=500
   - Child subprocess PID=2000, ppid=1000
   - SDK-cli session with PID=3000 (filtered)
   - Fire hook from child: pid=2000, sid="unknown"
   - Verify: resolveIdentity walks ancestry, matches parent PID=1000
   - Verify: SDK-cli not in ancestry chain

## Code Locations Summary

| Concept | File | Lines |
|---------|------|-------|
| Discovery → sessionId | discovery.ts | 46–142, 148–239 |
| CLAUDE_SESSION_ID fallback | discovery.ts | 179–188 |
| JSONL filename fallback | discovery.ts | 190–211 |
| registerSession JSONL selection | tower.ts | 706–803 |
| Cold start extraction | jsonl-watcher.ts | 26–156 |
| Hook identity resolution | tower.ts | 1135–1170 |
| Stale sessionId detection | tower.ts | 1282–1305 |
| paneId upgrade | tower.ts | 1311–1327 |
| /clear flow | tower.ts | 1199–1263 |
| /resume flow | tower.ts | 204–250, 495–525 |
| Dual-map store | session-store.ts | 86–102 |
| reassociateMeta | session-store.ts | 225–231 |
| sessionIdentity | session-store.ts | 80–82 |
| watchedJsonls check | tower.ts | 745–751 |
| PID ancestry walk | tower.ts | 1149–1167 |
| SDK-cli filtering | discovery.ts:85, tower.ts:1180 |
| Pane eviction | tower.ts | 720–727 |

## References

- **Architecture:** See `doc/algorithms.md` for state machine, JSONL inference, and LLM summarization workflows
- **Logger:** Search codebase for `logger.info/debug/warn` with keywords: `discovery`, `session`, `hook`, `jsonl`, `pane`, `resume`, `clear`
- **Types:** `src/core/discovery.ts`, `src/core/session-store.ts`, `src/core/tower.ts`
