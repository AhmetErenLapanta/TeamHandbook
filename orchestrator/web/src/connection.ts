/** Whether the orchestrator answers the page's calls, and since when it has not: the page's one record of it. */
type Listener = () => void;

let lostSince: number | null = null;
const listeners = new Set<Listener>();

const changed = () => listeners.forEach((l) => l());

export const connection = {
  /** A call got no answer at all. */
  lost(): void {
    if (lostSince !== null) return;
    lostSince = Date.now();
    changed();
  },
  /** A call got an answer, whatever it said. */
  found(): void {
    if (lostSince === null) return;
    lostSince = null;
    changed();
  },
  since: (): number | null => lostSince,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
