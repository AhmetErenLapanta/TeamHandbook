import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { entriesOf, flipEntry, handbookLabel, ordered, skillBody, summaryOf, tokensSaid, unusedSaid, usedSaid } from "./handbook-list";
import type { Entry, Level } from "./handbook-list";
import { flipSource, handbookRead, sourceOff } from "./handbook-read";
import type { HandbookSource, Off } from "./handbook-read";
import { Loading } from "../Status";
import { CopyToYours, FileEditor, RemoveFile } from "./HandbookFile";
import { ownSource } from "./handbook-file";
import { showLogLine } from "../find-in-task";

/** The most characters of a name or a sentence the list draws: they come from files, so they are data and cut. */
const NAME_AT_MOST = 80;
const SENTENCE_AT_MOST = 160;
/** Items a handbook shows opened before "Show all", and the items past which the list is searched. */
const FIRST_GLANCE = 7;
const SEARCH_FROM = 20;
const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most).trimEnd()}…` : text);

export type { Level };

/** Where a switch on Team reaches, beside it before it is pressed. */
const REACH_ITEM = "here";
const REACH_PLUGIN = "here and in your terminal";

const LEAD: Record<Level, string | null> = {
  default: "How agents started here begin. Turning a plugin off turns it off in your terminal too.",
  task: null,
  readonly: null,
};

/** The text of a skill, read only, drawn as plain text. */
function SkillText({ source, name, read }: { source: string; name: string; read: (source: string, name: string) => Promise<string> }) {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    read(source, name).then((t) => current && setText(t), (e: Error) => current && setProblem(e.message));
    return () => {
      current = false;
    };
  }, [source, name]);
  if (problem !== null) return <p className="error small" role="alert">{problem}</p>;
  if (text === null) return <Loading what="the skill" />;
  return <pre className="pre mono small">{skillBody(text)}</pre>;
}

/** The product's switch, which can read as mixed for a plugin some of whose items are off. */
function Switch({ on, mixed = false, label, disabled = false, onChange }: { on: boolean; mixed?: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={mixed ? "mixed" : on} aria-label={label} disabled={disabled} onClick={onChange}>
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
    </button>
  );
}

type State = { word: string; danger: boolean; seq?: number };
/** What a row offers for the person's own files: on Team alone, each change written and the list read again after. */
export interface FileActions { onChanged: () => void }
interface RowProps { entry: Entry; locked: boolean; changed: boolean; reach?: string; state?: State; read: (source: string, name: string) => Promise<string>; onFlip: () => void; files?: FileActions }

/** One item: its name, its kind in a word, and its switch or state word; opened in place it says what it is, what it costs and how it is used. */
function Row({ entry, locked, changed, reach, state, read, onFlip, files }: RowProps) {
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileKind = entry.kind === "Skill" ? "skill" : entry.kind === "Command" ? "command" : null;
  const own = ownSource(entry.source.id);
  const id = useId();
  const name = cut(entry.name, NAME_AT_MOST);
  const whyShown = Boolean(entry.whyNot) && !locked && !state;
  // A row opens only where it has something to show: a hook with a command, the rules file, anything else of a kind with a text.
  const openable = entry.kind !== "Hook" || (entry.hook?.commands.length ?? 0) > 0;
  return (
    <li className="handbook-row">
      <div className="handbook-line">
        {openable ? <button type="button" className="link mono handbook-name" title={entry.name} aria-expanded={opened} aria-controls={id} onClick={() => setOpened(!opened)} dir="auto">{name}</button> : <span className="mono handbook-name" title={entry.name}>{name}</span>}
        <span className="handbook-meta">
          <span className="muted small">{entry.kind}</span>
          {changed ? <span className="muted small">Changed</span> : null}
          {!entry.on && entry.offNote && !state ? <span className="muted small">{entry.offNote}</span> : null}
          {state?.seq !== undefined ? <button type="button" className="link small" onClick={() => showLogLine(state.seq!)}>Show where</button> : null}
        </span>
        {/* The state word or the switch ends the row, with where the switch reaches beside it, so every row's switch lines up. */}
        {state ? <span className={`handbook-end ${state.danger ? "error small" : "muted small"}`}>{state.word}</span> : entry.switchable && !locked ? (
          <span className="handbook-end">{/* Only on Team, where reach is said: the task panel carries no use notes. */}{reach && unusedSaid(entry.used, entry.on) ? <span className="muted small handbook-idle" title={unusedSaid(entry.used, entry.on)!} role="img" aria-label={unusedSaid(entry.used, entry.on)!}>○</span> : null}{reach ? <span className="muted small">{reach}</span> : null}<Switch on={entry.on} label={`Use ${name}`} onChange={onFlip} /></span>
        ) : null}
      </div>
      {/* An item with no switch says why on its own line, unopened, where its switch would be read. */}
      {whyShown ? <p className="muted small handbook-why">{cut(entry.whyNot!, SENTENCE_AT_MOST)}</p> : null}
      {opened ? (
        <div id={id} className="handbook-open small">
          {entry.sentence ? <p dir="auto">{cut(entry.sentence, SENTENCE_AT_MOST)}</p> : null}
          {entry.context ? <p className="muted">{tokensSaid(entry.context)}</p> : null}
          {entry.used && entry.used.tasks > 0 ? <p className="muted">{usedSaid(entry.used)}</p> : null}
          {entry.clash ? <p className="muted">{entry.clash}</p> : null}
          {entry.hook ? (
            <dl className="plugin-changes">
              {entry.hook.matchers.length ? <><dt>Matches</dt><dd className="mono">{entry.hook.matchers.join(", ")}</dd></> : null}
              <dt>Runs</dt><dd className="mono">{entry.hook.commands.join("; ")}</dd>
            </dl>
          ) : null}
          {entry.kind === "Rules" ? <SkillText source={entry.source.id} name={entry.name} read={read} /> : null}
          {entry.whyNot && !whyShown ? <p className="muted">{cut(entry.whyNot, SENTENCE_AT_MOST)}</p> : null}
          {editing && fileKind ? (
            <FileEditor source={entry.source.id} kind={fileKind} name={entry.name} onDone={(saved) => { setEditing(false); if (saved) files?.onChanged(); }} />
          ) : entry.kind === "Skill" ? <SkillText source={entry.source.id} name={entry.name} read={read} /> : null}
          {files && fileKind && !editing ? (
            own ? (
              <div className="actions">
                <button type="button" className="secondary small" aria-label={`Edit ${name}`} onClick={() => setEditing(true)}>Edit…</button>
                <RemoveFile source={entry.source.id} kind={fileKind} name={entry.name} onDone={files.onChanged} />
              </div>
            ) : fileKind === "skill" ? (
              <>
                <p className="muted">It changes in {cut(handbookLabel(entry.source), NAME_AT_MOST)}.</p>
                <CopyToYours source={entry.source.id} name={entry.name} read={read} onDone={files.onChanged} />
              </>
            ) : null
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A handbook opened in place: its items on first, at most seven before "Show all", what is off folded last. */
function Items({ entries, rowFor }: { entries: Entry[]; rowFor: (e: Entry) => ReactNode }) {
  const [all, setAll] = useState(false);
  const on = entries.filter((e) => e.on);
  const off = entries.filter((e) => !e.on);
  return (
    <div className="handbook-things">
      <ul className="plain">{(all ? on : on.slice(0, FIRST_GLANCE)).map(rowFor)}</ul>
      {on.length > FIRST_GLANCE && !all ? <p><button type="button" className="link small" onClick={() => setAll(true)}>Show all ({on.length})</button></p> : null}
      {off.length ? (
        <details className="handbooks-off small">
          <summary>Off ({off.length})</summary>
          <ul className="plain">{off.map(rowFor)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The one list of what an agent loads: a row a handbook (Yours, This folder, then plugins by name), each opened in place to
 * its items, and one line above that sums it. A plugin's row has its own switch, which reads mixed while some of it is off;
 * Yours and This folder are switched item by item. Drawn on Team (how every agent started here begins), in the new task form
 * (this task alone, as changes from the default) and on the task page (read only, a state word in place of each switch).
 */
export function HandbookList({ sources, off, defaultOff, level, onChange, onPlugin, stateOf, read = handbookRead.skill, pluginActions, files, look }: {
  sources: HandbookSource[];
  off: Off;
  defaultOff?: Off;
  level: Level;
  onChange?: (off: Off) => void;
  /** On Team a plugin's switch runs Claude Code's own command rather than changing the list; the page says what ran. */
  onPlugin?: (source: HandbookSource, on: boolean) => void;
  stateOf?: (e: Entry) => State;
  read?: (source: string, name: string) => Promise<string>;
  /** On Team, what a plugin's opened row offers under its items: its update and its removal, each asked first by the page. */
  pluginActions?: (source: HandbookSource) => ReactNode;
  /** On Team, a skill or command of the person's own is edited and removed in its row, and a plugin's copied to Yours. */
  files?: FileActions;
  /** On Team, the source a "Look" on its notice opens; each press is a new object, so a second press opens it again. */
  look?: { source: string };
}) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (look) setOpen(look.source);
  }, [look]);
  const [search, setSearch] = useState("");
  const id = useId();
  const locked = level === "readonly" || !onChange;
  const entries = entriesOf(sources, off, level);
  const summary = summaryOf(sources, off, entries);
  const lead = LEAD[level];
  const before = defaultOff ? new Map(entriesOf(sources, defaultOff, level).map((e) => [e.key, e.on])) : null;
  const changedOf = (e: Entry) => Boolean(before && e.list && before.get(e.key) !== e.on);
  const needle = search.trim().toLowerCase();
  const rowFor = (e: Entry) => <Row key={e.key} entry={e} locked={locked} changed={changedOf(e)} {...(level === "default" ? { reach: REACH_ITEM } : {})} {...(stateOf ? { state: stateOf(e) } : {})} read={read} onFlip={() => onChange?.(flipEntry(off, e))} {...(files ? { files } : {})} />;
  if (!sources.length) return <p className="muted">Your Claude Code has no skills of its own yet.</p>;
  // The fold of what is off opens when the person turns a handbook off, so the switch they pressed stays where they can see it.
  const [offOpen, setOffOpen] = useState(false);
  const flipPlugin = (s: HandbookSource) => {
    if (!sourceOff(off, s)) setOffOpen(true);
    return onPlugin ? onPlugin(s, sourceOff(off, s)) : onChange?.(flipSource(off, s.id));
  };
  const handbooks = ordered(sources);
  const offSources = handbooks.filter((s) => sourceOff(off, s));
  const onSources = handbooks.filter((s) => !sourceOff(off, s));
  const handbookRow = (s: HandbookSource) => {
      const mine = entries.filter((e) => e.source.id === s.id);
      const isOff = sourceOff(off, s);
      const onCount = isOff ? 0 : mine.filter((e) => e.on).length;
      const opened = open === s.id;
      const plugin = s.kind === "plugin";
      return (
        <li key={s.id} className="handbook">
          <div className="handbook-line">
            <button type="button" className="link handbook-name" aria-expanded={opened} aria-controls={`${id}-${s.id}`} onClick={() => setOpen(opened ? null : s.id)} dir="auto">{cut(s.kind === "yours" ? "Yours" : s.kind === "folder" ? `This folder (${s.name})` : s.name, NAME_AT_MOST)}</button>
            <span className="handbook-meta">
              {s.version ? <span className="muted small">{cut(s.version, 24)}{s.latest ? ` → ${cut(s.latest.version, 24)}` : ""}</span> : null}
              {s.latest && pluginActions && !opened ? <button type="button" className="link small" onClick={() => setOpen(s.id)}>Update…</button> : null}
              <span className="muted small">{isOff ? "off" : `${onCount} of ${mine.length} on`}{level === "default" && !isOff && mine.filter((e) => unusedSaid(e.used, e.on)).length ? `, ${mine.filter((e) => unusedSaid(e.used, e.on)).length} not used in 30 days` : ""}</span>
            </span>
            {plugin && !locked && !s.whyNot ? <span className="handbook-end">{level === "default" ? <span className="muted small">{REACH_PLUGIN}</span> : null}<Switch on={!isOff} mixed={!isOff && onCount < mine.length} label={`Use ${cut(handbookLabel(s), NAME_AT_MOST)}`} disabled={level === "task" && !s.enabled} onChange={() => flipPlugin(s)} /></span> : null}
          </div>
          {s.whyNot ? <p className="muted small">{cut(s.whyNot, SENTENCE_AT_MOST)}</p> : null}
          {opened ? <div id={`${id}-${s.id}`} className="handbook-opened"><Items entries={mine} rowFor={rowFor} />{plugin && pluginActions ? pluginActions(s) : null}</div> : null}
        </li>
      );
  };
  return (
    <div className="handbook-list">
      {lead ? <p className="handbook-lead">{lead}</p> : null}
      {level === "task" ? null : <p className={summary.heavy ? "waiting small" : "muted small"}>{summary.text}</p>}
      {entries.length > SEARCH_FROM ? <label className="filter small">Find in this list<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} /></label> : null}
      {needle ? (
        <ul className="plain handbook-things">{entries.filter((e) => `${e.name} ${handbookLabel(e.source)}`.toLowerCase().includes(needle)).map(rowFor)}</ul>
      ) : (
        <>
          <ul className="plain handbooks">
            {onSources.map(handbookRow)}
            {offSources.length ? (
              <li className="handbook-off">
                <div className="handbook-line">
                  <button type="button" className="link handbook-name" aria-expanded={offOpen} aria-controls={`${id}-off`} onClick={() => setOffOpen(!offOpen)}>Off</button>
                  <span className="handbook-end"><span className="muted small">{offSources.length} {offSources.length === 1 ? "handbook" : "handbooks"}</span></span>
                </div>
                {offOpen ? <div id={`${id}-off`} className="handbook-opened"><ul className="plain handbooks">{offSources.map(handbookRow)}</ul></div> : null}
              </li>
            ) : null}
          </ul>
        </>
      )}
    </div>
  );
}
