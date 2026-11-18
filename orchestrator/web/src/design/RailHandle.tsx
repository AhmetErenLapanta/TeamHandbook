import { useEffect, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import { readPref, writePref } from "../prefs";

/** The rail's width in pixels: at least this, at most half the window, and this one to begin with. */
export const RAIL_MIN = 320;
export const RAIL_DEFAULT = 420;
const RAIL_KEY = "orchestrator.rail.width";
const STEP = 16;

const most = () => Math.max(RAIL_MIN, Math.floor(window.innerWidth / 2));
export const clampRail = (px: number, half: number = most()) => Math.min(Math.max(Math.round(px), RAIL_MIN), Math.max(RAIL_MIN, half));

/**
 * The width of a page's right rail, kept in this browser, and the handle that changes it: the rail's left edge drags with
 * the pointer, steps with the left and right arrows when it has focus, and goes back to the default on a double press.
 * One component for every page that has a rail; where the rail drops under the page the handle is not drawn.
 */
export function useRail(): { style: CSSProperties; handle: JSX.Element } {
  const [width, setWidth] = useState(() => {
    const kept = Number(readPref(RAIL_KEY));
    return clampRail(Number.isFinite(kept) && kept > 0 ? kept : RAIL_DEFAULT);
  });
  const [dragging, setDragging] = useState(false);
  const set = (px: number, keep = true) => {
    const next = clampRail(px);
    setWidth(next);
    if (keep) writePref(RAIL_KEY, next === RAIL_DEFAULT ? null : String(next));
  };
  // A window that shrinks takes the rail in with it, never past half.
  useEffect(() => {
    const fit = () => setWidth((w) => clampRail(w));
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (dragging) setWidth(clampRail(window.innerWidth - e.clientX - 32));
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") set(width + STEP);
    else if (e.key === "ArrowRight") set(width - STEP);
    else if (e.key === "Home") set(RAIL_DEFAULT);
    else return;
    e.preventDefault();
  };
  const handle = (
    <div
      className={`rail-handle${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Width of the side panel"
      aria-valuemin={RAIL_MIN}
      aria-valuemax={most()}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={() => {
        setDragging(false);
        set(width);
      }}
      onDoubleClick={() => set(RAIL_DEFAULT)}
      onKeyDown={key}
    />
  );
  return { style: { "--rail-width": `${width}px` } as CSSProperties, handle };
}
