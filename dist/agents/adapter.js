export function normalizeTrailingArgs(args) {
    return args?.trim() ? ` ${args.trim()}` : '';
}
export function prefixedWindowName(prefix, projectName) {
    const safeProject = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
    return `${prefix}-${safeProject}`;
}
export function agentResumeId(adapter, info) {
    return info.resumeId ?? adapter.defaultResumeId?.(info);
}
export function agentResumable(adapter, info) {
    return info.resumable ?? adapter.defaultResumable?.(info) ?? adapter.capabilities.resume;
}
//# sourceMappingURL=adapter.js.map