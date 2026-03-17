import { ParsedMessage } from '../utils/jsonl-parser.js';
export interface TurnSummary {
    timestamp: Date;
    transition: string;
    summary: string;
    details?: {
        toolsUsed: string[];
        filesChanged: string[];
        testResult?: {
            passed: number;
            failed: number;
            total: number;
        };
        error?: string;
    };
    tier: 1 | 2 | 3;
}
export declare class Summarizer {
    summarize(currentState: string, event: ParsedMessage, recentMessages: ParsedMessage[]): TurnSummary;
    summarizeWithContent(currentState: string, event: ParsedMessage, content: string): TurnSummary;
    private extractSummary;
    private matchTestResults;
    private matchTsErrors;
    private matchCommit;
    private matchFileEdits;
}
