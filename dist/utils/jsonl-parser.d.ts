export interface ParsedMessage {
    type: 'user' | 'assistant' | 'progress' | 'system' | 'file-history-snapshot' | 'custom-title' | 'unknown';
    timestamp?: string;
    sessionId?: string;
    stopReason?: 'end_turn' | 'tool_use' | null;
    model?: string;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
    };
    toolName?: string;
    toolInput?: string;
    assistantText?: string;
    userContent?: string;
    progressType?: 'hook_progress' | 'agent_progress';
    agentId?: string;
    systemSubtype?: string;
    durationMs?: number;
    customTitle?: string;
}
export declare function parseJsonlLine(line: string): ParsedMessage | null;
