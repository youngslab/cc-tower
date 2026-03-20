// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractUserContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        for (const item of content) {
            if (item && typeof item === 'object' && item['type'] === 'text') {
                const text = item['text'];
                if (typeof text === 'string')
                    return text;
            }
        }
    }
    return undefined;
}
export function parseJsonlLine(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    let raw;
    try {
        raw = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== 'object')
        return null;
    const obj = raw;
    const result = { type: 'unknown' };
    if (typeof obj['timestamp'] === 'string')
        result.timestamp = obj['timestamp'];
    if (typeof obj['sessionId'] === 'string')
        result.sessionId = obj['sessionId'];
    const msgType = obj['type'];
    if (msgType === 'user') {
        result.type = 'user';
        const userMsg = obj['message'];
        const content = (userMsg && typeof userMsg === 'object')
            ? userMsg['content']
            : obj['content'];
        result.userContent = extractUserContent(content);
    }
    else if (msgType === 'assistant') {
        result.type = 'assistant';
        const message = obj['message'];
        if (message && typeof message === 'object') {
            const msg = message;
            const stopReason = msg['stop_reason'];
            if (stopReason === 'end_turn' || stopReason === 'tool_use') {
                result.stopReason = stopReason;
            }
            else if (stopReason === null) {
                result.stopReason = null;
            }
            if (typeof msg['model'] === 'string')
                result.model = msg['model'];
            // Extract tool name and assistant text from content blocks
            const content = msg['content'];
            if (Array.isArray(content)) {
                for (const block of content) {
                    if (block && typeof block === 'object') {
                        const b = block;
                        if (b['type'] === 'tool_use' && typeof b['name'] === 'string') {
                            result.toolName = b['name'];
                            // Extract file path or command from input if available
                            const input = b['input'];
                            if (input && typeof input === 'object') {
                                const inp = input;
                                if (typeof inp['file_path'] === 'string') {
                                    result.toolInput = inp['file_path'].split('/').pop();
                                }
                                else if (typeof inp['command'] === 'string') {
                                    result.toolInput = inp['command'].slice(0, 40);
                                }
                                else if (typeof inp['pattern'] === 'string') {
                                    result.toolInput = inp['pattern'].slice(0, 40);
                                }
                            }
                        }
                        if (b['type'] === 'text' && typeof b['text'] === 'string') {
                            if (!result.assistantText) {
                                result.assistantText = b['text'].slice(0, 120);
                            }
                        }
                    }
                }
            }
            const usage = msg['usage'];
            if (usage && typeof usage === 'object') {
                const u = usage;
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
    }
    else if (msgType === 'progress') {
        result.type = 'progress';
        const data = obj['data'];
        if (data && typeof data === 'object') {
            const d = data;
            const pType = d['type'];
            if (pType === 'hook_progress' || pType === 'agent_progress') {
                result.progressType = pType;
            }
            if (typeof d['agentId'] === 'string')
                result.agentId = d['agentId'];
        }
    }
    else if (msgType === 'system') {
        result.type = 'system';
        if (typeof obj['subtype'] === 'string')
            result.systemSubtype = obj['subtype'];
        if (typeof obj['durationMs'] === 'number')
            result.durationMs = obj['durationMs'];
    }
    else if (msgType === 'file-history-snapshot') {
        result.type = 'file-history-snapshot';
    }
    else if (msgType === 'custom-title') {
        result.type = 'custom-title';
        if (typeof obj['customTitle'] === 'string')
            result.customTitle = obj['customTitle'];
    }
    return result;
}
//# sourceMappingURL=jsonl-parser.js.map