import { useEffect, useRef, useState } from "react";

/**
 * Tells a screen reader once when a page's state changes, not when it opens. Two regions take turns,
 * so words said again after something else are still read; a single region that already holds
 * them stays silent.
 */
export function Announcer({ message }: { message: string }) {
  const [turns, setTurns] = useState<[string, string]>(["", ""]);
  const first = useRef(true);
  const turn = useRef(0);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    turn.current = 1 - turn.current;
    setTurns(turn.current ? ["", message] : [message, ""]);
  }, [message]);
  return (
    <div className="visually-hidden">
      <span aria-live="polite">{turns[0]}</span>
      <span aria-live="polite">{turns[1]}</span>
    </div>
  );
}
