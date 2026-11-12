import { useEffect, useState } from "react";
import { tasksApi } from "../api";
import type { TaskOptions } from "../api";

export type Personal = NonNullable<TaskOptions["agents"][number]["personal"]>;

/** How often a read of the person's own Claude Code that has not landed is asked for again, and how many times. */
export const PERSONAL_RETRY_MS = 1_500;
const PERSONAL_TRIES = 8;

/**
 * What one person's own Claude Code brings, as the start form reads it. The first answer of a
 * fresh orchestrator is empty while its read is still under way, so an empty answer is asked
 * again a few times before it is taken for one that cannot be read.
 */
export function usePersonalSetup(enabled: boolean): Personal | null {
  const [personal, setPersonal] = useState<Personal | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (left: number) => {
      tasksApi.options().then(
        (o) => {
          if (!live) return;
          const found = o.agents.find((a) => a.id === "claude-code")?.personal ?? null;
          if (found) setPersonal(found);
          else if (left > 1) timer = setTimeout(() => read(left - 1), PERSONAL_RETRY_MS);
        },
        () => undefined,
      );
    };
    read(PERSONAL_TRIES);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled]);
  return personal;
}
