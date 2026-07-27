import { Button } from "./Button";
import styles from "./StateMessage.module.css";

interface BaseStateMessageProps {
  message: string;
  title: string;
}

export function LoadingState({ message, title }: BaseStateMessageProps) {
  return (
    <section className={styles.stateMessage} aria-live="polite">
      <span className={styles.eyebrow}>Loading</span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.message}>{message}</p>
    </section>
  );
}

export function EmptyState({ message, title }: BaseStateMessageProps) {
  return (
    <section className={styles.stateMessage}>
      <span className={styles.eyebrow}>Empty</span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.message}>{message}</p>
    </section>
  );
}

export interface ErrorStateProps extends BaseStateMessageProps {
  onRetry: () => void;
  retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = "Retry", title }: ErrorStateProps) {
  return (
    <section className={styles.stateMessage} role="alert">
      <span className={styles.eyebrow}>Error</span>
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.message}>{message}</p>
      <Button onClick={onRetry} type="button" variant="secondary">
        {retryLabel}
      </Button>
    </section>
  );
}
