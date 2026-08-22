import path from 'node:path';
import { cwdToSlug } from '../../utils/slug.js';

export interface ClaudeArtifactPathInput {
  rootDir: string;
  cwd: string;
  sessionId: string;
  remote?: boolean;
}

export interface ClaudeArtifactDirInput {
  rootDir: string;
  cwd: string;
  remote?: boolean;
}

export function projectArtifactsDir(input: ClaudeArtifactDirInput): string {
  const slug = cwdToSlug(input.cwd);
  if (input.remote) return `${input.rootDir}/projects/${slug}`;
  return path.join(input.rootDir, 'projects', slug);
}

export function sessionArtifactPath(input: ClaudeArtifactPathInput): string {
  const fileName = `${input.sessionId}.jsonl`;
  if (input.remote) return `${projectArtifactsDir(input)}/${fileName}`;
  return path.join(projectArtifactsDir(input), fileName);
}
