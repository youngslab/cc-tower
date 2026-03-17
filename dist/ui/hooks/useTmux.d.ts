import { Session } from '../../core/session-store.js';
export declare function useTmux(): {
    send: (session: Session, text: string) => Promise<boolean>;
    peek: (session: Session) => Promise<boolean>;
};
