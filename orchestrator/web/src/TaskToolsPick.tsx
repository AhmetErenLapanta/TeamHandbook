import { useEffect, useState } from "react";
import { AddSource } from "./repo/TaskTools";
import type { LoadedCounts } from "./api";
import { taskTools } from "./task-tools-read";
import type { TaskMcpServer, TaskSkills } from "./task-tools-read";

/**
 * What a start names of the project's tools: its skills by source and name, its MCP servers by id,
 * and of those the ones that run a command, ticked by the person with that command in front of them.
 */
export interface PickedTools { projectSkills: { source: string; name: string }[]; mcpServers: string[]; commands: string[] }
export const NO_TOOLS: PickedTools = { projectSkills: [], mcpServers: [], commands: [] };
/** What the person's own Claude Code has, read from their machine; it loads with every task, so it is shown and not picked. Its skills and slash commands come as one list, as the CLI names them. */
export interface PersonalTools { commands: { name: string; description: string }[]; plugins: { name: string; enabled: boolean }[]; mcpServers?: { name: string }[]; claudeMd?: boolean }

/**
 * What a new task takes of a project's tools before the person picks: every skill and every server
 * reached by its address, but no server that runs a command, since that command, written by whoever
 * added it, would run on the person's machine; they tick it themselves, reading the command.
 */
export function firstPicks(skills: TaskSkills["project"], servers: TaskMcpServer[]): PickedTools {
  return { projectSkills: skills.map((s) => ({ source: s.source, name: s.name })), mcpServers: servers.filter((m) => m.transport === "http").map((m) => m.id), commands: [] };
}

/** A server as its chip names it: a command server with the command it runs, an address server by name alone. */
export function serverLabel(server: TaskMcpServer): string {
  return server.transport === "stdio" ? `${server.name} runs ${[server.command, ...server.args].join(" ")}` : server.name;
}

const counted = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);

export function loadedList(counts: LoadedCounts): string | null {
  const parts = [
    counted(counts.commands, "skill or command", "skills or commands"),
    counted(counts.plugins, "plugin", "plugins"),
    counted(counts.mcpServers, "MCP server", "MCP servers"),
    counts.claudeMd ? "CLAUDE.md" : null,
  ].filter((p): p is string => p !== null);
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function loadedSentence(label: string, personal: PersonalTools | null | undefined): string | null {
  if (!personal) return null;
  const listed = loadedList({ commands: personal.commands.length, plugins: personal.plugins.filter((p) => p.enabled).length, mcpServers: personal.mcpServers?.length ?? 0, claudeMd: Boolean(personal.claudeMd) });
  return listed ? `${label} loads ${listed}` : null;
}

export function AgentLoaded({ label, personal }: { label: string; personal: PersonalTools | null | undefined }) {
  const sentence = loadedSentence(label, personal);
  if (!sentence || !personal) return null;
  const names = [...personal.plugins.filter((p) => p.enabled).map((p) => p.name), ...personal.commands.map((c) => `/${c.name}`), ...(personal.mcpServers ?? []).map((m) => m.name)];
  return (
    <details className="agent-loaded muted small">
      <summary>{sentence}.</summary>
      {names.length ? <p className="mono">{names.join(", ")}</p> : null}
    </details>
  );
}

/**
 * The project's skills and MCP servers a task takes on top of the person's own Claude Code, each
 * picked to begin with; and for the person who adds them, a skill repository added from here.
 */
export function TaskToolsPick({ repoId, value, onChange, canAdd }: { repoId: string; value: PickedTools; onChange: (next: PickedTools) => void; canAdd: boolean }) {
  const [skills, setSkills] = useState<TaskSkills["project"]>([]);
  const [servers, setServers] = useState<TaskMcpServer[]>([]);
  const [adding, setAdding] = useState(false);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    // A person who may not change the project's tools still starts tasks with its servers; one who reads none starts with none.
    Promise.all([taskTools.skills(repoId).then((r) => r.project, () => []), taskTools.read(repoId).then((r) => r.mcpServers, () => [])]).then(([read, listed]) => {
      if (!current) return;
      setSkills(read);
      setServers(listed);
      onChange(firstPicks(read, listed));
    });
    return () => {
      current = false;
    };
  }, [repoId, reads]);
  if (!skills.length && !servers.length && !canAdd) return null;
  const skillOn = (s: { source: string; name: string }) => value.projectSkills.some((p) => p.source === s.source && p.name === s.name);
  const flipSkill = (s: { source: string; name: string }) => onChange({ ...value, projectSkills: skillOn(s) ? value.projectSkills.filter((p) => !(p.source === s.source && p.name === s.name)) : [...value.projectSkills, { source: s.source, name: s.name }] });
  const flipServer = (id: string) => {
    const mcpServers = value.mcpServers.includes(id) ? value.mcpServers.filter((m) => m !== id) : [...value.mcpServers, id];
    onChange({ ...value, mcpServers, commands: mcpServers.filter((m) => servers.find((s) => s.id === m)?.transport === "stdio") });
  };
  return (
    <fieldset className="plain-fieldset task-tools">
      <legend>Skills and MCP servers for this task</legend>
      {skills.length || servers.length ? (
        <div className="chips" role="group" aria-label="The project's skills and MCP servers">
          {skills.map((s) => (
            <label key={`${s.source}:${s.name}`} className={`chip-pick${skillOn(s) ? " on" : ""}`} title={s.description}>
              <input type="checkbox" checked={skillOn(s)} onChange={() => flipSkill(s)} />
              <span className="mono">{s.name}</span>
            </label>
          ))}
          {servers.map((m) => (
            <label key={m.id} className={`chip-pick${value.mcpServers.includes(m.id) ? " on" : ""}`} title={m.transport === "http" ? m.url : undefined}>
              <input type="checkbox" checked={value.mcpServers.includes(m.id)} onChange={() => flipServer(m.id)} />
              <span className="mono">{serverLabel(m)}</span> <span className="muted small">MCP</span>
            </label>
          ))}
        </div>
      ) : null}
      {canAdd ? (adding ? <AddSource project={repoId} onCancel={() => setAdding(false)} onAdded={() => {
        setAdding(false);
        setReads((n) => n + 1);
      }} /> : <p><button type="button" className="link" onClick={() => setAdding(true)}>Add a skill repository</button></p>) : null}
    </fieldset>
  );
}
