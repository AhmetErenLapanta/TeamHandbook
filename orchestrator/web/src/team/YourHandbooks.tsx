import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { call } from "../api";
import { lastAnswer, rememberAnswer } from "../last-answer";
import { TurnSection } from "../design/TurnSection";
import { HandbookList } from "../handbook/HandbookList";
import { NewFile } from "../handbook/HandbookFile";
import type { FileKind } from "../handbook/handbook-file";
import { handbookRead, NOTHING_OFF } from "../handbook/handbook-read";
import type { HandbookSource, Off, SourcesRead } from "../handbook/handbook-read";
import type { Machine } from "../machines/api";
import { machinesApi } from "../machines/api";
import { LoadFailed, Loading, Refreshing } from "../Status";
import { AddPlugin } from "./AddPlugin";
import { PluginNotices } from "../handbook/PluginNotices";
import { PluginActions } from "./PluginActions";

type PluginAnswer = { ok: true; command: string } | { ok: false; command: string; why: string };
type Said = { tone: "done" | "refused"; text: string } | null;


/** A skill's text as the person's machine reads it. */
const readOn = (machine: string) => (source: string, name: string) => call<{ content: string }>("GET", `/api/handbook/skill?${new URLSearchParams({ source, name, machine })}`).then((r) => r.content);

/** The person's own machine a team's server reads their setup through: the one last seen, of those still paired to them. */
export function ownMachine(machines: Machine[], me: string): Machine | null {
  return machines.filter((m) => m.userId === me).sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""))[0] ?? null;
}

/** On a team's server, the person's own setup as their machine reads it; nothing is drawn for one with no machine of theirs. */
export function MachineHandbooks({ me }: { me: string }) {
  const [machine, setMachine] = useState<Machine | null | undefined>(undefined);
  useEffect(() => {
    machinesApi.list().then((r) => setMachine(ownMachine(r.machines, me)), () => setMachine(null));
  }, [me]);
  return machine ? <YourHandbooks machine={{ id: machine.id, name: machine.name }} fallback={null} /> : null;
}

/**
 * The person's own Claude Code setup on their Team page: how agents started here begin. A plugin's
 * switch runs Claude Code's own command, so the page says once what ran or why Claude Code refused;
 * a skill, command or server switch is the person's own list, kept here and applied to each task.
 * On a team's server it is read from and changed on the person's own machine, which they name by
 * pairing it; adding a skill, command or plugin is then done in their terminal there.
 */
