import { useId, useState } from "react";
import type { FormEvent } from "react";
import { FORGES as FORGE_DEFS, isHostedForge } from "../../shared/forge-def";
import { api } from "./api";
import type { RepoRecord } from "./api";
import { useForgeConnections } from "./forge-connection";
import { Hint } from "./Hint";
import { Select } from "./Select";

export type ConnectForge = "gitlab" | "github" | "path";

const PERSONAL_TEAM = "Personal";

/** A full path as it reads on the machine the browser is on; the orchestrator takes no ~ or relative path. */
function homeExample(): string {
  return /mac/i.test(navigator.platform) ? "/Users/you/code/<repository>" : "/home/you/code/<repository>";
}

const FORGES: { id: ConnectForge; label: string; example: string }[] = [
  { id: "gitlab", label: "GitLab", example: "https://gitlab.com/<group>/<project>.git" },
  { id: "github", label: "GitHub", example: "https://github.com/<owner>/<repository>.git" },
  { id: "path", label: "A path on the server", example: "/srv/repositories/<repository>" },
];

/** The project path an address names, as the server takes it when no project is entered: right for a forge at the root of its host. */
function projectOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url.trim()).pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  } catch {
    return "";
  }
}

/**
 * An owner or an admin connecting a team repository. The orchestrator reads it before it answers,
 * so a repository it cannot read is not listed; the token is sealed and never shown again.
 */
/**
 * `ownCli`: the orchestrator runs on the person's own machine, so their gh or glab sign-in reaches
 * the forge when no token is given and any repository on that machine can be read by its path.
 * `paths`: a team's orchestrator reads a path only under the folder ORCHESTRATOR_LOCAL_REPOS_ROOT
 * names on its server, so the path is offered only where that folder is set.
 * `titled`: false where the page around the form already names the step. `onCancel` puts Cancel
 * beside the one filled action, as every form's action line has it.
 *
 * The form keeps its own measure on the left; what each field means is read in the rail beside it,
 * so the form holds fields and the action line alone.
 */
