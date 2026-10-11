import type { ReactNode } from "react";

export interface EmptyStateProps {
  /** Already translated. */
  title: string;
  /** Already translated. */
  text?: string;
  children?: ReactNode;
}

export function EmptyState({ title, text, children }: EmptyStateProps) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-state__title">{title}</div>
      {text && <div className="empty-state__text">{text}</div>}
      {children}
    </div>
  );
}
