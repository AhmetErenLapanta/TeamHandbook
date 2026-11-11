import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import "./controls.css";
import { api, call, people } from "../api";
import type { Principal, RepoRecord, TeamView, UserView } from "../api";
import { Hint } from "../Hint";
import { PageHead } from "../design/PageHead";
import { TurnSection } from "../design/TurnSection";
import { Loading, LoadFailed, RefreshFailed } from "../Status";
import { here, useLocation } from "../router";
import { manages, policiesApi, tagsApi } from "./api";
import type { PolicyList, TagCount } from "./api";
import { PolicyEditor } from "./Editor";
import type { EditorSources } from "./Editor";
import { offeredTemplates, policiesSentence, policySummary, savesAsRequest } from "./policy";
import { MANAGED_HOOKS } from "./Preview";
import type { Template, TemplateReach } from "./policy";
import type { Policy, PolicyDraft } from "./policy";

/** What this person can set: every team for an owner or an admin, the teams they own otherwise. */
function reachOf(me: Principal, data: Loaded): TemplateReach {
  return manages(me) ? { teams: data.teams.map((t) => t.team), everyone: true } : { teams: [...me.ownedTeams], everyone: false };
}

/** Someone who owns no team can save no policy: every one would be refused them. */
const setsPolicies = (me: Principal) => manages(me) || me.ownedTeams.length > 0;

/** `tags` is null for someone who does not see members' tags. */
interface Loaded { list: PolicyList; teams: TeamView[]; repos: RepoRecord[]; users: UserView[]; tags: TagCount[] | null }

function useControlsData(me: Principal): { data: Loaded | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    setError(null);
    // The member list is for admins; anyone else picks teams, which is all their rules take.
    const users = manages(me) ? people.users().catch(() => []) : Promise.resolve([]);
    const tags = manages(me) ? tagsApi.catalog().catch(() => null) : Promise.resolve(null);
    Promise.all([policiesApi.list(), people.teams(), api.repos(), users, tags]).then(
      ([list, teams, repos, users, tags]) => setData({ list, teams, repos, users, tags }),
      (e: Error) => setError(e.message),
    );
  };
  useEffect(reload, [me.id]);
  return { data, error, reload };
}

function Templates({ templates, reach, blank }: { templates: Template[]; reach: TemplateReach; blank?: ReactNode }) {
  const applyNow = templates.some((t) => !savesAsRequest(t.draft(reach)));
  return (
    <TurnSection
      name="Control templates"
      count={templates.length}
      why={<>Start from one; each opens as a draft{blank ? <>, or {blank}</> : null}. <Hint label="templates">{reach.everyone ? "Four templates cover" : "These templates cover"} what teams most often hold to a rule. A rule saved as a request reaches teammates once a reviewer merges it on the team repository{applyNow ? "; one that applies now holds this orchestrator's tasks from the moment it is saved" : ""}.{reach.everyone ? "" : ` Monthly task budgets and where tasks run are rules on this orchestrator's own tasks; an owner or admin sets these.`} {MANAGED_HOOKS}{reach.everyone ? <> <a href="/api/policies/export?download=1" download>Export the saved policies</a></> : null}</Hint></>}
      empty=""
    >
      <ul className="team-rows">
        {templates.map((t) => (
          <li key={t.id}>
            <a className="template" href={`${here("team", "policies", "new")}?template=${t.id}`}>
              <span className="template-name">{t.name}</span> <span className="muted">{t.description} {savesAsRequest(t.draft(reach)) ? "Saved as a request." : "Applies now."}</span>
            </a>
          </li>
        ))}
      </ul>
    </TurnSection>
  );
}

function PolicyRow({ policy, names }: { policy: Policy; names: (id: string) => string }) {
  const request = savesAsRequest(policy);
  return (
    <li className="policy-row">
      <div>
        <p className="policy-name"><a href={here("team", "policies", policy.id)}>{policy.name}</a></p>
        <p className="muted">{policySummary(policy, names)}</p>
      </div>
      <div className="policy-facts">
        <span className={`badge ${request ? "badge-request" : "badge-now"}`}>{request ? "Reaches teammates through the team file" : "Applies to orchestrator tasks"}</span>
        {policy.updatedBy ? <span className="muted small-print">Changed by {policy.updatedBy}{policy.updatedAt ? ` on ${policy.updatedAt.slice(0, 10)}` : ""}</span> : null}
      </div>
    </li>
  );
}

/**
 * The policies part of Team, for whoever sets them: the rules in force, a template to start one,
 * and the switch for every automation. A team file the orchestrator cannot read is said first.
 */
