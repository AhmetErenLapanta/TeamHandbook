import { useEffect, useId, useState } from "react";
import type { FormEvent } from "react";
import { myMcpApi } from "./api";
import type { NewPersonalServer, PersonalServer, PersonalServers, Principal, RepoRecord, RequestRecord } from "./api";
import { ConfirmAction } from "./Confirm";
import { canEdit, ChangeForm, openedNotice } from "./Editing";
import { Select } from "./Select";
import { Loading, LoadFailed } from "./Status";

const EMPTY: NewPersonalServer = { name: "", description: "", transport: "http", url: "", auth: "oauth" };

function credentialText(server: PersonalServer): string {
  if (server.auth === "none") return "No sign-in";
  if (server.auth === "token") return server.credential?.set ? "Token set" : "No token";
  if (!server.credential?.set) return "Not connected";
  return server.credential.expiresAt ? `Connected until ${server.credential.expiresAt.slice(0, 16).replace("T", " ")}${server.credential.refreshable ? ", renewed for each task" : ""}` : "Connected";
}

/** What came back from a server's sign-in, in the address the orchestrator returned the browser to: its query, or the query of its hash. */
function returned(): { connected: string | null; problem: string | null } {
  const query = new URLSearchParams(window.location.search);
  const hashed = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return { connected: query.get("connected") ?? hashed.get("connected"), problem: query.get("problem") ?? hashed.get("problem") };
}

/**
 * Your own MCP servers: given to the tasks you start, with your access, and to nobody else.
 * A server that signs people in is connected once in the browser; the orchestrator keeps the
 * tokens sealed and renews them before each task.
 */
