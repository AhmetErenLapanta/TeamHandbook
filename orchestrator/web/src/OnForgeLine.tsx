import { useEffect, useState } from "react";
import type { ChecksSummary } from "../../shared/forge-read";
import type { OnForgeRead } from "../../shared/forge-read";
import { forgeRequestName, FORGES } from "../../shared/forge-def";
import { checksLine } from "./ForgeState";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const clock = (at: string) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** A request a person's press opened on a forge, in its forge's own facts, or why it could not be read. */
export function onForgeSaid(read: OnForgeRead): string {
  const name = forgeRequestName(read.kind, read.number);
  if ("unread" in read) return `Not read from ${FORGES[read.kind].label} for now: ${read.unread}`;
  const { status, checks, approvals, comments, mergedBy, readAt } = read.read;
  const facts = status === "merged" ? [mergedBy ? `merged by ${mergedBy}` : "merged"] : status === "closed" ? ["closed"] : [checksLine({ state: checks, checks: [] } satisfies ChecksSummary), count(approvals, "approval", "approvals"), count(comments, "comment", "comments")];
  return `${name}: ${[...facts, `read at ${clock(readAt)}`].join(", ")}`;
}

/** Read once as the page opens, with the person's own sign-in, and again only on the press; a request never opened on a forge draws nothing. */
export function OnForgeLine({ load }: { load: () => Promise<OnForgeRead | null> }) {
  const [read, setRead] = useState<OnForgeRead | null>(null);
  const [busy, setBusy] = useState(false);
  const again = () => {
    setBusy(true);
    load().then(setRead, () => setRead(null)).finally(() => setBusy(false));
  };
  useEffect(again, []);
  if (!read) return null;
  return (
    <p className="muted small forge-state">
      {onForgeSaid(read)} <button type="button" className="link" disabled={busy} onClick={again}>Read again</button>
    </p>
  );
}
