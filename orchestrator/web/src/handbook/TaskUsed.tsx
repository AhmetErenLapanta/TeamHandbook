import { useEffect, useState } from "react";
import { showLogLine } from "../find-in-task";
import { entriesOf, handbookLabel } from "./handbook-list";
import type { Entry } from "./handbook-list";
import { handbookRead, NOTHING_OFF, sourceOff } from "./handbook-read";
import type { HandbookSource, Off } from "./handbook-read";

/** What a task recorded of its agent: the skills it called and the servers whose tools it called, each with its handbook as the orchestrator read it. */
export interface TaskUsedRecord {
  /** `seq`: the log line where the agent first called it, for "Show where". */
  skills: { name: string; source: string; sourceLabel: string; version?: string; seq?: number }[];
  mcpServers: { name: string; source: string; sourceLabel: string; seq?: number }[];
}

/** The most characters of a name the block draws: names come from files and the agent's stream, so they are data and cut. */
const NAME_AT_MOST = 80;
const cut = (text: string) => (text.length > NAME_AT_MOST ? `${text.slice(0, NAME_AT_MOST).trimEnd()}…` : text);

export type Word = "Used" | "Loaded" | "Off" | "Off for this task" | "Loaded, though off";

/** The state word a row reads on the task page, and the line the agent called it on. */
export function stateOf(e: Entry, used: TaskUsedRecord | undefined, offByDefault: ReadonlySet<string> | null = null): { word: Word; danger: boolean; seq?: number } {
  const callOf = (list: { name: string; source: string; seq?: number }[] | undefined) => list?.find((u) => u.name === e.name && u.source === e.source.id);
  const call = e.kind === "Skill" ? callOf(used?.skills) : e.kind === "Server" ? callOf(used?.mcpServers) : undefined;
  // Off in the person's default as well is plain "Off"; only what this task turned off itself is "Off for this task".
  if (!e.on) return call ? { word: "Loaded, though off", danger: true } : { word: offByDefault?.has(e.key) ? "Off" : "Off for this task", danger: false };
  return call ? { word: "Used", danger: false, ...(call.seq !== undefined ? { seq: call.seq } : {}) } : { word: "Loaded", danger: false };
}

/** What the agent reported it loaded as its session opened; null for a kind it did not report. */
export interface StartedWithReport { plugins: string[] | null; skills: string[] | null; mcpServers: { name: string; state: "connected" | "starting" | "needs-sign-in" | "failed" | "off" }[] | null }

/**
 * Where what the setup says and what the agent reported differ: a plugin or a server that was on and did not load. A plugin
 * is matched by its name, as the agent may name it with or without its marketplace.
 */
