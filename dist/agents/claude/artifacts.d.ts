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
export declare function projectArtifactsDir(input: ClaudeArtifactDirInput): string;
export declare function sessionArtifactPath(input: ClaudeArtifactPathInput): string;