export function PoliciesSection({ me }: { me: Principal }) {
  const { data, error, reload } = useControlsData(me);
  if (!setsPolicies(me)) return null;
  if (error && !data) return <LoadFailed what="policies" reason={error} onRetry={reload} />;
  if (!data) return <Loading what="policies" />;
  const names = namesOf(data);
  const { policies, problems } = data.list;
  const add = <a href={here("team", "policies", "new")}>Add policy</a>;
  return (
    <>
      {problems.length ? (
        <section role="alert" aria-labelledby="policy-problems-h">
          <h2 id="policy-problems-h">Team files with policies the orchestrator cannot read</h2>
          <ul className="plain">{problems.map((p) => <li key={p.repoId}><strong>{names(p.repoId)}</strong>: {p.problem}</li>)}</ul>
        </section>
      ) : null}
      {policies.length ? <TurnSection name="Policies" count={policies.length} why={<>The rules the team is held to. <Hint label="policies">A rule that blocks skills, MCP servers or tools in teammates' Claude Code is saved as a request and reaches them once a reviewer merges it; a rule on the tasks this orchestrator runs applies at once.</Hint>{policies.length ? <> {add}</> : null}</>} empty={<>{policiesSentence(0)} Start from a template below, or {add}.</>}>
        <ul className="plain policy-rows">{policies.map((p) => <PolicyRow key={p.id} policy={p} names={names} />)}</ul>
      </TurnSection> : null}
      <Templates blank={policies.length ? undefined : add} templates={offeredTemplates(manages(me), me.ownedTeams.length > 0, me.mode === "local")} reach={reachOf(me, data)} />
      {manages(me) && me.mode !== "local" ? <AutomationsSwitch /> : null}
    </>
  );
}

/**
 * The organization's switch for every automation at once, beside its other rules. Off, no board
 * is read for them and nothing starts; the automations themselves are set up on Integrations.
 */
function AutomationsSwitch() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // An orchestrator that answers no automations has none to switch, so the panel stays away.
    call<{ enabled: boolean }>("GET", "/api/work/automations").then((r) => setEnabled(r.enabled), () => setEnabled(null));
  }, []);
  const turn = (next: boolean) => {
    setError(null);
    setEnabled(next);
    call<{ enabled: boolean }>("PUT", "/api/work/automations", { enabled: next }).then((r) => setEnabled(r.enabled), (e: Error) => {
      setEnabled(!next);
      setError(e.message);
    });
  };
  if (enabled === null) return null;
  return (
    <section className="panel" aria-labelledby="automations-h">
      <h2 id="automations-h">Automations</h2>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => turn(e.target.checked)} />
        Run automations
      </label>
      <p className="muted">{enabled === false ? "Every automation is off: changes on the tracker are logged and set nothing going." : "Tracker changes start the automations set up under Integrations; turning this off stops every one of them at once."} <a href={here("integrations")}>Manage automations</a></p>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

function WhoSetsPolicies({ then }: { then: ReactNode }) {
  return (
    <section className="panel" aria-labelledby="policies-who-h">
      <h2 id="policies-who-h">Who sets policies</h2>
      <p className="muted">Ask an owner, an admin or your team's owner for the rule your team needs; {then}</p>
    </section>
  );
}

function namesOf(data: Loaded): (id: string) => string {
  return (id) => data.repos.find((r) => r.id === id)?.name ?? data.users.find((u) => u.id === id)?.name ?? id;
}

function sourcesOf(data: Loaded): EditorSources {
  return {
    teams: data.teams.map((t) => ({ id: t.team, label: t.team })),
    members: data.users.map((u) => ({ id: u.id, label: `${u.name} (${u.email})` })),
    repos: data.repos.filter((r) => r.configured !== false).map((r) => ({ id: r.id, label: r.name })),
    tags: data.tags?.map((t) => ({ id: t.tag, label: `${t.tag} (${t.members.toLocaleString("en-US")} ${t.members === 1 ? "member" : "members"})` })) ?? null,
    orchestratorRulesStored: data.list.orchestratorRulesStored,
  };
}

const BLANK: PolicyDraft = { name: "", audience: { kind: "workspace" }, rules: [] };

/** A policy's own page: a new one, or one by its id. */
export function ControlsView({ me, page }: { me: Principal; page: string }) {
  const { data, error, reload } = useControlsData(me);
  const { search } = useLocation();
  const existing = page !== "new" ? data?.list.policies.find((p) => p.id === page) ?? null : null;
  const title = page === "new" ? "Add policy" : existing?.name ?? "Policy";
  let body;
  if (error && !data) {
    body = <LoadFailed what="policies" reason={error} onRetry={reload} panel />;
  } else if (!data) {
    body = <Loading what="policies" panel />;
  } else if (page !== "new" && !existing) {
    body = <div className="panel" role="alert"><p>No policy with this address. <a href={here("team")}>Back to policies</a></p></div>;
  } else if (!setsPolicies(me)) {
    // A viewer, or a member who owns no team, reads a policy and changes none: no editor whose Save the server refuses.
    body = (
      <>
        {existing ? <section className="panel" aria-labelledby="policy-read-h"><h2 id="policy-read-h">What it does</h2><p>{policySummary(existing, namesOf(data))}</p></section> : null}
        <WhoSetsPolicies then={<a href={here("team")}>back to the policies in force</a>} />
      </>
    );
  } else {
    const template = offeredTemplates(manages(me), me.ownedTeams.length > 0, me.mode === "local").find((t) => t.id === new URLSearchParams(search).get("template"));
    const initial = existing ?? template?.draft(reachOf(me, data)) ?? BLANK;
    body = <PolicyEditor key={`${page}:${template?.id ?? ""}`} me={me} initial={initial} existing={existing} sources={sourcesOf(data)} back={here("team")} repoName={namesOf(data)} />;
  }
  return (
    <div className="page">
      <PageHead title={title} crumb={<a href={here("team")}>Team</a>} />
      {error && data ? <RefreshFailed what="policies" reason={error} onRetry={reload} /> : null}
      {body}
    </div>
  );
}
