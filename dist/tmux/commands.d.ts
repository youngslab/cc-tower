export interface PaneInfo {
    paneId: string;
    tty: string;
    pid: number;
    currentCommand: string;
    currentPath: string;
    width: number;
    height: number;
    active: boolean;
    windowId: string;
    windowIndex: number;
    sessionName: string;
}
export declare const tmux: {
    isAvailable(): Promise<boolean>;
    listPanes(): Promise<PaneInfo[]>;
    sendKeys(paneId: string, text: string): Promise<void>;
    displayPopup(opts: {
        width: string;
        height: string;
        title?: string;
        command: string;
        closeOnExit?: boolean;
    }): Promise<void>;
    selectPane(paneId: string): Promise<void>;
    selectWindow(windowTarget: string): Promise<void>;
    newGroupSession(name: string, targetSession: string): Promise<void>;
    renameSession(target: string, newName: string): Promise<void>;
    killSession(name: string): Promise<void>;
    getCurrentPane(): Promise<{
        windowId: string;
        paneId: string;
    } | null>;
    displayMessage(message: string): Promise<void>;
};
