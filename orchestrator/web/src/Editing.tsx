import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, apiPath, manages } from "./api";
import type { ChangeInput, ForgeSettings, Principal, Proposal, RepoRecord, RequestPage, RequestRecord, RequestStatus, TeamRecord, UsageAction } from "./api";
import { CopyText } from "./Confirm";
import { ChangePreview } from "./controls/ChangePreview";
import { RemovalImpactPanel } from "./controls/RemovalImpact";
import { FORGES, HOSTED_FORGES } from "../../shared/forge-def";
import type { HostedForge } from "../../shared/forge-def";
import { ForgeState } from "./ForgeState";
import { Markdown } from "./Markdown";
import { Loading, LoadFailed } from "./Status";
import { RequestDiff } from "./RequestDiff";
import { requestReads } from "./request-reads";
import { Pager } from "./Pager";
import { mergeCommand } from "./said";
import { here } from "./router";
import { Select } from "./Select";
import { toneOf } from "./design/tone";

/** The server's rule, repeated so the screen offers only what the server would accept. The server still decides. */
export function canEdit(me: Principal, team: string): boolean {
  return manages(me) || me.ownedTeams.includes(team);
}

export function openedNotice(r: RequestRecord): string {
  const notes = r.notes?.length ? ` ${r.notes.join(" ")}` : "";
  return `Request #${r.number} opened on ${r.branch}. It changes nothing until someone merges it.${notes}`;
}

type Described = { "aria-invalid"?: true; "aria-describedby"?: string };

/**
 * Every change goes through two steps: the server builds it and proposes a commit message,
 * and the person confirms or rewrites that message before anything is opened. A refusal
 * comes back at the first step, before a branch exists.
 */
export function ChangeForm({
  repoId,
  head,
  build,
  steps,
  children,
  submitLabel,
  onOpened,
  onCancel,
  onRefused,
}: {
  repoId: string;
  head: string;
  build?: () => ChangeInput;
  /** For a change the orchestrator builds itself: how it proposes the message and opens the request, in place of `build`. */
  steps?: { proposal: () => Promise<Proposal>; send: (message: string, branch: string) => Promise<RequestRecord> };
  /** The form's fields, given the attributes that tie each one to a refusal while it shows. */
  children?: (described: Described) => ReactNode;
  submitLabel: string;
  onOpened: (r: RequestRecord) => void;
  onCancel: () => void;
  onRefused?: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [branch, setBranch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const described: Described = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const review = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    (steps ? steps.proposal() : api.proposal(repoId, build!())).then(
      (proposed) => {
        setMessage(proposed.proposal);
        setBranch(proposed.branch);
        setBusy(false);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
        onRefused?.();
      },
    );
  };
  const open = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    (steps ? steps.send(message ?? "", branch) : api.propose(repoId, head, build!(), message ?? "", branch)).then(onOpened, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };
  return (
    <form className="form editor" onSubmit={message === null ? review : open}>
      <fieldset disabled={message !== null} className="plain-fieldset">{children?.(message === null ? described : {})}</fieldset>
      {message !== null ? (
        <>
          {build ? <ChangePreview repoId={repoId} change={build()} /> : null}
          <label>
            Commit message
            <input value={message} onChange={(e) => setMessage(e.target.value)} required {...described} />
          </label>
          <label>
            Branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} required spellCheck={false} {...described} />
          </label>
          {branch.includes("<TICKET>") ? <p className="muted">This team's branches start with a ticket: put it in place of &lt;TICKET&gt;.</p> : null}
        </>
      ) : null}
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy}>{message === null ? submitLabel : "Open request"}</button>
        {message !== null ? <button type="button" className="secondary" onClick={() => setMessage(null)}>Back</button> : null}
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const SKILL_TEMPLATE = "---\nname: \ndescription: Use when \n---\n\n";

export function SkillEditor({ repoId, head, slug, onOpened, onCancel }: { repoId: string; head: string; slug?: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  const [name, setName] = useState(slug ?? "");
  const [content, setContent] = useState<string | null>(slug ? null : SKILL_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // A skill that did not load is not offered as an empty one: saving that would delete its text.
    if (slug) api.skill(repoId, slug).then((s) => setContent(s.content), (e: Error) => setError(e.message));
  }, [repoId, slug]);
  if (error) {
    return (
      <div className="editor" role="alert">
        <p className="error">{slug} did not load, so it cannot be edited now. {error}</p>
        <button type="button" className="secondary" onClick={onCancel}>Close</button>
      </div>
    );
  }
  if (content === null) return <p className="muted">Loading the skill…</p>;
  return (
    <ChangeForm
      repoId={repoId}
      head={head}
      submitLabel={slug ? "Review the edit" : "Review the new skill"}
      build={() => ({ kind: slug ? "skill.edit" : "skill.add", slug: name, content })}
      onOpened={onOpened}
      onCancel={onCancel}
    >
      {(described) => (
        <>
          <h3>{slug ? `Edit ${slug}` : "Add a skill"}</h3>
          {slug ? null : <label>Skill name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="on-call-handover" required {...described} /></label>}
          <label>SKILL.md<textarea aria-label="SKILL.md" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} {...described} /></label>
        </>
      )}
    </ChangeForm>
  );
}

const COMMAND_TEMPLATE = "---\ndescription: What the command does, in one line.\n---\n\nThe steps Claude follows when someone types the command.\n";

export function CommandEditor({ repoId, head, name, onOpened, onCancel }: { repoId: string; head: string; name?: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  const [typed, setTyped] = useState(name ?? "");
  const [content, setContent] = useState<string | null>(name ? null : COMMAND_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // A command that did not load is not offered as an empty one: saving that would replace its text.
    if (name) api.command(repoId, name).then((c) => setContent(c.content), (e: Error) => setError(e.message));
  }, [repoId, name]);
  if (error) {
    return (
      <div className="editor" role="alert">
        <p className="error">/{name} did not load, so it cannot be edited here. {error}</p>
        <button type="button" className="secondary" onClick={onCancel}>Close</button>
      </div>
    );
  }
  if (content === null) return <p className="muted">Loading the command…</p>;
  return (
    <ChangeForm
      repoId={repoId}
      head={head}
      submitLabel={name ? "Review the edit" : "Review the new command"}
      build={() => ({ kind: name ? "command.edit" : "command.add", name: typed, content })}
      onOpened={onOpened}
      onCancel={onCancel}
    >
      {(described) => (
        <>
          <h3>{name ? `Edit /${name}` : "Add a slash command"}</h3>
          {name ? null : <label>Command name, a colon between a folder and the name<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="git:sync" required {...described} /></label>}
          <label>Command text<textarea aria-label="Command text" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} {...described} /></label>
        </>
      )}
    </ChangeForm>
  );
}

