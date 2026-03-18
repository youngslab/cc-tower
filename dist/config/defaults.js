export const defaults = {
    discovery: {
        scan_interval: 2000,
        claude_dir: '~/.claude',
        auto_discover: true,
    },
    tracking: {
        jsonl_watch: true,
        process_scan_interval: 5000,
    },
    dashboard: {
        refresh_rate: 1000,
        default_sort: 'status',
        show_cost: true,
        show_dead: false,
    },
    notifications: {
        enabled: true,
        min_duration: 30,
        cooldown: 30,
        suppress_when_focused: true,
        channels: {
            desktop: true,
            tmux_bell: true,
            sound: false,
        },
        alerts: {
            on_error: true,
            on_cost_threshold: 5.0,
            on_session_death: true,
        },
        quiet_hours: {
            enabled: false,
            start: '23:00',
            end: '07:00',
        },
    },
    keys: {
        close: 'Escape',
    },
    commands: {
        confirm_before_send: true,
        confirm_when_busy: true,
    },
    hosts: [],
};
//# sourceMappingURL=defaults.js.map