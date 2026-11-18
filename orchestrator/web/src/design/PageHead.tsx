import type { ReactNode } from "react";

/**
 * A page's head: the title, one sentence that says where the page stands, and the page's actions at
 * the title's right. A page about one thing passes sticky, so its main action stays in view while
 * the page scrolls; what sits beside the title (a task's state) comes in as children, and what
 * stays in view under the sentence with it (a running task's plan) as below. `mainAtFoot` says the
 * page draws its main actions again at the foot of a phone's screen: the head keeps them for a wider
 * screen and `also` (what stays in the head on a phone) is drawn on its own there.
 */
export function PageHead({ title, summary, actions, also, crumb, sticky = false, mainAtFoot = false, below, children }: { title: ReactNode; summary?: ReactNode; actions?: ReactNode; also?: ReactNode; crumb?: ReactNode; sticky?: boolean; mainAtFoot?: boolean; below?: ReactNode; children?: ReactNode }) {
  return (
    <header className={`page-head${sticky ? " sticky" : ""}${mainAtFoot ? " main-at-foot" : ""}`}>
      {crumb ? <p className="page-crumb">{crumb}</p> : null}
      <div className="page-head-line">
        <h1 dir="auto">{title}</h1>
        {children}
      </div>
      {summary ? <p className="page-summary">{summary}</p> : null}
      {/* After the sentence in reading order, so a phone shows the title, what it says, then what to do. */}
      {actions || also ? (
        <div className="actions">
          {actions && mainAtFoot ? <span className="main-wide">{actions}</span> : actions}
          {also}
        </div>
      ) : null}
      {below}
    </header>
  );
}
