import type { MouseEventHandler, ReactNode } from "react";
import styles from "./Button.module.css";

type ButtonVariant = "primary" | "secondary";

export interface ButtonProps {
  children: ReactNode;
  variant: ButtonVariant;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

export function Button({
  children,
  disabled = false,
  onClick,
  type = "button",
  variant
}: ButtonProps) {
  return (
    <button
      className={`${styles.button} ${styles[variant]}`}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}
