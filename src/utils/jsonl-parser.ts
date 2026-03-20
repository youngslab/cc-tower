export interface ParsedMessage {
  type: 'user' | 'assistant' | 'progress' | 'system' | 'file-history-snapshot' | 'custom-title' | 'unknown';
  timestamp?: string;
  sessionId?: string;
  // For assistant messages
  stopReason?: 'end_turn' | 'tool_use' | null;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  // For assistant messages (tool_use)
  toolName?: string;
  toolInput?: string;
  assistantText?: string;
  // For user messages
  userContent?: string;
  // For progress messages
  progressType?: 'hook_progress' | 'agent_progress';
  agentId?: string;
  // For system messages
  systemSubtype?: string;
  durationMs?: number;
  // For custom-title messages (/rename)
  customTitle?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && (item as Record<string, unknown>)['type'] === 'text') {
        const text = (item as Record<string, unknown>)['text'];
        if (typeof text === 'string') return text;
      }
    }
  }
  return undefined;
}

export function parseJsonlLine(line: string): ParsedMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const result: ParsedMessage = { type: 'unknown' };

  if (typeof obj['timestamp'] === 'string') result.timestamp = obj['timestamp'];
  if (typeof obj['sessionId'] === 'string') result.sessionId = obj['sessionId'];

  const msgType = obj['type'];

  if (msgType === 'user') {
    result.type = 'user';
    const userMsg = obj['message'];
    const content = (userMsg && typeof userMsg === 'object')
      ? (userMsg as Record<string, unknown>)['content']
      : obj['content'];
    result.userContent = extractUserContent(content);
  } else if (msgType === 'assistant') {
    result.type = 'assistant';
    const message = obj['message'];
    if (message && typeof message === 'object') {
      const msg = message as Record<string, unknown>;
      const stopReason = msg['stop_reason'];
      if (stopReason === 'end_turn' || stopReason === 'tool_use') {
        result.stopReason = stopReason;
      } else if (stopReason === null) {
        result.stopReason = null;
      }
      if (typeof msg['model'] === 'string') result.model = msg['model'];
      // Extract tool name and assistant text from content blocks
      const content = msg['content'];
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') {
            const b = block as Record<string, unknown>;
            if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
              result.toolName = b['name'];
              // Extract file path or command from input if available
              const input = b['input'];
              if (input && typeof input === 'object') {
                const inp = input as Record<string, unknown>;
                if (typeof inp['file_path'] === 'string') {
                  result.toolInput = (inp['file_path'] as string).split('/').pop();
                } else if (typeof inp['command'] === 'string') {
                  result.toolInput = (inp['command'] as string).slice(0, 40);
                } else if (typeof inp['pattern'] === 'string') {
                  result.toolInput = (inp['pattern'] as string).slice(0, 40);
                }
              }
            }
            if (b['type'] === 'text' && typeof b['text'] === 'string') {
              if (!result.assistantText) {
                result.assistantText = (b['text'] as string).slice(0, 120);
              }
            }
          }
        }
      }
      const usage = msg['usage'];
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        if (typeof u['input_tokens'] === 'number' && typeof u['output_tokens'] === 'number') {
          result.usage = {
            input_tokens: u['input_tokens'],
            output_tokens: u['output_tokens'],
          };
          if (typeof u['cache_creation_input_tokens'] === 'number') {
            result.usage.cache_creation_input_tokens = u['cache_creation_input_tokens'];
          }
          if (typeof u['cache_read_input_tokens'] === 'number') {
            result.usage.cache_read_input_tokens = u['cache_read_input_tokens'];
          }
        }
      }
    }
  } else if (msgType === 'progress') {
    result.type = 'progress';
    const data = obj['data'];
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const pType = d['type'];
      if (pType === 'hook_progress' || pType === 'agent_progress') {
        result.progressType = pType;
      }
      if (typeof d['agentId'] === 'string') result.agentId = d['agentId'];
    }
  } else if (msgType === 'system') {
    result.type = 'system';
    if (typeof obj['subtype'] === 'string') result.systemSubtype = obj['subtype'];
    if (typeof obj['durationMs'] === 'number') result.durationMs = obj['durationMs'];
  } else if (msgType === 'file-history-snapshot') {
    result.type = 'file-history-snapshot';
  } else if (msgType === 'custom-title') {
    result.type = 'custom-title';
    if (typeof obj['customTitle'] === 'string') result.customTitle = obj['customTitle'];
  }

  return result;
}
