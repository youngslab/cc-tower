export interface HostConfig {
    name: string;
    ssh: string;
    hooks: boolean;
    ssh_options?: string;
    claude_dir?: string;
}
export interface Config {
    discovery: {
        scan_interval: number;
        claude_dir: string;
        auto_discover: boolean;
    };
    tracking: {
        jsonl_watch: boolean;
        process_scan_interval: number;
    };
    dashboard: {
        refresh_rate: number;
        default_sort: 'status' | 'project' | 'name' | 'activity';
        show_cost: boolean;
        show_dead: boolean;
    };
    notifications: {
        enabled: boolean;
        min_duration: number;
        cooldown: number;
        suppress_when_focused: boolean;
        channels: {
            desktop: boolean;
            tmux_bell: boolean;
            sound: boolean;
        };
        alerts: {
            on_error: boolean;
            on_cost_threshold: number;
            on_session_death: boolean;
        };
        quiet_hours: {
            enabled: boolean;
            start: string;
            end: string;
        };
    };
    keys: {
        close: string;
    };
    commands: {
        confirm_before_send: boolean;
        confirm_when_busy: boolean;
    };
    hosts: HostConfig[];
}
export declare const defaults: Config;
