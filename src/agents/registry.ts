/**
 * Agent registry — single import surface for all per-agent modules.
 *
 * Usage:
 *   import { agents } from '../agents/registry.js';
 *   agents.claude.coldStartScan(jsonlPath);
 *
 * Phase A1 (pivot v2) deliberately ships a single agent. Adding a second
 * agent (codex, gemini, ...) is what should trigger interface extraction.
 */
import { ClaudeAgent } from './claude/index.js';

export const agents = {
  claude: ClaudeAgent,
} as const;

export type AgentId = keyof typeof agents;
