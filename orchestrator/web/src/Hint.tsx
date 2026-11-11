import type { ReactNode } from "react";

/** A region's help, behind its (i): the screen says the next step once, and anything longer waits here. */
export function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="hint">
      <summary aria-label={`About ${label}`}>i</summary>
      <p>{children}</p>
    </details>
  );
}
