export interface Config {
  discovery: {
    scan_interval: number;       // ms, default 2000
    claude_dir: string;          // default ~/.claude
    auto_discover: boolean;      // default true
  };
  tracking: {
    jsonl_watch: boolean;        // default true
    process_scan_interval: number; // ms, default 5000
  };
  dashboard: {
    refresh_rate: number;        // ms, default 1000
    default_sort: 'status' | 'project' | 'name' | 'activity';
    show_cost: boolean;
    show_dead: boolean;
  };
  notifications: {
    enabled: boolean;
    min_duration: number;        // seconds, default 30
    cooldown: number;            // seconds, default 30
    suppress_when_focused: boolean;
    channels: {
      desktop: boolean;
      tmux_bell: boolean;
      sound: boolean;
    };
    alerts: {
      on_error: boolean;
      on_cost_threshold: number; // USD
      on_session_death: boolean;
    };
    quiet_hours: {
      enabled: boolean;
      start: string;             // "HH:MM"
      end: string;
    };
  };
  commands: {
    confirm_before_send: boolean;
    confirm_when_busy: boolean;
  };
}

export const defaults: Config = {
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
  commands: {
    confirm_before_send: true,
    confirm_when_busy: true,
  },
};
