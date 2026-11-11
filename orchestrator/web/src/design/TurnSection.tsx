import { useId } from "react";
import type { ReactNode } from "react";

/**
 * One section of a list cut by whose move it is: its name, count and one sentence on the left, its
 * rows on the right. With nothing in it the section stays, and says what would land there.
 */
export function TurnSection({ name, count, why, empty, children }: { name: string; count: number; why?: ReactNode; empty: ReactNode; children?: ReactNode }) {
  const id = useId();
  return (
    <section className="turn" aria-labelledby={id}>
      <div className="turn-side">
        <h2 id={id}>{name} <span className="count">{count}</span></h2>
        {why ? <p className="turn-why">{why}</p> : null}
      </div>
      <div className="turn-body">{count === 0 ? <p className="turn-empty">{empty}</p> : children}</div>
    </section>
  );
}
