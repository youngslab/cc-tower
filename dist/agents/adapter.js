export function normalizeTrailingArgs(args) {
    return args?.trim() ? ` ${args.trim()}` : '';
}
export function prefixedWindowName(prefix, projectName) {
    const safeProject = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
    return `${prefix}-${safeProject}`;
}
//# sourceMappingURL=adapter.js.map