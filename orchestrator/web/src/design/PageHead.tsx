import type { ReactNode } from "react";

/**
 * A page's head: the title, one sentence that says where the page stands, and the page's actions at
 * the title's right. A page about one thing passes sticky, so its main action stays in view while
 * the page scrolls; what sits beside the title (a task's state) comes in as children, and what
 * stays in view under the sentence with it (a running task's plan) as below.
 */
export function PageHead({ title, summary, actions, crumb, sticky = false, below, children }: { title: ReactNode; summary?: ReactNode; actions?: ReactNode; crumb?: ReactNode; sticky?: boolean; below?: ReactNode; children?: ReactNode }) {
  return (
    <header className={`page-head${sticky ? " sticky" : ""}`}>
      {crumb ? <p className="page-crumb">{crumb}</p> : null}
      <div className="page-head-line">
        <h1 dir="auto">{title}</h1>
        {children}
      </div>
      {summary ? <p className="page-summary">{summary}</p> : null}
      {/* After the sentence in reading order, so a phone shows the title, what it says, then what to do. */}
      {actions ? <div className="actions">{actions}</div> : null}
      {below}
    </header>
  );
}
