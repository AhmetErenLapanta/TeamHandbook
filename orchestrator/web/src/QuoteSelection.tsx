import { useEffect, useState } from "react";
import { AGENT_LOG, MOST_QUOTED_TEXT } from "./diff-quote";
import type { Quote } from "./diff-quote";

interface Picked { quote: Quote; top: number; left: number }

/** The log line a node sits in, by the sequence number its row carries; null outside the agent's rows. */
function seqOf(node: Node | null): number | null {
  const row = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-seq]");
  const seq = Number(row?.dataset.seq);
  return row && Number.isInteger(seq) ? seq : null;
}

/** What the person has selected in the agent's words or the log, as a quote of the log lines it covers; null for any other selection. */
export function pickedQuote(selection: Selection | null): Picked | null {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  const inside = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest("[data-quotable]");
  const container = inside(selection.anchorNode);
  if (!container || container !== inside(selection.focusNode)) return null;
  const [from, to] = [seqOf(selection.anchorNode), seqOf(selection.focusNode)];
  if (from === null || to === null) return null;
  const text = selection.toString().trim().slice(0, MOST_QUOTED_TEXT);
  if (!text) return null;
  const [first, last] = from <= to ? [from, to] : [to, from];
  const box = selection.getRangeAt(0).getBoundingClientRect();
  return { quote: { path: AGENT_LOG, lines: first === last ? `${first}` : `${first}-${last}`, text }, top: box.bottom + 6, left: Math.max(8, box.left) };
}

/**
 * A small button under a selection in the agent's words or the log, which puts those lines in the
 * follow-up as a quote, as the diff's lines are. It shows only where a follow-up can be sent.
 */
export function QuoteSelection({ onQuote }: { onQuote: (quote: Quote) => void }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  useEffect(() => {
    const read = () => setPicked(pickedQuote(window.getSelection()));
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);
  if (!picked) return null;
  return (
    <button
      type="button"
      className="secondary small quote-selection"
      style={{ top: picked.top, left: picked.left }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onQuote(picked.quote);
        window.getSelection()?.removeAllRanges();
      }}
    >
      Quote in follow-up
    </button>
  );
}