export function didNotLoad(sources: HandbookSource[], off: Off, report: StartedWithReport | undefined): string[] {
  if (!report) return [];
  const plugins = report.plugins?.map((p) => p.split("@")[0]!);
  const missingPlugins = plugins ? sources.filter((s) => s.kind === "plugin" && !sourceOff(off, s) && !plugins.includes(s.name)).map((s) => s.name) : [];
  const servers = report.mcpServers ? new Map(report.mcpServers.map((m) => [m.name, m.state])) : null;
  const missingServers = servers ? entriesOf(sources, off, "readonly").filter((e) => e.kind === "Server" && e.on && e.source.kind !== "plugin" && (!servers.has(e.name) || servers.get(e.name) === "failed" || servers.get(e.name) === "off")).map((e) => e.name) : [];
  return [...missingPlugins, ...missingServers];
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "12 skills, 3 plugins, 4 MCP servers, CLAUDE.md": what the task's agent started with, counted once. */
export function startedSaid(sources: HandbookSource[], off: Off, entries: Entry[]): string {
  const on = entries.filter((e) => e.on);
  const skills = on.filter((e) => e.kind === "Skill").length;
  const plugins = sources.filter((s) => s.kind === "plugin" && !sourceOff(off, s)).length;
  const servers = on.filter((e) => e.kind === "Server").length;
  const parts = [skills ? count(skills, "skill", "skills") : null, plugins ? count(plugins, "plugin", "plugins") : null, servers ? count(servers, "MCP server", "MCP servers") : null, on.some((e) => e.kind === "Rules") ? "CLAUDE.md" : null].filter((p): p is string => p !== null);
  return parts.length ? parts.join(", ") : "Nothing of your setup";
}

/** One row: a used one's name links to the stream line where the agent called it; elsewhere the row carries its state word. */
function Line({ e, state, word = true }: { e: Entry; state: ReturnType<typeof stateOf>; word?: boolean }) {
  const name = cut(e.name);
  return (
    <li className="started-line">
      {state.seq !== undefined ? <button type="button" className="link mono" onClick={() => showLogLine(state.seq!)} dir="auto">{name}</button> : <span className="mono" dir="auto">{name}</span>}{" "}
      <span className="muted small">from {cut(e.source.kind === "yours" ? "yours" : handbookLabel(e.source))}</span>
      {word ? <> <span className={state.danger ? "error small" : "muted small"}>{state.word}</span></> : null}
    </li>
  );
}

/**
 * "Started with", the task page's one block about what its agent loaded: one line counting it, then by name what the agent
 * used, each with its handbook, and what was only loaded or left out in two folds. An item turned off that loaded anyway leads,
 * in the danger tone. The handbooks are the ones the form and Team show. With no setup kept, the block is what was used.
 */
export function TaskUsed({ setup, off = NOTHING_OFF, used, report }: { setup?: HandbookSource[]; off?: Off; used?: TaskUsedRecord; report?: StartedWithReport }) {
  const [defaults, setDefaults] = useState<Off | null>(null);
  useEffect(() => {
    let current = true;
    handbookRead.defaults().then((d) => current && setDefaults(d), () => undefined);
    return () => {
      current = false;
    };
  }, []);
  const sources = setup ?? usedOnly(used);
  if (!sources.length) return null;
  const entries = entriesOf(sources, off, "readonly");
  // What is off in the default as well: known once the default is read, else every off row says "for this task" only when the page was told.
  const offByDefault = defaults ? new Set(entriesOf(sources, defaults, "readonly").filter((e) => !e.on).map((e) => e.key)) : null;
  const rows = entries.map((e) => ({ e, state: stateOf(e, used, offByDefault) }));
  const of = (word: Word) => rows.filter((r) => r.state.word === word);
  const leaked = of("Loaded, though off");
  const usedRows = of("Used");
  const fold = (title: string, list: typeof rows) => (list.length ? (
    <details className="small">
      <summary>{title} ({list.length})</summary>
      <ul className="plain">{list.map((r) => <Line key={r.e.key} e={r.e} state={r.state} />)}</ul>
    </details>
  ) : null);
  return (
    <section aria-labelledby="task-started-h" className="task-started">
      <h2 id="task-started-h">Started with</h2>
      {setup ? didNotLoad(sources, off, report).map((name) => <p key={name} className="error small">{cut(name)} was on and did not load.</p>) : null}
      <p>{setup ? startedSaid(sources, off, entries) : count(usedRows.length, "item used", "items used")}</p>
      {leaked.length || usedRows.length ? (
        <ul className="plain">
          {leaked.map((r) => <Line key={r.e.key} e={r.e} state={r.state} />)}
          {usedRows.map((r) => <Line key={r.e.key} e={r.e} state={r.state} word={false} />)}
        </ul>
      ) : <p className="muted small">The agent called no skill or server.</p>}
      {fold("Loaded", of("Loaded"))}
      {fold("Off", of("Off"))}
      {fold("Off for this task", of("Off for this task"))}
    </section>
  );
}

/** A setup made of what the task recorded, a handbook each by its label, for a task whose setup was not kept. */
function usedOnly(used: TaskUsedRecord | undefined): HandbookSource[] {
  if (!used) return [];
  const byId = new Map<string, HandbookSource>();
  const sourceOf = (id: string, label: string) => {
    const kind: HandbookSource["kind"] = id === "yours" ? "yours" : id.startsWith("folder:") ? "folder" : id.startsWith("team:") ? "team-repo" : "plugin";
    // The recorded label is already said whole ("the team's payments-skills"); the name under it is what the label is made from.
    const name = kind === "team-repo" ? label.replace(/^the team's /, "") : kind === "folder" ? label.replace(/^this folder \((.*)\)$/i, "$1") : label;
    if (!byId.has(id)) byId.set(id, { id, kind, name, enabled: true, skills: [], commands: [], mcpServers: [], hooks: [] });
    return byId.get(id)!;
  };
  for (const k of used.skills) sourceOf(k.source, k.sourceLabel).skills.push({ name: k.name });
  for (const m of used.mcpServers) sourceOf(m.source, m.sourceLabel).mcpServers.push({ name: m.name });
  return [...byId.values()];
}