export function CommandRemoval({ repoId, head, name, onOpened, onCancel }: { repoId: string; head: string; name: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  return (
    <ChangeForm repoId={repoId} head={head} submitLabel={`Review removing /${name}`} build={() => ({ kind: "command.delete", name })} onOpened={onOpened} onCancel={onCancel}>
      {() => (
        <>
          <h3>Remove /{name}</h3>
          <p className="muted">The request deletes its file under commands/. Teammates lose the command once the request is merged.</p>
        </>
      )}
    </ChangeForm>
  );
}

export function SkillRemoval({ repoId, head, slug, onOpened, onCancel }: { repoId: string; head: string; slug: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  return (
    <ChangeForm repoId={repoId} head={head} submitLabel={`Review removing ${slug}`} build={() => ({ kind: "skill.delete", slug })} onOpened={onOpened} onCancel={onCancel}>
      {() => (
        <>
          <h3>Remove {slug}</h3>
          <p className="muted">The request deletes every file the skill ships. Teammates lose it once the request is merged.</p>
          <RemovalImpactPanel repoId={repoId} kind="skill" name={slug} />
        </>
      )}
    </ChangeForm>
  );
}

function pairs(text: string): Record<string, string> | undefined {
  const entries = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=");
      return at < 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const FORM_KEYS = new Set(["command", "args", "env", "type", "url", "headers"]);
const lines = (map: unknown) => (map && typeof map === "object" ? Object.entries(map as Record<string, unknown>).map(([k, v]) => `${k}=${String(v)}`).join("\n") : "");

/** A declared server's definition as the form's fields, and the keys the form has no field for, which an edit keeps as written. */
function formOf(name: string, config: Record<string, unknown>) {
  const stdio = typeof config.command === "string";
  return {
    form: {
      name,
      transport: stdio ? "stdio" : String(config.type ?? "http"),
      command: stdio ? String(config.command) : "",
      args: Array.isArray(config.args) ? config.args.map(String).join("\n") : "",
      url: typeof config.url === "string" ? config.url : "",
      env: lines(config.env),
      headers: lines(config.headers),
    },
    kept: Object.fromEntries(Object.entries(config).filter(([k]) => !FORM_KEYS.has(k))),
  };
}

export function McpForm({ repoId, head, name, onOpened, onCancel }: { repoId: string; head: string; name?: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ name: name ?? "", transport: "stdio", command: "", args: "", url: "", env: "", headers: "" });
  const [kept, setKept] = useState<Record<string, unknown>>({});
  const [loaded, setLoaded] = useState(!name);
  const [withheld, setWithheld] = useState<string | null>(null);
  useEffect(() => {
    if (!name) return;
    api.mcpServer(repoId, name).then(
      (s) => {
        const read = formOf(name, s.config);
        setForm(read.form);
        setKept(read.kept);
        setLoaded(true);
      },
      (e: Error) => {
        setWithheld(e.message);
        setLoaded(true);
      },
    );
  }, [repoId, name]);
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });
  const build = (): ChangeInput => {
    const env = pairs(form.env);
    const headers = pairs(form.headers);
    const args = form.args.split("\n").map((a) => a.trim()).filter(Boolean);
    const config =
      form.transport === "stdio"
        ? { ...kept, command: form.command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) }
        : { ...kept, type: form.transport, url: form.url, ...(headers ? { headers } : {}) };
    return name ? { kind: "mcp.edit", name, config } : { kind: "mcp.add", name: form.name, config };
  };
  // A refused definition usually holds a credential in one of these fields. It is cleared
  // from the form rather than left on the screen next to the refusal that names it.
  const clearValues = () => setForm((f) => ({ ...f, args: "", url: "", env: "", headers: "" }));
  if (!loaded) return <p className="muted">Loading the server…</p>;
  return (
    <ChangeForm repoId={repoId} head={head} submitLabel="Review the server" build={build} onOpened={onOpened} onCancel={onCancel} onRefused={clearValues}>
      {(described) => (
        <>
          <h3>{name ? `Edit ${name}` : "Add an MCP server"}</h3>
          <p className="muted">Values in env and headers travel only as <code>{"${VAR}"}</code> references; each teammate supplies the value on their own machine.</p>
          {withheld ? <p className="muted">{name}: {withheld}. Write it again here; the request replaces it.</p> : null}
          {Object.keys(kept).length ? <p className="muted">Kept as written: {Object.keys(kept).join(", ")}.</p> : null}
          {name ? null : <label>Server name<input value={form.name} onChange={set("name")} required {...described} /></label>}
          <Select label="Transport" value={form.transport} onChange={(v) => setForm({ ...form, transport: v as typeof form.transport })} describedBy={described["aria-describedby"]} invalid={Boolean(described["aria-invalid"])} options={[{ value: "stdio", label: "stdio (starts a command)" }, { value: "http", label: "http" }, { value: "sse", label: "sse" }]} />
          {form.transport === "stdio" ? (
            <>
              <label>Command<input value={form.command} onChange={set("command")} required {...described} /></label>
              <label>Arguments, one per line<textarea className="short" value={form.args} onChange={set("args")} {...described} /></label>
              <label>Environment, NAME=${"{"}VAR{"}"} per line<textarea className="short" aria-label="Environment" value={form.env} onChange={set("env")} {...described} /></label>
            </>
          ) : (
            <>
              <label>URL<input value={form.url} onChange={set("url")} required {...described} /></label>
              <label>Headers, Name=${"{"}VAR{"}"} per line<textarea className="short" aria-label="Headers" value={form.headers} onChange={set("headers")} {...described} /></label>
            </>
          )}
        </>
      )}
    </ChangeForm>
  );
}

