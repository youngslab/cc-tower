import path from 'node:path';
import { cwdToSlug } from '../../utils/slug.js';
export function projectArtifactsDir(input) {
    const slug = cwdToSlug(input.cwd);
    if (input.remote)
        return `${input.rootDir}/projects/${slug}`;
    return path.join(input.rootDir, 'projects', slug);
}
export function sessionArtifactPath(input) {
    const fileName = `${input.sessionId}.jsonl`;
    if (input.remote)
        return `${projectArtifactsDir(input)}/${fileName}`;
    return path.join(projectArtifactsDir(input), fileName);
}
//# sourceMappingURL=artifacts.js.map