export function MyMcpServers({ me, repos }: { me: Principal; repos: RepoRecord[] }) {
  const [read, setRead] = useState<PersonalServers | null>(null);
  const [form, setForm] = useState<NewPersonalServer>(EMPTY);
  const [args, setArgs] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(returned().problem);
  const [notice, setNotice] = useState<string | null>(returned().connected ? `${returned().connected} is connected. Pick the tools a task may use.` : null);
  const [busy, setBusy] = useState(false);
  // "me" adds a server of one's own; a repository id proposes it to that team instead.
  const [scope, setScope] = useState("me");
  const [teamChange, setTeamChange] = useState<{ repoId: string; head: string; config: Record<string, unknown>; name: string } | null>(null);
  const errorId = useId();
  const teamRepos = repos.filter((r) => r.configured !== false && r.head && canEdit(me, r.team));
  const load = () => myMcpApi.list().then(setRead, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  const run = (work: () => Promise<unknown>, done: string | null) => {
    setError(null);
    setNotice(null);
    setBusy(true);
    work().then(
      () => {
        setBusy(false);
        if (done) setNotice(done);
        load();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  /** After a confirmed change, which reports its own failure in the question it asked. */
  const done = (said: string) => {
    setError(null);
    setNotice(said);
    load();
  };
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (scope !== "me") {
      const repo = teamRepos.find((r) => r.id === scope)!;
      const config = form.transport === "http" ? { type: "http", url: form.url } : { command: form.command, args: args.split("\n").map((a) => a.trim()).filter(Boolean) };
      setTeamChange({ repoId: repo.id, head: repo.head!, config, name: form.name });
      return;
    }
    const input: NewPersonalServer = form.transport === "http"
      ? { name: form.name, description: form.description, transport: "http", url: form.url, auth: form.auth, ...(form.auth === "token" ? { token } : {}) }
      : { name: form.name, description: form.description, transport: "stdio", command: form.command, args: args.split("\n").map((a) => a.trim()).filter(Boolean), auth: "none" };
    run(async () => {
      await myMcpApi.add(input);
      setForm(EMPTY);
      setArgs("");
      setToken("");
    }, `${input.name} is added.${input.auth === "oauth" ? " Connect it to sign in." : " Pick the tools a task may use."}`);
  };
  if (!read) return error ? <LoadFailed what="your MCP servers" reason={error} onRetry={() => { setError(null); load(); }} /> : <Loading what="your MCP servers" />;
  return (
    <>
      <p className="muted">A server of your own reaches only the tasks you start, with your own access. One for a team goes in through a request someone reviews.</p>
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {read.servers.length ? (
        <ul className="plain my-servers">
          {read.servers.map((s) => <ServerRow key={s.name} server={s} signIn={read.signIn} busy={busy} run={run} done={done} />)}
        </ul>
      ) : <p className="muted">You have added no server yet.</p>}
      <form className="form editor" onSubmit={add} aria-label="Add an MCP server">
        <h4>Add an MCP server</h4>
        <Select label="For" value={scope} onChange={setScope} disabled={teamChange !== null} options={[{ value: "me", label: "Only the tasks I start" }, ...teamRepos.map((r) => ({ value: r.id, label: `The ${r.team} team, through a request on ${r.name}` }))]} />
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required spellCheck={false} aria-describedby={error ? errorId : undefined} /></label>
        <label>Description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <Select label="Reached" value={form.transport} onChange={(v) => setForm({ ...form, transport: v as "http" | "stdio", auth: v === "http" ? "oauth" : "none" })} options={[{ value: "http", label: "Over the network (URL)" }, { value: "stdio", label: "As a command in the task" }]} />
        {form.transport === "http" ? (
          <>
            <label>URL<input type="url" value={form.url ?? ""} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="https://mcp.example.com/mcp" aria-describedby={error ? errorId : undefined} /></label>
            {scope === "me" ? <Select label="Sign-in" value={form.auth} onChange={(v) => setForm({ ...form, auth: v as NewPersonalServer["auth"] })} options={[{ value: "oauth", label: "Sign in through the browser (OAuth)" }, { value: "token", label: "A token" }, { value: "none", label: "None" }]} /> : <p className="muted">A team server that needs a credential names a variable each teammate sets; edit it on the repository's page after this request.</p>}
            {scope === "me" && form.auth === "token" ? <label>Token<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required disabled={!read.vault} /></label> : null}
            {scope === "me" && form.auth !== "none" && !read.vault ? <p className="error">Set ORCHESTRATOR_SECRET_KEY on the server to keep a token or a sign-in.</p> : null}
            {scope === "me" && form.auth === "oauth" && !read.signIn ? <p className="error">Set ORCHESTRATOR_PUBLIC_URL on the server: a sign-in returns to it.</p> : null}
          </>
        ) : (
          <>
            <label>Command<input value={form.command ?? ""} onChange={(e) => setForm({ ...form, command: e.target.value })} required spellCheck={false} placeholder="npx" /></label>
            <label>Arguments, one per line<textarea className="short" value={args} onChange={(e) => setArgs(e.target.value)} spellCheck={false} /></label>
          </>
        )}
        {teamChange === null ? <div className="actions"><button type="submit" disabled={busy}>{scope === "me" ? "Add" : "Review the request"}</button></div> : null}
      </form>
      {teamChange ? (
        <ChangeForm
          repoId={teamChange.repoId}
          head={teamChange.head}
          build={() => ({ kind: "mcp.add", name: teamChange.name, config: teamChange.config })}
          submitLabel="Check the server"
          onOpened={(r: RequestRecord) => {
            setTeamChange(null);
            setForm(EMPTY);
            setArgs("");
            setNotice(openedNotice(r));
          }}
          onCancel={() => setTeamChange(null)}
        >
          {() => <h4>Add {teamChange.name} for the team</h4>}
        </ChangeForm>
      ) : null}
    </>
  );
}

/**
 * What is ticked once a server's tools are loaded: the first time, only the tools that surely read,
 * so one Save never gives tasks a tool that changes something as the person without their asking;
 * after that, what they last saved.
 */
export function firstPick(listed: readonly { name: string; reads: boolean }[], saved: readonly string[]): string[] {
  return saved.length ? [...saved] : listed.filter((t) => t.reads).map((t) => t.name);
}

/** The tools as the page groups them: the reading ones, and the ones that can change something. */
export function groupTools<T extends { writes: boolean }>(tools: readonly T[]): { reads: T[]; writes: T[] } {
  return { reads: tools.filter((t) => !t.writes), writes: tools.filter((t) => t.writes) };
}

function ServerRow({ server, signIn, busy, run, done }: { server: PersonalServer; signIn: boolean; busy: boolean; run: (work: () => Promise<unknown>, done: string | null) => void; done: (said: string) => void }) {
  const [offered, setOffered] = useState<{ name: string; description: string; writes: boolean; reads: boolean }[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(server.tools);
  const [typed, setTyped] = useState(server.tools.join(", "));
  const tools = offered ?? server.tools.map((name) => ({ name, description: "", writes: server.known?.[name]?.writes ?? server.writing.includes(name) }));
  const writes = (name: string) => tools.find((t) => t.name === name)?.writes ?? false;
  const toggle = (n: string) => setChosen(chosen.includes(n) ? chosen.filter((c) => c !== n) : [...chosen, n]);
  const load = () =>
    run(async () => {
      const listed = await myMcpApi.tools(server.name);
      setOffered(listed);
      setChosen(firstPick(listed, server.tools));
    }, null);
  const connect = () => run(async () => window.location.assign(await myMcpApi.connect(server.name)), null);
  // A server reached and allowed no tool yet loads its tools by itself, the reading ones ticked, so one Save lets tasks use it.
  // It is quiet: the page's notice stays, and a load that fails leaves Load tools to try again.
  const reached = server.transport === "http" && (server.auth !== "oauth" || Boolean(server.credential?.set));
  useEffect(() => {
    if (!reached || server.tools.length) return;
    myMcpApi.tools(server.name).then((listed) => {
      setOffered(listed);
      setChosen(firstPick(listed, server.tools));
    }, () => undefined);
  }, [reached]);
  const group = (legend: string, list: typeof tools) =>
    list.length ? (
      <fieldset className="teams">
        <legend>{legend}</legend>
        {list.map((t) => <label key={t.name} className="check" title={t.description || undefined}><input type="checkbox" checked={chosen.includes(t.name)} onChange={() => toggle(t.name)} />{t.name}</label>)}
      </fieldset>
    ) : null;
  const chosenWrites = server.transport === "http" ? chosen.filter(writes) : server.writing;
  return (
    <li className="panel my-server">
      <div className="card-head">
        <h4>{server.name}</h4>
        <span className={`badge ${server.credential?.set || server.auth === "none" ? "ok" : "warn"}`}>{credentialText(server)}</span>
      </div>
      {server.description ? <p>{server.description}</p> : null}
      <p className="mono small-print">{server.transport === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ")}</p>
      <p className="small-print">{server.tools.length ? `Tasks may use: ${server.tools.join(", ")}` : "No tool is allowed yet, so tasks do not get this server."}</p>
      {server.transport === "http" ? (
        tools.length ? (
          <>
            {group("Reads", groupTools(tools).reads)}
            {group("Writes", groupTools(tools).writes)}
          </>
        ) : <p className="muted">Load the server's tools to pick from them.</p>
      ) : (
        <label className="filter">Tools a task may use, separated by commas<input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} /></label>
      )}
      {offered && !server.tools.length ? <p role="status">Only tools that read are ticked; tick any other yourself. Save tools to let the tasks you start use {server.name}.</p> : null}
      {chosenWrites.length ? (
        <p className="warning" role="note">This lets a task change things in {server.name} as you: {chosenWrites.join(", ")}. What such a tool changes is not a request anyone reviews.</p>
      ) : null}
      <div className="row-actions">
        {server.auth === "oauth" ? (
          server.credential?.set
            ? (
              <ConfirmAction
                small
                trigger="Disconnect"
                triggerLabel={`Disconnect ${server.name}`}
                consequence={`Tasks you start stop getting ${server.name} until you connect it again, and its sign-in is deleted.`}
                confirm={`Disconnect ${server.name}`}
                keep="Stay connected"
                onConfirm={() => myMcpApi.disconnect(server.name).then(() => done(`${server.name} is disconnected.`))}
              />
            )
            : <button type="button" className="small" disabled={busy || !signIn} onClick={connect}>Connect</button>
        ) : null}
        {server.transport === "http" ? <button type="button" className="secondary small" disabled={busy} onClick={load}>Load tools</button> : null}
        <button type="button" className="small" disabled={busy} onClick={() => run(() => myMcpApi.update(server.name, { tools: server.transport === "http" ? chosen : typed.split(",").map((t) => t.trim()).filter(Boolean) }), `Saved the tools tasks may use of ${server.name}.`)}>Save tools</button>
        <ConfirmAction
          small
          trigger="Remove"
          triggerLabel={`Remove ${server.name}`}
          consequence={`This cannot be undone. Tasks you start stop getting ${server.name}, and its sign-in or token and the tools you picked are deleted.`}
          confirm={`Remove ${server.name}`}
          keep={`Keep ${server.name}`}
          onConfirm={() => myMcpApi.remove(server.name).then(() => done(`${server.name} and its sign-in are removed.`))}
        />
      </div>
    </li>
  );
}
