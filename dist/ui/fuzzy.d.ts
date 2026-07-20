/**
 * Subsequence fuzzy match: returns true when every character of `query`
 * appears in `target` in order (case-insensitive). Not scored — binary match.
 */
export declare function fuzzyMatch(query: string, target: string): boolean;
