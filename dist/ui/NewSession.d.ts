export interface HostOption {
    name: string;
    ssh: string;
    commandPrefix?: string;
}
interface Props {
    projects: Array<{
        name: string;
        path: string;
        lastUsed: Date;
    }>;
    hosts: HostOption[];
    onSelect: (projectPath: string, host?: HostOption) => void;
    onCancel: () => void;
}
export declare function NewSession({ projects, hosts, onSelect, onCancel }: Props): import("react/jsx-runtime").JSX.Element;
export {};
