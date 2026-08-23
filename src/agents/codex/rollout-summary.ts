import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { cleanDisplayText, isInternalMessage } from '../../utils/slug.js';
import type { AgentSummaries } from '../adapter.js';
import type { CodexThreadRow } from './types.js';

function textFromContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    const text = block['text'];
    if ((block['type'] === 'input_text' || block['type'] === 'output_text' || block['type'] === 'text') && typeof text === 'string') {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function truncateSummary(value: string | undefined, max = 120): string | undefined {
  if (!value) return undefined;
  const cleaned = cleanDisplayText(value);
  if (cleaned.length <= 3) return undefined;
  return cleaned.slice(0, max);
}

function summarizeRolloutLine(line: string): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const payload = obj['payload'];
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;

  if (obj['type'] === 'event_msg') {
    if (p['type'] === 'user_message' && typeof p['message'] === 'string') {
      const text = p['message'].trim();
      if (!isInternalMessage(text)) return truncateSummary(text);
    }
    if (p['type'] === 'agent_message' && typeof p['message'] === 'string') {
      return truncateSummary(p['message']);
    }
    if (p['type'] === 'task_complete' && typeof p['last_agent_message'] === 'string') {
      return truncateSummary(`✓ ${p['last_agent_message']}`);
    }
    if (p['type'] === 'exec_command_end') {
      const command = Array.isArray(p['command']) ? p['command'].join(' ') : undefined;
      return truncateSummary(command ? `exec: ${command}` : undefined);
    }
  }

  if (obj['type'] === 'response_item') {
    if (p['type'] === 'message') {
      const role = typeof p['role'] === 'string' ? p['role'] : undefined;
      if (role === 'assistant') return truncateSummary(textFromContent(p['content']));
      if (role === 'user') {
        const text = textFromContent(p['content']);
        if (text && !isInternalMessage(text)) return truncateSummary(text);
      }
    }
    if (p['type'] === 'function_call' && typeof p['name'] === 'string') {
      return truncateSummary(`tool: ${p['name']}`);
    }
    if (p['type'] === 'custom_tool_call' && typeof p['name'] === 'string') {
      return truncateSummary(`tool: ${p['name']}`);
    }
  }

  return undefined;
}

export function readCodexRolloutContext(rolloutPath: string, maxBytes = 524288): string | undefined {
  try {
    const stat = statSync(rolloutPath);
    const readSize = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(readSize);
    const fd = openSync(rolloutPath, 'r');
    try {
      readSync(fd, buffer, 0, readSize, stat.size - readSize);
    } finally {
      closeSync(fd);
    }
    const chunk = buffer.toString('utf8');
    const lines = chunk.split('\n').filter(line => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const summary = summarizeRolloutLine(lines[index]!);
      if (summary) return summary;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function summarizeCodexThread(row: CodexThreadRow): AgentSummaries | undefined {
  const goal = truncateSummary(row.preview ?? row.firstUserMessage ?? row.title);
  const context = row.rolloutPath ? readCodexRolloutContext(row.rolloutPath) : undefined;
  const result: AgentSummaries = {};
  if (goal) result.goal = goal;
  if (context && context !== goal) result.context = context;
  return result.goal || result.context ? result : undefined;
}
