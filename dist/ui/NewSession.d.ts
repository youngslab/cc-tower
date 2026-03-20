interface Props {
    projects: Array<{
        name: string;
        path: string;
        lastUsed: Date;
    }>;
    onSelect: (projectPath: string) => void;
    onCancel: () => void;
}
export declare function NewSession({ projects, onSelect, onCancel }: Props): import("react/jsx-runtime").JSX.Element;
export {};
