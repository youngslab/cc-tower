import { ParsedMessage } from '../utils/jsonl-parser.js';

export interface TurnSummary {
  timestamp: Date;
  transition: string;
  summary: string;
  details?: {
    toolsUsed: string[];
    filesChanged: string[];
    testResult?: { passed: number; failed: number; total: number };
    error?: string;
  };
  tier: 1 | 2 | 3;
}

export class Summarizer {
  summarize(currentState: string, event: ParsedMessage, recentMessages: ParsedMessage[]): TurnSummary {
    // Tier 1: structural extraction
    const summary: TurnSummary = {
      timestamp: new Date(),
      transition: `→ ${currentState}`,
      summary: this.extractSummary(event, recentMessages),
      tier: 1,
    };
    return summary;
  }

  summarizeWithContent(currentState: string, event: ParsedMessage, content: string): TurnSummary {
    const base = this.summarize(currentState, event, []);

    // Tier 2: pattern matching
    const testResult = this.matchTestResults(content);
    const tsErrors = this.matchTsErrors(content);
    const commit = this.matchCommit(content);
    const files = this.matchFileEdits(content);

    if (testResult || tsErrors || commit || files.length > 0) {
      base.tier = 2;
      base.details = {
        toolsUsed: [],
        filesChanged: files,
        testResult: testResult ?? undefined,
        error: tsErrors ?? undefined,
      };
      if (testResult) {
        base.summary = `Tests: ${testResult.passed} passed, ${testResult.failed} failed`;
      }
      if (tsErrors) {
        base.summary = tsErrors;
      }
      if (commit) {
        base.summary = commit;
      }
    }

    return base;
  }

  private extractSummary(event: ParsedMessage, _recentMessages: ParsedMessage[]): string {
    if (event.type === 'user') {
      const content = event.userContent || '(no content)';
      return content.length > 80 ? content.slice(0, 77) + '...' : content;
    }
    if (event.type === 'assistant') {
      if (event.stopReason === 'tool_use') return 'Tool execution';
      if (event.stopReason === 'end_turn') return 'Turn completed';
    }
    return event.type;
  }

  private matchTestResults(content: string): { passed: number; failed: number; total: number } | null {
    // Pattern: "Tests: N passed, M failed, T total"
    const m1 = content.match(/(\d+)\s+passed,?\s+(\d+)\s+failed(?:,?\s+(\d+)\s+total)?/);
    if (m1) {
      const passed = parseInt(m1[1]);
      const failed = parseInt(m1[2]);
      return { passed, failed, total: m1[3] ? parseInt(m1[3]) : passed + failed };
    }
    // Pattern: PASS/FAIL lines
    const passCount = (content.match(/^PASS\s/gm) || []).length;
    const failCount = (content.match(/^FAIL\s/gm) || []).length;
    if (passCount + failCount > 0) {
      return { passed: passCount, failed: failCount, total: passCount + failCount };
    }
    return null;
  }

  private matchTsErrors(content: string): string | null {
    const errors = content.match(/error TS\d+/g) || [];
    if (errors.length > 0) return `Build: ${errors.length} errors`;
    return null;
  }

  private matchCommit(content: string): string | null {
    const m = content.match(/(?:commit|Committed?:?)\s+([a-f0-9]{7,40})/i);
    if (m) return `Committed: ${m[1].slice(0, 7)}`;
    return null;
  }

  private matchFileEdits(content: string): string[] {
    const files: string[] = [];
    const edits = content.matchAll(/Edit:?\s+([\w/.:-]+)/g);
    for (const m of edits) {
      const file = m[1].replace(/:\d+-\d+$/, '');
      if (!files.includes(file)) files.push(file);
    }
    return files;
  }
}
