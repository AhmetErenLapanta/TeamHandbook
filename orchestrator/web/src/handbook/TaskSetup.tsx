import { useEffect, useState } from "react";
import { HandbookList } from "./HandbookList";
import { PluginNotices } from "./PluginNotices";
import { changesBetween, entriesOf } from "./handbook-list";
import { handbookRead, NOTHING_OFF } from "./handbook-read";
import type { HandbookSource, Off } from "./handbook-read";
import { here } from "../router";

/**
 * "This task will use", the first and plainest section beside the new task form: the person's setup, open on a wide screen
 * (a fold under the form on a narrow one), with the switches this task's start can honour, starting from their default. A change here is for this task alone and writes
 * nothing; the default changes on Team. The form sends the whole setup it shows, so a task can also turn on what the
 * default leaves out. Where the orchestrator reads no handbooks, nothing is drawn and the caller keeps its own line.
 */
export function TaskSetup({ folder, off, onOff, onRead }: { folder?: string; off: Off; onOff: (off: Off) => void; onRead?: (read: boolean) => void }) {
  const [sources, setSources] = useState<HandbookSource[] | null>(null);
  const [defaults, setDefaults] = useState<Off>(NOTHING_OFF);
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1100px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    let current = true;
    handbookRead.defaults().then((d) => {
      if (!current) return;
      setDefaults(d);
      onOff(d);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    handbookRead.sources(folder).then((r) => {
      if (!current) return;
      const found = "sources" in r ? r.sources : null;
      setSources(found);
      onRead?.(Boolean(found));
    }, () => {
      if (!current) return;
      setSources(null);
      onRead?.(false);
    });
    return () => {
      current = false;
    };
  }, [folder]);
  if (!sources) return null;
  const changes = changesBetween(sources, off, defaults);
  const all = entriesOf(sources, defaults, "task");
  const on = all.filter((e) => e.on).length;
  const list = <HandbookList sources={sources} off={off} defaultOff={defaults} level="task" onChange={onOff} />;
  return (
    <section className="task-setup" aria-labelledby="task-setup-h">
      <h2 id="task-setup-h">This task will use</h2>
      <p>{changes ? `${changes} ${changes === 1 ? "change" : "changes"} from your default` : `Your default setup: ${on} of ${all.length} on`}{changes ? <> · <button type="button" className="link" onClick={() => onOff(defaults)}>Reset</button></> : null}</p>
      <p className="muted small">Turn anything off for this task only; your default stays the same.</p>
      {/* Wide, the list stands open in the panel; narrow, it is a fold under the form. */}
      {wide ? <div className="task-setup-list">{list}</div> : <details><summary>What it loads</summary>{list}</details>}
      <p className="small task-setup-link"><a href={here("team")}>Change your default on Team</a></p>
      <PluginNotices sources={sources} look={<a href={here("team")}>Look</a>} putAway={(source) => handbookRead.noticed(source.id)} />
    </section>
  );
}
