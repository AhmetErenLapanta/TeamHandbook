import { useEffect, useRef } from "react";
import { tasksApi } from "./api";
import type { Principal } from "./api";
import { ATTENTION, attentionOf, newCalls } from "./attention";
import type { Attention } from "./attention";
import { usePref } from "./prefs";
import { here, navigate } from "./router";

export const NOTIFY_KEY = "orchestrator.attention.notify";
const SEEN_KEY = "orchestrator.attention.seen";
/** Calls kept as seen, newest last: enough for a busy week, small enough for a browser's storage. */
const SEEN_KEPT = 500;
// Quick while the page is in front, slow behind another tab: the person is told either way.
const IN_FRONT_MS = 15_000;
const BEHIND_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

function keepSeen(seen: Set<string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_KEPT)));
  } catch {
    // A browser that keeps nothing for this page calls again after a reload; nothing else is lost.
  }
}

function onScreenTask(): string | null {
  return /\/tasks\/([^/]+)$/.exec(window.location.pathname)?.[1] ?? null;
}

let plainIcon: string | null = null;

/** The tab's icon: the orchestrator's mark, with the number of tasks waiting on the person when there are any. */
function drawIcon(count: number): void {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const g = canvas.getContext("2d");
  if (!g) return;
  // The app icon's own mark, drawn as shapes: a typeset T differs from one system font to the next.
  g.fillStyle = "#2856d8";
  g.beginPath();
  g.roundRect(0, 0, 64, 64, 14);
  g.fill();
  g.fillStyle = "#ffffff";
  g.fillRect(18, 18, 28, 7);
  g.fillRect(28.5, 25, 7, 21);
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (count > 0) {
    g.fillStyle = "#b42318";
    g.beginPath();
    g.arc(46, 18, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.font = "bold 22px sans-serif";
    g.fillText(count > 9 ? "9+" : String(count), 46, 19);
  }
  const href = canvas.toDataURL("image/png");
  if (count === 0) plainIcon = href;
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.append(link);
  }
  link.href = count === 0 && plainIcon ? plainIcon : href;
}

/**
 * Watches the tasks this person started for the moment one wants them: approval, a question, a
 * limit, a request ready for review, a failure. The tab's icon and title count what waits, and
 * when the person allowed it, the browser says so once per call, never for the task on screen.
 */
export function AttentionWatcher({ me }: { me: Principal }) {
  const [notify] = usePref(NOTIFY_KEY);
  const before = useRef<Map<string, Attention | null> | null>(null);
  const title = useRef(document.title.replace(/^\(\d+\+?\) /, ""));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const look = async () => {
      try {
        const tasks = (await tasksApi.since(new Date(Date.now() - DAY_MS).toISOString())).filter((t) => t.createdBy === me.email);
        const seen = readSeen();
        // A task page open in a tab nobody is looking at has not been seen: only a page in front counts.
        const onScreen = document.hidden ? null : onScreenTask();
        for (const t of tasks) {
          const a = attentionOf(t);
          if (a && t.id === onScreen) seen.add(`${t.id}:${a}`);
        }
        const calls = newCalls(before.current, tasks, seen, onScreen);
        if (notify === "yes" && "Notification" in window && Notification.permission === "granted") {
          for (const call of calls) {
            const task = tasks.find((t) => t.id === call.id)!;
            const shown = new Notification(ATTENTION[call.attention].title(task.title), { tag: `${call.id}:${call.attention}`, body: "TeamHandbook Orchestrator" });
            shown.onclick = () => {
              window.focus();
              navigate(here("tasks", call.id));
            };
          }
        }
        before.current = new Map(tasks.map((t) => [t.id, attentionOf(t)]));
        keepSeen(seen);
        const waiting = tasks.filter((t) => {
          const a = attentionOf(t);
          return a && !seen.has(`${t.id}:${a}`);
        }).length;
        drawIcon(waiting);
        // An installed app shows the same count on its dock or taskbar icon; a browser tab has none.
        const badge = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
        void (waiting ? badge.setAppBadge?.(waiting) : badge.clearAppBadge?.())?.catch(() => undefined);
        document.title = waiting ? `(${waiting > 9 ? "9+" : waiting}) ${title.current}` : title.current;
      } catch {
        // A look that fails changes nothing on screen; the next one tries again.
      }
      if (!stopped) timer = setTimeout(look, document.hidden ? BEHIND_MS : IN_FRONT_MS);
    };
    void look();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [me.email, notify]);
  return null;
}
