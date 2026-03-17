import { Session } from '../core/session-store.js';
interface Props {
    session: Session;
    confirmWhenBusy: boolean;
    onSend: (text: string) => void;
    onCancel: () => void;
}
export declare function SendInput({ session, confirmWhenBusy, onSend, onCancel }: Props): import("react/jsx-runtime").JSX.Element;
export {};
