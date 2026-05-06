import { Session } from '../../core/session-store.js';
export declare function useTmux(_closeKey?: string): {
    send: (session: Session, text: string) => Promise<boolean>;
};
