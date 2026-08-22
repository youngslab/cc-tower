import { type AgentId } from '../agents/types.js';
export interface HostOption {
    name: string;
    ssh: string;
    commandPrefix?: string;
}
export interface PastSessionByCwd {
    agentId?: AgentId;
    sessionId: string;
    resumeId?: string;
    resumable?: boolean;
    cwd: string;
    startedAt: number;
    label?: string;
    labelSource?: string;
    goalSummary?: string;
    contextSummary?: string;
    sshTarget?: string;
}
interface Props {
    hosts: HostOption[];
    onSelect: (projectPath: string, host?: HostOption, resumeSessionId?: string, agentId?: AgentId) => void;
    onCancel: () => void;
    getPastSessionsByTarget: (sshTarget?: string) => PastSessionByCwd[];
}
export declare function NewSession({ onSelect, onCancel, getPastSessionsByTarget }: Props): import("react/jsx-runtime").JSX.Element;
export {};
