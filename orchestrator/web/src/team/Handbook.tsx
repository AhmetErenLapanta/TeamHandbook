import { useEffect, useState } from "react";
import { api } from "../api";
import type { Inventory, JoinMessage, Principal, RepoRecord, RequestRecord } from "../api";
import { CopyText } from "../Confirm";
import { TurnSection } from "../design/TurnSection";
import { CommandEditor, CommandRemoval, McpForm, McpRemoval, SkillEditor, SkillRemoval, canEdit } from "../Editing";
import { Select } from "../Select";
import { LoadFailed, Loading } from "../Status";

import { HandbookAdd } from "./HandbookAdd";
import { HANDBOOK_TABS as TABS } from "./handbook-tabs";
import type { HandbookTab } from "./handbook-tabs";
import type { Picked } from "./handbook-api";

export type { HandbookTab };

/** One row of the handbook the rail opens: what it is, where it comes from, and the head a change is proposed against. */
export interface HandbookPick {
  repo: RepoRecord;
  head: string;
  tab: HandbookTab;
  name: string;
  sentence: string;
  editable: boolean;
}

/** A change already proposed, by the row it is for. */
export type Proposed = ReadonlyMap<string, { number: number; url: string | null }>;
export const pickKey = (repoId: string, tab: HandbookTab, name: string) => `${repoId}/${tab}/${name}`;

interface Counts { skills: { name: string; tasks: number | null }[]; mcpServers: { name: string; tasks: number | null }[] }

const taskCount = (tasks: number | null | undefined) => (tasks === null || tasks === undefined ? "" : tasks ? `, ${tasks} ${tasks === 1 ? "task" : "tasks"} this month` : ", no task this month");

function rowsOf(inventory: Inventory, tab: HandbookTab, counts: Counts): { name: string; sentence: string; tasks: number | null | undefined }[] {
  if (tab === "skills") return inventory.skills.map((s) => ({ name: s.slug, sentence: s.description, tasks: counts.skills.find((c) => c.name === s.slug || c.name === s.name)?.tasks }));
  if (tab === "mcp") return inventory.mcpServers.map((m) => ({ name: m.name, sentence: `${m.transport} server, ${m.target}`, tasks: counts.mcpServers.find((c) => c.name === m.name)?.tasks }));
  return inventory.commands.map((c) => ({ name: c.name, sentence: c.description, tasks: undefined }));
}

/**
 * The team's skills, MCP servers and commands, in the team repository, as one section with a tab
 * for each. A row opens in the rail; every change to one is a request the person opens.
 */
