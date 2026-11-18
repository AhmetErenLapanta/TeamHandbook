import { useEffect, useState } from "react";
import { call } from "../api";
import { CopyText } from "../Confirm";

type DataPart = "database" | "task-folders" | "attachments" | "copies" | "repositories" | "other";
export interface DataSize { total: number; parts: Record<DataPart, number>; partial: boolean; path: string; keep: number }

const NAMED: Partial<Record<DataPart, string>> = { "task-folders": "task folders", copies: "backups", repositories: "repository copies", attachments: "attached files", database: "task records" };
const NAMED_AT_MOST = 3;
const SHOWN_FROM = 0.1;
const WARN_FROM = 5 * 1024 ** 3;

/** KB, MB or GB, a single decimal only for a gigabyte count under ten. */
export function sizeSaid(bytes: number): string {
  if (bytes >= 1024 ** 3) {
    const gb = bytes / 1024 ** 3;
    return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
  }
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const list = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** What the data takes, in one sentence: the parts that are at least a tenth of it, largest first and three at most, the others as the rest. */
export function dataSaid(size: Pick<DataSize, "total" | "parts" | "partial">): string {
  const named = (Object.keys(NAMED) as DataPart[]).filter((p) => size.parts[p] >= size.total * SHOWN_FROM && size.parts[p] > 0).sort((a, b) => size.parts[b] - size.parts[a]).slice(0, NAMED_AT_MOST);
  const rest = size.total - named.reduce((sum, p) => sum + size.parts[p], 0);
  const pieces = [...named.map((p) => `${sizeSaid(size.parts[p])} of ${NAMED[p]}`), ...(rest > 0 ? [`${sizeSaid(rest)} of the rest`] : [])];
  return `It keeps ${size.partial ? "at least " : ""}${sizeSaid(size.total)} here: ${list(pieces)}.`;
}

/** What this machine's orchestrator takes of its disk, said to its owner; nothing is drawn for anyone it is not shown to. */
export function DataSizeLine() {
  const [size, setSize] = useState<DataSize | null>(null);
  useEffect(() => {
    let current = true;
    call<DataSize>("GET", "/api/data/size").then((s) => current && setSize(s), () => undefined);
    return () => {
      current = false;
    };
  }, []);
  if (!size) return null;
  return (
    <>
      <p className={size.total >= WARN_FROM ? "waiting" : undefined}>{dataSaid(size)}</p>
      {size.total >= WARN_FROM ? <p className="muted">Task folders of ended tasks go when the orchestrator starts, task logs after the days you set for them, and fewer backups are kept with ORCHESTRATOR_BACKUP_KEEP.</p> : null}
      {size.parts.copies > 0 ? <p className="muted small"><CopyText text={`${size.path}/backups`} /> the last {size.keep} kept; ORCHESTRATOR_BACKUP_HOURS and ORCHESTRATOR_BACKUP_KEEP set how often and how many.</p> : null}
    </>
  );
}
