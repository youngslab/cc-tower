import { Session } from '../core/session-store.js';
interface Props {
    session: Session;
    onBack: () => void;
    onSend: (session: Session) => void;
    onPeek: (session: Session) => void;
}
export declare function DetailView({ session, onBack, onSend, onPeek }: Props): import("react/jsx-runtime").JSX.Element;
export {};
