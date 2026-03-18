import { Session } from '../../core/session-store.js';
export declare function useTmux(closeKey?: string): {
    send: (session: Session, text: string) => Promise<boolean>;
    peek: (session: Session) => Promise<boolean>;
};