export function HandbookSection({ me, repos, counts, picked, proposed, onPick, onProposed }: { me: Principal; repos: RepoRecord[]; counts: Counts; picked: HandbookPick | null; proposed: Proposed; onPick: (pick: HandbookPick) => void; onProposed: (repoId: string, picked: Picked, request: { number: number; url: string }) => void }) {
  const teamRepos = repos.filter((r) => r.kind === "skills" && r.configured !== false);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [tab, setTab] = useState<HandbookTab>("skills");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [join, setJoin] = useState<JoinMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const repo = teamRepos.find((r) => r.id === repoId) ?? teamRepos[0];
  const load = (id: string) => {
    setError(null);
    api.inventory(id).then((r) => {
      setInventory(r.inventory);
      setJoin(r.join);
    }, (e: Error) => setError(e.message));
  };
  useEffect(() => {
    setInventory(null);
    setAdding(false);
    if (repo) load(repo.id);
  }, [repo?.id]);
  const where = me.mode === "local" ? "handbook repository" : "team repository";
  const empty = `Nothing is shared yet. A skill, MCP server or command added to the ${where} lands here once it is merged.`;
  if (!repo) return <TurnSection name="Team handbook" count={0} why={me.mode === "local" ? "What your Claude Code loads from the handbook repository you started or joined." : "What every teammate's Claude Code loads from the team's repository."} empty={empty} />;
  if (error) return <LoadFailed what="the team handbook" reason={error} onRetry={() => load(repo.id)} />;
  if (!inventory) return <Loading what="the team handbook" />;
  const total = inventory.skills.length + inventory.mcpServers.length + inventory.commands.length;
  const editable = canEdit(me, repo.team);
  const listed = rowsOf(inventory, tab, counts);
  const prefix = pickKey(repo.id, tab, "");
  const proposedNew = [...proposed.keys()].filter((k) => k.startsWith(prefix) && !listed.some((r) => r.name === k.slice(prefix.length))).map((k) => ({ name: k.slice(prefix.length), sentence: "", tasks: undefined }));
  const rows = [...listed, ...proposedNew];
  const label = TABS.find((t) => t.id === tab)!.label;
  const list = rows.length ? (
    <ul className="team-rows" aria-label={label}>
      {rows.map((r) => {
        const sent = proposed.get(pickKey(repo.id, tab, r.name));
        const on = picked?.repo.id === repo.id && picked.tab === tab && picked.name === r.name;
        return (
          <li key={r.name} className={on ? "picked" : undefined}>
            <button type="button" className="row-pick" aria-pressed={on} onClick={() => onPick({ repo, head: inventory.head, tab, name: r.name, sentence: r.sentence, editable })}><span className="mono">{r.name}</span></button>
            {r.sentence ? <span className="muted"> {r.sentence}</span> : null}
            <span className="muted"> from <span className="mono">{repo.name}</span>{taskCount(r.tasks)}</span>
            {sent ? <span className="muted"> {sent.url && /^https?:\/\//.test(sent.url) ? <a href={sent.url}>Proposed in !{sent.number}</a> : <>Proposed in !{sent.number}</>}, lands once merged</span> : null}
          </li>
        );
      })}
    </ul>
  ) : <p className="muted">{label} is empty in the {where}.</p>;
  return (
    <TurnSection name="Team handbook" count={total} why={me.mode === "local" ? "What your Claude Code loads from the handbook repository you started or joined." : "What every teammate's Claude Code loads from the team's repository."} empty={empty}>
      {teamRepos.length > 1 && me.mode !== "local" ? <div className="handbook-repo"><Select label="Team repository" value={repo.id} onChange={setRepoId} options={teamRepos.map((r) => ({ value: r.id, label: r.name }))} /></div> : null}
      {adding ? (
        <HandbookAdd repoId={repo.id} head={inventory.head} onCancel={() => setAdding(false)} onProposed={(sent, request) => {
          setAdding(false);
          onProposed(repo.id, sent, request);
        }} />
      ) : (
        <>
          {editable ? <p><button type="button" className="secondary" onClick={() => setAdding(true)}>Add from your Claude Code</button></p> : null}
          <div className="segmented" role="tablist" aria-label="Team handbook">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" className="secondary" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
          {list}
          {me.mode !== "local" && join && "use" in join ? (
            <p className="muted handbook-join">To get these in your own Claude Code: {join.use.map((c) => <CopyText key={c} text={c} />)}</p>
          ) : null}
        </>
      )}
    </TurnSection>
  );
}

/** The picked row's text, with Update and Remove for whoever can change the repository; each change is a request. */
export function HandbookRail({ pick, onOpened }: { pick: HandbookPick; onOpened: (r: RequestRecord) => void }) {
  const { repo, head, tab, name } = pick;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<"update" | "remove" | null>(null);
  useEffect(() => {
    setText(null);
    setError(null);
    setActing(null);
    if (tab === "mcp") return;
    (tab === "skills" ? api.skill(repo.id, name) : api.command(repo.id, name)).then((r) => setText(r.content), (e: Error) => setError(e.message));
  }, [repo.id, tab, name]);
  const form = { repoId: repo.id, head, onOpened, onCancel: () => setActing(null) };
  return (
    <>
      <h2 className="mono">{name}</h2>
      {tab === "mcp" ? <p className="muted">{pick.sentence}. Its values stay sealed; the repository holds only the names it needs.</p> : error ? <p className="error" role="alert">{error}</p> : text === null ? <p className="muted">Reading {name}…</p> : <pre className="handbook-text">{text}</pre>}
      {pick.editable && !acting ? (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => setActing("update")}>Update…</button>
          <button type="button" className="secondary" onClick={() => setActing("remove")}>Remove…</button>
        </div>
      ) : null}
      {acting === "update" && tab === "skills" ? <SkillEditor key={`u-${name}`} {...form} slug={name} /> : null}
      {acting === "update" && tab === "commands" ? <CommandEditor key={`u-${name}`} {...form} name={name} /> : null}
      {acting === "update" && tab === "mcp" ? <McpForm key={`u-${name}`} {...form} name={name} /> : null}
      {acting === "remove" && tab === "skills" ? <SkillRemoval key={`r-${name}`} {...form} slug={name} /> : null}
      {acting === "remove" && tab === "commands" ? <CommandRemoval key={`r-${name}`} {...form} name={name} /> : null}
      {acting === "remove" && tab === "mcp" ? <McpRemoval key={`r-${name}`} {...form} name={name} /> : null}
    </>
  );
}