export function ConnectRepo({ repos, forge: preset, onConnected, onCancel, ownCli = false, paths = true, titled = true }: { repos: RepoRecord[]; forge?: ConnectForge; onConnected: (repo: RepoRecord) => void; onCancel?: () => void; ownCli?: boolean; paths?: boolean; titled?: boolean }) {
  // A repository on this machine is the one most people connect first to their own orchestrator.
  const [forge, setForge] = useState<ConnectForge>(preset ?? (ownCli ? "path" : "gitlab"));
  const [url, setUrl] = useState("");
  const [project, setProject] = useState("");
  const [choosingProject, setChoosingProject] = useState(false);
  const teams = [...new Set(repos.map((r) => r.team))].sort();
  // Only the address is asked: the name, the kind and the team are worked out, and changed later in the project's Settings.
  const [team, setTeam] = useState(teams[0] ?? PERSONAL_TEAM);
  const [choosingTeam, setChoosingTeam] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const tokenId = useId();
  const [connections] = useForgeConnections(!ownCli);
  const onForge = forge !== "path";
  // The organization's own connection to the forge reads and writes for it; a token is asked only without one.
  const tokenNeeded = onForge && !(isHostedForge(forge) && connections?.[forge]?.connection);
  const derived = projectOf(url);
  const described = error ? { "aria-describedby": errorId } : {};
  // One person's own orchestrator opens a folder on this machine; a team's adds a project from wherever it lives.
  const action = ownCli ? "Open a folder" : "Add a repository";
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api.connectRepo({ forge, url: url.trim(), team: ownCli ? teams[0] ?? PERSONAL_TEAM : team, ...(onForge && project.trim() ? { project: project.trim() } : {}), ...(onForge && token.trim() ? { token: token.trim() } : onForge && !ownCli ? { token: "" } : {}) }).then(
      (repo) => {
        setBusy(false);
        setUrl("");
        setProject("");
        setToken("");
        onConnected(repo);
      },
      (err: Error) => {
        setBusy(false);
        setError(err.message);
        // An address that names no project the forge knows is put right in the field it came from.
        if (onForge) setChoosingProject(true);
      },
    );
  };
  const where = onForge
    ? `The address its Clone button shows under HTTPS, read ${tokenNeeded ? "with the token" : `through the organization's ${FORGES.find((f) => f.id === forge)!.label} connection`} before it is listed; its name and team are changed later in its Settings.`
    : ownCli
      ? "Any Git repository on this machine, by its full path; its name is changed later in its Settings."
      : "The orchestrator reads a path only under the folder ORCHESTRATOR_LOCAL_REPOS_ROOT names where it runs.";
  return (
    <div className="with-rail">
      <form className="form" onSubmit={submit} {...(titled ? { "aria-labelledby": "connect-h" } : { "aria-label": action })}>
        {titled ? <h2 id="connect-h">{action}</h2> : null}
        <fieldset>
          <legend>Where it is</legend>
          {FORGES.filter((f) => f.id !== "path" || ownCli || paths).map((f) => (
            <label key={f.id} className="check"><input type="radio" name="forge" value={f.id} checked={forge === f.id} onChange={() => setForge(f.id)} /> {f.id === "path" && ownCli ? "A path on this machine" : f.label}</label>
          ))}
        </fieldset>
        <label>{onForge ? "Clone address (https)" : "Full path"}<input className={onForge ? undefined : "mono"} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={ownCli && forge === "path" ? homeExample() : FORGES.find((f) => f.id === forge)!.example} required autoComplete="off" spellCheck={false} {...described} /></label>
        {onForge && (choosingProject || (url.trim() && !derived)) ? (
          <label>Project<input value={project} onChange={(e) => setProject(e.target.value)} placeholder={derived || (isHostedForge(forge) ? FORGE_DEFS[forge].projectShape : undefined)} maxLength={200} autoComplete="off" spellCheck={false} {...described} /></label>
        ) : onForge && derived ? (
          <p className="muted small">Project <span className="mono">{derived}</span> <button type="button" className="link" onClick={() => setChoosingProject(true)}>Change project</button></p>
        ) : null}
        {ownCli || teams.length < 2 ? null : choosingTeam ? (
          <Select label="Team" value={team} onChange={setTeam} describedBy={described["aria-describedby"]} options={teams.map((t) => ({ value: t, label: t }))} />
        ) : (
          <p className="muted small">Team {team} <button type="button" className="link" onClick={() => setChoosingTeam(true)}>Change team</button></p>
        )}
        {tokenNeeded ? (
          // The hint sits beside the field's name, outside the label, so the label still names the field alone.
          <div className="field">
            <span className="field-name">
              <label htmlFor={tokenId}>Token{ownCli ? " (optional)" : ""}</label>
              <Hint label="how it is kept">{ownCli ? "Left empty, your own gh or glab sign-in is used. " : ""}It is sealed when you connect, not shown again, and sent only to this address's host.</Hint>
            </span>
            <input id={tokenId} type="password" value={token} onChange={(e) => setToken(e.target.value)} required={!ownCli} autoComplete="off" {...described} />
          </div>
        ) : null}
        {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
        <div className="actions">
          <button type="submit" disabled={busy}>{busy ? (ownCli ? "Reading the folder…" : "Reading the repository…") : ownCli ? "Open folder" : "Add repository"}</button>
          {onCancel ? <button type="button" className="secondary" onClick={onCancel}>Cancel</button> : null}
        </div>
      </form>
      <aside className="rail" aria-label={`About ${ownCli ? "the folder" : "the project"}`}>
        <section>
          <h2>{onForge ? "The address" : "The path"}</h2>
          <p>{where}</p>
        </section>
      </aside>
    </div>
  );
}
