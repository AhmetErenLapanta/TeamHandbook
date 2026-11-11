import { useId } from "react";
import type { ReactNode } from "react";

/**
 * One part of a settings page, in the page's own rhythm: its name and one sentence on the left, what
 * is set there on the right, parted from the next by a hairline rather than held in a box.
 */
export function SettingsSection({ name, why, danger = false, children }: { name: string; why?: ReactNode; danger?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`turn${danger ? " turn-danger" : ""}`} aria-labelledby={id}>
      <div className="turn-side">
        <h2 id={id}>{name}</h2>
        {why ? <p className="turn-why">{why}</p> : null}
      </div>
      <div className="turn-body">{children}</div>
    </section>
  );
}
