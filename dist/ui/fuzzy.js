/**
 * Subsequence fuzzy match: returns true when every character of `query`
 * appears in `target` in order (case-insensitive). Not scored — binary match.
 */
export function fuzzyMatch(query, target) {
    const q = query.toLowerCase();
    const t = target.toLowerCase();
    let qi = 0;
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
        if (t[ti] === q[qi])
            qi++;
    }
    return qi === q.length;
}
//# sourceMappingURL=fuzzy.js.map