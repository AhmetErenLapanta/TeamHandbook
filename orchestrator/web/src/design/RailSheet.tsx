import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const NARROW = "(max-width: 1023px)";

/**
 * The picked row's rail: beside the page where there is room, and a side panel over it where the rail would otherwise land
 * under a long list, out of sight of the row that was pressed.
 */
export function RailSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const query = window.matchMedia(NARROW);
    const changed = () => setNarrow(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (narrow && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [narrow]);
  if (!narrow) return <aside className="rail" aria-label={label}>{children}</aside>;
  return (
    <dialog ref={dialog} className="side-panel" aria-label={label} onClose={onClose}>
      <header>
        <h2>{label}</h2>
        <div className="actions"><button type="button" className="secondary" onClick={onClose}>Close</button></div>
      </header>
      <section>{children}</section>
    </dialog>
  );
}
