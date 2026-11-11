import { useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { api, manages, people } from "./api";
import type { ActivitySummary, Onboarding, Principal, RepoRecord, SentInvite, TeamView } from "./api";
import { cloudSteps } from "./setup-steps";
import type { Step } from "./setup-steps";
import { ConnectComputer } from "./ConnectComputer";
import { connectedForge, useForgeConnections } from "./forge-connection";
import type { ForgeConnections } from "./forge-connection";
import { FirstTask } from "./projects/FirstTask";
import { FolderPicker } from "./projects/FolderPicker";
import type { PickerPlace } from "./projects/FolderPicker";
import { projectsRead } from "./projects-read";
import type { Project } from "./projects-read";
import { navigate, pathIn, useLocation } from "./router";
import type { Machine } from "./machines/api";
import { InviteForm, SentLinks } from "./settings/Members";
import { Loading, LoadFailed } from "./Status";
import type { SkippedStep } from "../../shared/activity";
import { ForgeStep, RepoStep } from "./WelcomeForge";
import { PROMISE, PROMISE_CONNECTED } from "./words";
import { PageHead } from "./design/PageHead";
import { Hint } from "./Hint";
import "./welcome.css";

/** The welcome walks the steps that set an organization up; what is left of them waits on Team. */
const WELCOME: readonly SkippedStep[] = ["forge", "repo", "members", "start"];

/**
 * Whether the step's own body holds its main action: a form to send or a link to follow. Then
 * Continue steps back to secondary, so one filled button stands on the screen.
 */
function leadsInBody(step: Step): boolean {
  return ["repo", "members", "start"].includes(step.id) || (step.id === "forge" && !step.done);
}

function StepBody({ step, me, org, repos, forges, problem, onChanged }: { step: Step; me: Principal; org: string; repos: RepoRecord[]; forges: ForgeConnections; problem: string | null; onChanged: () => void }) {
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [sent, setSent] = useState<{ invited: SentInvite[]; skipped: { email: string; reason: string }[] } | null>(null);
  useEffect(() => {
    if (step.id === "members") people.teams().then(setTeams, () => setTeams([]));
  }, [step.id]);
  if (step.id === "forge") return <ForgeStep forges={forges} repos={repos} problem={problem} owner={me.role === "owner"} paths={me.pathRepos !== false} onChanged={onChanged} />;
  if (step.id === "repo") return <RepoStep forges={forges} repos={repos} paths={me.pathRepos !== false} onChanged={onChanged} />;
  if (step.id === "members") {
    return (
      <>
        <InviteForm me={me} teams={teams} onSent={(invited, skipped) => { setSent({ invited, skipped }); onChanged(); }} />
        {sent ? <SentLinks sent={sent.invited} skipped={sent.skipped} /> : null}
      </>
    );
  }
  if (step.id === "start") {
    return (
      <div className="actions">
        <a className="button" href={pathIn(org, "work")}>Open Work</a>
        <a className="button secondary" href={`${pathIn(org, "integrations")}?open=jira`}>Connect Jira</a>
      </div>
    );
  }
  return null;
}

/**
 * The first screen: what the orchestrator does, then the two decisions before an agent works, a
 * folder and the work. Where tasks run on people's own machines the folders are those of the
 * computer the person connects first, with one command. A person who opened a project before
 * finds it picked, the task box open.
 */
function FirstScreen({ org, onRepos, computer = false }: { org: string; onRepos: () => Promise<unknown>; computer?: boolean }) {
  const [machine, setMachine] = useState<Machine | null>(null);
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [home, setHome] = useState<string | null>(null);
  const [place, setPlace] = useState<PickerPlace | null>(null);
  useEffect(() => {
    // Only a head start: when the list does not answer, the picker comes up as for anyone new.
    projectsRead.list().then(({ projects, last, home: listed }) => {
      setProject(projects.find((p) => p.id === last) ?? null);
      setHome(listed ?? null);
    }, () => setProject(null));
  }, []);
  const opened = (picked: Project, from: string | null, at: PickerPlace) => {
    setProject(picked);
    setHome(from);
    setPlace(at);
    void onRepos();
  };
  return (
    <section className="first-screen" aria-labelledby="first-promise-h">
      <h1 id="first-promise-h" className="first-promise">{computer ? PROMISE_CONNECTED : PROMISE}</h1>
      {computer && !machine ? (
        <ConnectComputer onConnected={setMachine} />
      ) : project === undefined ? (
        <Loading what="where your code lives" />
      ) : project ? (
        <FirstTask project={project} home={home} onChange={() => setProject(null)} onStarted={(taskId) => navigate(pathIn(org, "tasks", taskId))} {...(machine ? { machine: machine.id } : {})} />
      ) : (
        <>
          {machine ? <p className="muted" role="status">{machine.name} is connected; pick a folder on it.</p> : null}
          <FolderPicker onOpened={opened} lead={<CodeLives />} {...(machine ? { machine: machine.id, where: `On ${machine.name}` } : {})} {...(place ? { from: place } : {})} />
        </>
      )}
    </section>
  );
}

/** The one question the first screen asks. It names no Git, since a person whose folders have none reads this too. */
function CodeLives() {
  return (
    <div className="code-lives">
      <h2>Where your code lives</h2>
      <p className="muted">Pick the folder your code is in, even one that holds many.</p>
    </div>
  );
}

/**
 * `onFinished` is for a page that shows the welcome in place of its own content, as Tasks does
 * with nothing to list yet: the steps' last button hands the page back instead of reloading it.
 */
export function WelcomeView({ me, org, repos, onRepos, onFinished }: { me: Principal; org: string; repos: RepoRecord[]; onRepos: () => Promise<unknown>; onFinished?: () => void }) {
  const asked = new URLSearchParams(useLocation().search);
  if (me.mode === "local") return <FirstScreen org={org} onRepos={onRepos} />;
  // An owner setting the organization up, sent here for one step or back from the forge's sign-in,
  // gets that step; everyone else's first screen is their own computer.
  const settingUp = manages(me) && ["step", "forge_connected", "forge_problem"].some((k) => asked.has(k));
  // Where the server runs tasks itself, or says nothing about it, nobody is asked for a computer.
  if (me.runners && me.tasksRunHere === false && !settingUp) return <FirstScreen org={org} onRepos={onRepos} computer />;
  return <OrgWelcome me={me} org={org} repos={repos} onRepos={onRepos} {...(onFinished ? { onFinished } : {})} />;
}

/**
 * A new team's first screen, on our cloud and on a server of its own alike: the steps that set it
 * up, one at a time. Each can be left for later, and what is done or left is the organization's,
 * so Team shows the same.
 */
function OrgWelcome({ me, org, repos, onRepos, onFinished }: { me: Principal; org: string; repos: RepoRecord[]; onRepos: () => Promise<unknown>; onFinished?: () => void }) {
  const [summary, setSummary] = useState<ActivitySummary | null>(null);
  const [onboarding, setOnboarding] = useState<Onboarding | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const location = useLocation();
  // The forge brings the browser back here with what happened; a problem is shown on the forge step.
  const problem = new URLSearchParams(location.search).get("forge_problem");
  const [forges, readForges] = useForgeConnections(manages(me));
  const read = () => {
    setError(null);
    Promise.all([api.summary(), api.onboarding()]).then(([s, o]) => {
      setSummary(s);
      setOnboarding(o);
    }, (e: Error) => setError(e.message));
  };
  useEffect(read, []);
  if (!manages(me)) {
    return (
      <div className="page">
        <PageHead title={`Welcome to ${org}`} summary={<>An owner or an admin sets the organization up; your first task starts on <a href={pathIn(org, "tasks")}>Tasks</a>.</>} />
      </div>
    );
  }
  if (error) return <LoadFailed what="the welcome steps" reason={error} onRetry={read} panel />;
  if (!summary || !onboarding || !forges) return <Loading what="the welcome steps" panel />;
  const firstRepo = repos.find((r) => r.configured !== false)?.id;
  const steps = cloudSteps(org, summary, firstRepo, connectedForge(forges) !== null).filter((s) => (WELCOME as readonly string[]).includes(s.id));
  const open = steps.findIndex((s) => !s.done && !onboarding.skipped.includes(s.id as SkippedStep));
  const named = steps.findIndex((s) => s.id === new URLSearchParams(location.search).get("step"));
  const at = current ?? (problem ? 0 : named !== -1 ? named : open === -1 ? steps.length : open);
  const step = steps[at];
  const changed = () => {
    read();
    readForges();
    void onRepos();
  };
  const skip = (id: SkippedStep) =>
    api.changeOnboarding({ skipped: [...onboarding.skipped.filter((s) => s !== id), id] }).then((o) => {
      setOnboarding(o);
      setCurrent(at + 1);
    }, (e: Error) => setError(e.message));
  const left = steps.filter((s) => !s.done);
  return (
    <div className="page welcome">
      <PageHead title={`Welcome to ${org}`} summary={<>{steps.length} steps set your organization up. <Hint label="the welcome steps">Any of them can wait; what is left stays under Getting set up on Team.</Hint></>} />
      <div className="welcome-layout">
        <nav aria-label="Welcome steps">
          <ol className="step-list nav">
            {steps.map((s, n) => (
              <li key={s.id}>
                <button type="button" className="step-item" aria-current={n === at ? "step" : undefined} onClick={() => setCurrent(n)}>
                  <span className={`step-mark ${s.done ? "done" : ""}`} aria-hidden="true">{s.done ? "✓" : n + 1}</span>
                  {s.title}
                  <span className="step-state">{s.done ? "done" : onboarding.skipped.includes(s.id as SkippedStep) ? "skipped" : ""}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>
        {step ? (
          <section className="panel welcome-step" aria-labelledby="welcome-step-h">
            <h2 id="welcome-step-h" aria-live="polite">{step.title} {step.done ? <span className="badge ok">done</span> : null}</h2>
            <p>{step.detail}</p>
            <StepBody key={step.id} step={step} me={me} org={org} repos={repos} forges={forges ?? { gitlab: null, github: null }} problem={problem} onChanged={changed} />
            <div className="actions">
              {at > 0 ? <button type="button" className="secondary" onClick={() => setCurrent(at - 1)}>Back to {steps[at - 1]!.title}</button> : null}
              {step.done ? (
                <button type="button" className={leadsInBody(step) ? "secondary" : undefined} onClick={() => setCurrent(at + 1)}>{steps[at + 1]?.title ?? "Finish"}</button>
              ) : (
                <button type="button" className="secondary" onClick={() => void skip(step.id as SkippedStep)}>Skip for now</button>
              )}
            </div>
          </section>
        ) : (
          <section className="panel welcome-step" aria-labelledby="welcome-done-h">
            <h2 id="welcome-done-h">You are set up</h2>
            {left.length ? (
              <>
                <p>These wait under Getting set up on <a href={pathIn(org, "team")}>Team</a> whenever you come back to them:</p>
                <ul className="plain">{left.map((s) => <li key={s.id}>{s.title}</li>)}</ul>
              </>
            ) : (
              <p>Every step is done.</p>
            )}
            <div className="actions">
              {/* Where tasks run on people's own computers, the next thing is the owner's own first task there. */}
              {me.runners && me.tasksRunHere === false ? (
                <a className="button" href={pathIn(org, "welcome")}>Start the first task</a>
              ) : (
                <a className="button" href={pathIn(org, "tasks")} {...(onFinished ? { onClick: (e: MouseEvent) => { e.preventDefault(); onFinished(); } } : {})}>Open Tasks</a>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