export function McpRemoval({ repoId, head, name, onOpened, onCancel }: { repoId: string; head: string; name: string; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  return (
    <ChangeForm repoId={repoId} head={head} submitLabel={`Review removing ${name}`} build={() => ({ kind: "mcp.remove", name })} onOpened={onOpened} onCancel={onCancel}>
      {() => (
        <>
          <h3>Remove {name}</h3>
          <p className="muted">The request takes {name} out of .mcp.json and keeps every other entry. Teammates' Claude Code stops starting it once the request is merged.</p>
          <RemovalImpactPanel repoId={repoId} kind="mcp" name={name} />
        </>
      )}
    </ChangeForm>
  );
}

const USAGE_FORMS: Record<UsageAction, { title: string; text: string }> = {
  ask: { title: "Ask this team to report skill use", text: "The request sets the orchestrator's usage endpoint in .teamhandbook.json. Nothing is reported until it is merged and each teammate agrees on their own machine." },
  rotate: { title: "Give this team a new usage address", text: "The address teammates use today stops counting as soon as the request opens, and counts resume once it is merged. Each teammate's agreement covers one exact address, so every teammate is asked again before anything is sent to the new one." },
  stop: { title: "Stop asking this team for skill use", text: "The request takes usage out of .teamhandbook.json. Once it is merged, no teammate reports skill use for this repository; the counts already here stay." },
};

export function UsageReportForm({ repoId, head, action = "ask", onOpened, onCancel }: { repoId: string; head: string; action?: UsageAction; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  return (
    <ChangeForm
      repoId={repoId}
      head={head}
      steps={{ proposal: () => api.usageProposal(repoId, action), send: (message, branch) => api.proposeUsage(repoId, head, message, branch, action) }}
      submitLabel="Review the request"
      onOpened={onOpened}
      onCancel={onCancel}
    >
      {() => (
        <>
          <h3>{USAGE_FORMS[action].title}</h3>
          <p className="muted">{USAGE_FORMS[action].text}</p>
        </>
      )}
    </ChangeForm>
  );
}

const list = (text: string) => text.split(",").map((v) => v.trim()).filter(Boolean);

export function TeamSettingsForm({ repoId, head, team, onOpened, onCancel }: { repoId: string; head: string; team: TeamRecord | null; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  const [reviewers, setReviewers] = useState((team?.reviewers ?? []).join(", "));
  const [labels, setLabels] = useState((team?.labels ?? []).join(", "));
  return (
    <ChangeForm
      repoId={repoId}
      head={head}
      submitLabel="Review the change"
      build={() => ({ kind: "team.settings", reviewers: list(reviewers), labels: list(labels) })}
      onOpened={onOpened}
      onCancel={onCancel}
    >
      {(described) => (
        <>
          <h3>Reviewers and labels</h3>
          <p className="muted">Every other setting in .teamhandbook.json stays as it is.</p>
          <label>Reviewers, forge logins separated by commas<input value={reviewers} onChange={(e) => setReviewers(e.target.value)} {...described} /></label>
          <label>Labels, separated by commas<input value={labels} onChange={(e) => setLabels(e.target.value)} {...described} /></label>
        </>
      )}
    </ChangeForm>
  );
}

export function TeamNamingForm({ repoId, head, team, onOpened, onCancel }: { repoId: string; head: string; team: TeamRecord | null; onOpened: (r: RequestRecord) => void; onCancel: () => void }) {
  const [commitPrefix, setCommitPrefix] = useState(team?.commitPrefix ?? "");
  const [branchExample, setBranchExample] = useState(team?.branchExample ?? "");
  return (
    <ChangeForm
      repoId={repoId}
      head={head}
      submitLabel="Review the change"
      build={() => ({ kind: "team.naming", commitPrefix, branchExample })}
      onOpened={onOpened}
      onCancel={onCancel}
    >
      {(described) => (
        <>
          <h3>How commits and branches are named</h3>
          <p className="muted">Teammates' TeamHandbook and this orchestrator name every commit and branch they propose this way. Every other setting in .teamhandbook.json stays as it is.</p>
          <label>Commit prefix, what the repository asks at the front of every commit title; empty for none<input value={commitPrefix} onChange={(e) => setCommitPrefix(e.target.value)} {...described} /></label>
          <label>Example branch name, one written the way this repository names them; empty for none<input value={branchExample} onChange={(e) => setBranchExample(e.target.value)} {...described} /></label>
        </>
      )}
    </ChangeForm>
  );
}

export function RequestActions({ request, repo, me, onChanged }: { request: RequestRecord; repo: RepoRecord | undefined; me: Principal; onChanged: (r: RequestRecord) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!repo || !canEdit(me, repo.team)) return null;
  const act = (action: "merge" | "close" | "refresh") => {
    setError(null);
    api.requestAction(repo.id, request.number, action).then(onChanged, (err: Error) => setError(err.message));
  };
  // A merge refused where the branch is checked out ends with the command to run there, offered to copy.
  const merge = error ? mergeCommand(error) : null;
  return (
    <div className="row-actions">
      {request.provider === "local" && request.status === "open" ? (
        <>
          {request.heldHead ? null : <button type="button" className="secondary" onClick={() => act("merge")}>Merge</button>}
          <button type="button" className="secondary" onClick={() => act("close")}>Close</button>
        </>
      ) : null}
      {request.provider !== "local" ? <button type="button" className="secondary" onClick={() => act("refresh")}>Refresh</button> : null}
      {error ? <p className="error" role="alert">{merge ? <>{merge.said}: <CopyText text={merge.command} /></> : error}</p> : null}
    </div>
  );
}

/** A request's description, read when someone opens it, shown as the text it is. */
function RequestDescription({ request }: { request: RequestRecord }) {
  const [text, setText] = useState<string | null>(null);
  // An image attached on the forge needs its sign-in, which the browser does not hold: the orchestrator reads it.
  const media = request.provider === "local" ? undefined : (src: string) => apiPath(`/api/repos/${encodeURIComponent(request.repoId)}/media?${new URLSearchParams({ request: String(request.number), src })}`);
  const load = (open: boolean) => {
    if (!open || text !== null) return;
    api.requestDescription(request.repoId, request.number).then(
      (d) => setText(d.description ?? "This request's description is where the request is; open it there."),
      (err: Error) => setText(err.message),
    );
  };
  return (
    <details onToggle={(e) => load((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>Description</summary>
      {text === null ? <Loading what="the description" /> : <Markdown text={text} {...(media ? { media } : {})} />}
    </details>
  );
}

export function RequestTable({ requests, repos, me, showRepo, onChanged }: { requests: RequestRecord[]; repos: RepoRecord[]; me: Principal; showRepo?: boolean; onChanged: () => void }) {
  if (!requests.length) {
    const first = showRepo ? repos.find((r) => r.configured !== false && canEdit(me, r.team)) : undefined;
    return (
      <div className="empty-state">
        <p className="empty-state-title">No request opened from the orchestrator yet</p>
        <p className="muted">A change proposed on a repository's page, or a task's result, opens one here.</p>
        {first ? <div className="actions"><a className="button" href={here("repositories", first.id, "skills")}>Propose your first change</a></div> : null}
      </div>
    );
  }
  return (
    <table className="row-cards">
      <thead>
        <tr>{showRepo ? <th>Repository</th> : null}<th>#</th><th>Title</th><th>Branch</th><th>Status</th><th>Opened by</th><th><span className="visually-hidden">Actions</span></th></tr>
      </thead>
      <tbody>
        {requests.map((r) => (
          <tr key={`${r.repoId}-${r.number}`}>
            {showRepo ? <td className="mono rc-meta">{r.repoId}</td> : null}
            <td className="rc-meta">{r.url.startsWith("http") ? <a href={r.url} target="_blank" rel="noreferrer">{r.number}</a> : r.number}</td>
            <td className="rc-title"><span dir="auto">{r.title}</span><RequestDescription request={r} /><RequestDiff reads={requestReads(r.repoId, r.number)} /></td>
            <td className="mono rc-extra">{r.branch}</td>
            <td className="rc-status"><span className={`badge ${toneOf(r.status)}`}>{r.status === "open" ? "awaiting review" : r.status}</span><ForgeState request={r} /></td>
            <td className="rc-meta">{r.createdBy}</td>
            <td className="rc-wide"><RequestActions request={r} repo={repos.find((x) => x.id === r.repoId)} me={me} onChanged={onChanged} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const SHOWN: { value: RequestStatus | ""; label: string; none: string }[] = [
  { value: "", label: "Every request", none: "" },
  { value: "open", label: "Awaiting review", none: "No request is awaiting review." },
  { value: "merged", label: "Merged", none: "No request has been merged." },
  { value: "closed", label: "Closed", none: "No request has been closed." },
];

/**
 * The orchestrator's requests a page at a time, newest first, narrowed by state: the server holds
 * the list, so a tenant with thousands of requests sends and draws one page of them.
 * `version` changing reads the page again, as after a request is opened from the same screen;
 * `onChanged` hears of a merge or close made from the list.
 */
export function RequestList({ repoId, repos, me, showRepo, version = 0, onCounts, onChanged }: { repoId?: string; repos: RepoRecord[]; me: Principal; showRepo?: boolean; version?: number; onCounts?: (found: RequestPage) => void; onChanged?: () => void }) {
  const [status, setStatus] = useState<RequestStatus | "">("");
  // Where each page after the first starts, as the orchestrator handed it out: the page shown is
  // the last, and Previous drops it.
  const [starts, setStarts] = useState<string[]>([]);
  const [found, setFound] = useState<RequestPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let current = true;
    setError(null);
    api.requests({ repoId, status: status || null, after: starts.at(-1) ?? null }).then(
      (r) => {
        if (!current) return;
        // A merge or close that emptied the last page steps back a page, rather than reading
        // as if there were no requests at all.
        if (!r.requests.length && starts.length) return setStarts(starts.slice(0, -1));
        setFound(r);
        onCounts?.(r);
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [repoId, status, starts, version, reads]);
  const again = () => setReads((n) => n + 1);
  const shown = SHOWN.find((s) => s.value === status)!;
  return (
    <div className="request-list">
      {/* Narrowing means something only once there are requests to narrow, or while a narrowing is on. */}
      {status || found?.total ? <div className="filter">
        <Select label="Show" value={status} onChange={(v) => {
          setStatus(v as RequestStatus | "");
          setStarts([]);
        }} options={SHOWN.map((s) => ({ value: s.value, label: s.label }))} />
      </div> : null}
      {error ? <LoadFailed what="requests" reason={error} onRetry={again} /> : !found ? <Loading what="requests" /> : status && !found.requests.length ? <p className="muted">{shown.none}</p> : (
        <>
          <RequestTable requests={found.requests} repos={repos} me={me} showRepo={showRepo} onChanged={onChanged ?? again} />
          <Pager
            page={starts.length + 1}
            total={found.total}
            pageSize={found.pageSize}
            more={found.next !== null}
            onPage={(to) => setStarts(to > starts.length + 1 ? [...starts, found.next!] : starts.slice(0, -1))}
            label="Pages of requests"
          />
        </>
      )}
    </div>
  );
}

export function ForgePanel({ repo, suggest }: { repo: RepoRecord; suggest?: { kind: HostedForge; apiUrl: string; project: string } }) {
  const [settings, setSettings] = useState<ForgeSettings | null>(null);
  const [form, setForm] = useState({ kind: "gitlab" as "gitlab" | "github", apiUrl: "https://gitlab.com/api/v4", project: "", token: "", ...suggest });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const described: Described = error ? { "aria-invalid": true, "aria-describedby": errorId } : {};
  const load = () =>
    api.forge(repo.id).then((s) => {
      setSettings(s);
      if (s.config) setForm({ kind: s.config.kind, apiUrl: s.config.apiUrl, project: s.config.project, token: "" });
    }, (err: Error) => setError(err.message));
  useEffect(() => {
    load();
  }, [repo.id]);
  if (repo.url.startsWith("file://")) return <p className="muted">This repository is read by path, so its requests open in the repository itself, on this machine.</p>;
  if (!settings) return error ? <LoadFailed what="the forge access" reason={error} onRetry={() => {
    setError(null);
    load();
  }} /> : <Loading what="the forge access" />;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setError(null);
    api.saveForge(repo.id, { kind: form.kind, apiUrl: form.apiUrl, project: form.project, ...(form.token ? { token: form.token } : {}) }).then(
      () => {
        setForm({ ...form, token: "" });
        setNotice("Saved. The token is sealed; the orchestrator never shows it again.");
        load();
      },
      (err: Error) => {
        setForm({ ...form, token: "" });
        setError(err.message);
      },
    );
  };
  return (
    <form className="form inline-form" onSubmit={save} aria-label="Forge access">
      <Select label="Forge" value={form.kind} onChange={(v) => setForm({ ...form, kind: v as HostedForge, apiUrl: FORGES[v as HostedForge].apiUrlFor(new URL(`https://${FORGES[v as HostedForge].homeHosts[0]}`)) })} describedBy={described["aria-describedby"]} invalid={Boolean(described["aria-invalid"])} options={HOSTED_FORGES.filter((kind) => kind !== "gitea" || form.kind === "gitea" || settings.forges?.includes(kind)).map((kind) => ({ value: kind, label: FORGES[kind].label }))} />
      <label>API address<input value={form.apiUrl} onChange={(e) => setForm({ ...form, apiUrl: e.target.value })} required {...described} /></label>
      <label>Project<input value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} placeholder={FORGES[form.kind].projectShape} required {...described} /></label>
      <label>
        Token
        <input type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} {...described} placeholder={settings.token.set ? `set${settings.token.updatedAt ? ` ${settings.token.updatedAt.slice(0, 10)}` : ""}; empty keeps it while forge, address and project stay` : "a project access token"} />
      </label>
      <button type="submit" disabled={!settings.vault}>Save</button>
      {!settings.vault ? <p className="error">This orchestrator keeps no tokens until whoever runs it sets ORCHESTRATOR_SECRET_KEY and starts it again.</p> : null}
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  );
}