export function YourHandbooks({ fallback, machine }: { fallback: ReactNode; machine?: { id: string; name: string } }) {
  const on = machine ? `?${new URLSearchParams({ machine: machine.id })}` : "";
  const readPath = `/api/handbook/sources${on}`;
  const last = lastAnswer<{ sources: HandbookSource[]; off: Off }>(readPath);
  const [sources, setSources] = useState<HandbookSource[] | null>(last?.sources ?? null);
  const [why, setWhy] = useState<string | null>(null);
  const [off, setOff] = useState<Off>(last?.off ?? NOTHING_OFF);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<Said>(null);
  const [busy, setBusy] = useState(false);
  // What the one Add control has open: its menu, a new skill or command's form, or a plugin to install.
  const [adding, setAdding] = useState<FileKind | "plugin" | "menu" | null>(null);
  const [look, setLook] = useState<{ source: string } | undefined>(undefined);
  const read = () => {
    setError(null);
    setRefreshing(true);
    // The person's own list is read only where their Claude Code is: anywhere else there is none to read.
    (machine ? call<SourcesRead>("GET", `/api/handbook/sources${on}`) : handbookRead.sources()).then(async (r) => {
      if ("available" in r && r.available === false) return setWhy(r.why);
      const defaults = await handbookRead.defaults().catch(() => NOTHING_OFF);
      const fresh = rememberAnswer(readPath, { sources: (r as { sources: HandbookSource[] }).sources, off: defaults });
      setOff(fresh.off);
      setSources(fresh.sources);
    }, (e: Error) => setError(e.message)).finally(() => setRefreshing(false));
  };
  useEffect(read, []);
  if (error) return <LoadFailed what="your handbooks" reason={error} onRetry={read} />;
  if (why) return machine ? <TurnSection name="Your handbooks" count={0} why={`Read from ${machine.name}.`} empty={`${why}.`} /> : <>{fallback}</>;
  if (!sources) return <Loading what="your handbooks" />;
  const save = (next: Off) => {
    const before = off;
    setOff(next);
    setSaid(null);
    call<{ off: Partial<Off> }>("PUT", "/api/handbook/defaults", { off: { skills: next.skills, commands: next.commands, mcpServers: next.mcpServers } }).then(() => rememberAnswer(readPath, { sources, off: next })).catch((e: Error) => {
      setOff(before);
      setSaid({ tone: "refused", text: e.message });
    });
  };
  const ran = (r: PluginAnswer) => {
    setSaid(r.ok ? { tone: "done", text: `Ran ${r.command}.` } : { tone: "refused", text: `Claude Code refused ${r.command}: ${r.why}` });
    read();
  };
  // Claude Code's own marketplace refresh, on a click: until it runs, a version the local copy lacks is not known.
  const check = () => {
    setBusy(true);
    setSaid(null);
    call<PluginAnswer>("POST", "/api/handbook/marketplaces/update").then(ran, (e: Error) => setSaid({ tone: "refused", text: e.message })).finally(() => setBusy(false));
  };
  const plugin = (source: HandbookSource, turnOn: boolean) => {
    setBusy(true);
    setSaid(null);
    call<PluginAnswer>("POST", `/api/handbook/plugins/${turnOn ? "enable" : "disable"}${on}`, { plugin: source.id }).then(ran, (e: Error) => setSaid({ tone: "refused", text: e.message })).finally(() => setBusy(false));
  };
  const count = sources.length;
  return (
    <TurnSection name="Your handbooks" count={count} hideCount why={machine ? `Read from your Claude Code on ${machine.name}.` : "Read from your Claude Code on this computer."} empty="Your Claude Code has nothing of its own yet; a skill, plugin or server you add there shows here.">
      {refreshing ? <Refreshing what="your handbooks" /> : null}
      {said ? <p className={said.tone === "done" ? "muted" : "error"} role={said.tone === "done" ? "status" : "alert"}>{said.text}</p> : null}
      <PluginNotices
        sources={sources}
        look={<button type="button" className="link small" onClick={() => setLook({ source: sources.find((s) => s.notice)!.id })}>Look</button>}
        putAway={(source) => call<{ noticed: string }>("POST", `/api/handbook/noticed${on}`, { plugin: source.id })}
      />
      <div aria-busy={busy}>
        <HandbookList sources={sources} off={off} level="default" onChange={save} onPlugin={(source, on) => void (!busy && plugin(source, on))} pluginActions={(source) => <PluginActions source={source} onRan={ran} {...(machine ? { machine } : {})} />} {...(machine ? { read: readOn(machine.id) } : { files: { onChanged: read } })} look={look} />
      </div>
      {machine ? null : (
        <div className="handbook-add">
          {adding === null ? <button type="button" className="handbook-add-row" onClick={() => setAdding("menu")}>Add a skill, a command, an MCP server or a plugin</button> : null}
          {adding === null ? <button type="button" className="link small" disabled={busy} onClick={check}>Check for updates</button> : null}
          {adding === "menu" ? (
            <div className="handbook-add-options">
              <button type="button" className="secondary" onClick={() => setAdding("skill")}>New skill</button>
              <button type="button" className="secondary" onClick={() => setAdding("command")}>New command</button>
              <button type="button" className="secondary" onClick={() => setAdding("plugin")}>Add a plugin</button>
              <button type="button" className="link muted" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          ) : null}
          {adding === "skill" || adding === "command" ? <NewFile kind={adding} onDone={(saved) => { setAdding(null); if (saved) read(); }} /> : null}
          {adding === "plugin" ? <AddPlugin onCancel={() => setAdding(null)} onRan={(r) => {
            setAdding(null);
            ran(r);
          }} /> : null}
        </div>
      )}
    </TurnSection>
  );
}
