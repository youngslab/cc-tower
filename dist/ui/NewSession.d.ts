export interface HostOption {
    name: string;
    ssh: string;
    commandPrefix?: string;
}
export interface PastSession {
    sessionId: string;
    startedAt: number;
    goalSummary?: string;
    contextSummary?: string;
    nextSteps?: string;
}
export interface PastSessionByCwd {
    sessionId: string;
    cwd: string;
    startedAt: number;
    goalSummary?: string;
    contextSummary?: string;
    sshTarget?: string;
}
interface Props {
    projects: Array<{
        name: string;
        path: string;
        lastUsed: Date;
    }>;
    hosts: HostOption[];
    onSelect: (projectPath: string, host?: HostOption, resumeSessionId?: string) => void;
    onCancel: () => void;
    getPastSessions: (cwd: string) => PastSession[];
    getPastSessionsByTarget: (sshTarget?: string) => PastSessionByCwd[];
    getAllPastSessions: () => PastSessionByCwd[];
    onDeleteSession: (sessionId: string) => void;
}
export declare function NewSession({ projects, hosts, onSelect, onCancel, getPastSessions, getPastSessionsByTarget, getAllPastSessions, onDeleteSession }: Props): import("react/jsx-runtime").JSX.Element;
export {};
