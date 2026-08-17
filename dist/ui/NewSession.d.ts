export interface HostOption {
    name: string;
    ssh: string;
    commandPrefix?: string;
}
export interface PastSessionByCwd {
    sessionId: string;
    cwd: string;
    startedAt: number;
    label?: string;
    goalSummary?: string;
    contextSummary?: string;
    sshTarget?: string;
}
interface Props {
    hosts: HostOption[];
    onSelect: (projectPath: string, host?: HostOption, resumeSessionId?: string) => void;
    onCancel: () => void;
    getPastSessionsByTarget: (sshTarget?: string) => PastSessionByCwd[];
}
export declare function NewSession({ hosts, onSelect, onCancel, getPastSessionsByTarget }: Props): import("react/jsx-runtime").JSX.Element;
export {};
