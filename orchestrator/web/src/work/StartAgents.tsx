import { useEffect, useState } from "react";
import { ApiError, tasksApi } from "../api";
import type { AgentChoices, SkillSuggestions, TaskOptions, TaskRecord, TaskTargets } from "../api";
import { MOST_SKILLS } from "../api";
import { here } from "../router";
import { Select } from "../Select";
import { AgentChoicesPicker, chosen as picked } from "../AgentChoices";
import { NextStep } from "../NextStep";
import { SkillChips } from "../SkillChips";
import { Loading, LoadFailed } from "../Status";
import type { WorkItem } from "./api";

/** As many as the orchestrator starts in one go. */
export const MOST_AT_ONCE = 20;

type Outcome = { key: string; task: TaskRecord } | { key: string; error: string; code?: string };

/**
 * One agent per picked issue, all started together: each issue becomes its own task with the
 * issue as its link, and each is checked on its own, so a refused one leaves the rest running.
 */
export function StartAgents({ items, local = false, onStarted, onCancel }: { items: WorkItem[]; local?: boolean; onStarted: () => void; onCancel: () => void }) {
  const skillsWord = local ? "every skill" : "every team skill";
  const [options, setOptions] = useState<TaskOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [choices, setChoices] = useState<AgentChoices>({});
  const [spread, setSpread] = useState<"orchestrator" | "chosen">("orchestrator");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [suggested, setSuggested] = useState<Record<string, SkillSuggestions | { error: string }> | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const read = () => {
    setError(null);
    tasksApi.options().then((o) => {
      const code = o.repos.filter((r) => r.kind === "code");
      setOptions(o);
      setAgent(o.agents[0]?.id ?? "");
      setRepo((code[0] ?? o.repos[0])?.id ?? "");
      setSpread(o.multiRepo ? "orchestrator" : "chosen");
    }, (e: Error) => setError(e.message));
  };
  useEffect(read, []);
  const code = options?.repos.filter((r) => r.kind === "code") ?? [];
  const letAgentPick = Boolean(options?.multiRepo) && spread === "orchestrator";
  const repoId = letAgentPick ? code[0]?.id ?? "" : repo;
  const targets: TaskTargets | undefined = letAgentPick ? "orchestrator" : undefined;
  // One ask for every picked issue, made again when the agent or the repositories change, since
  // the skills on offer are those of the repositories the work runs in.
  // Skills are not suggested where the folder is not known before the start.
  useEffect(() => {
    if (local || !options || !agent || !repoId) return;
    let current = true;
    setSuggested(null);
    setSuggestError(null);
    const timer = setTimeout(() => {
      tasksApi.suggestSkillsFor({ agent, items: items.map((item) => ({ repoId, issueUrl: item.url, ...(targets ? { targets } : {}) })) }).then((r) => {
        if (!current) return;
        const byKey: Record<string, SkillSuggestions | { error: string }> = {};
        const picks: Record<string, string[]> = {};
        for (const one of r.results) {
          const key = items[one.index]!.key;
          byKey[key] = one;
          if ("suggestions" in one) picks[key] = one.suggestions.map((s) => s.skill).slice(0, MOST_SKILLS);
        }
        setSuggested(byKey);
        setChosen(picks);
      }, (e: Error) => current && setSuggestError(e.message));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [options, agent, repoId, spread]);

  const panel = (body: React.ReactNode) => (
    <section className="panel start-agents" aria-labelledby="start-agents-h">
      <h2 id="start-agents-h">Start agents <span className="count">{items.length} {items.length === 1 ? "issue" : "issues"}</span></h2>
      {body}
    </section>
  );
  if (error) return panel(<LoadFailed what="the task options" reason={error} onRetry={read} />);
  if (!options) return panel(<Loading what="the task options" />);
  if (outcomes) {
    const started = outcomes.filter((o) => "task" in o).length;
    return panel(
      <>
        <p role="status">{started === outcomes.length ? `${started} ${started === 1 ? "agent" : "agents"} started.` : `${started} of ${outcomes.length} agents started.`} {outcomes.length === 1 ? "Its card shows where it stands." : "Their cards show where each stands."}</p>
        <ul className="plain outcomes">
          {outcomes.map((o) => (
            <li key={o.key}>
              <span className="mono">{o.key}</span>{" "}
              {"task" in o ? <a href={here("tasks", o.task.id)}>started</a> : <span className="error">not started: {o.error}</span>}
              {"error" in o ? <NextStep code={o.code} /> : null}
            </li>
          ))}
        </ul>
        <button type="button" className="secondary" onClick={onCancel}>Done picking</button>
      </>,
    );
  }
  const repos = code.length ? code : options.repos;
  if (!local && !repos.length) return panel(<p>No repository is connected for agents to work in yet. <a href={here("repositories")}>Connect a repository</a></p>);
  if (!options.agents.length) return panel(<p>No agent is set up on this orchestrator yet. <a href={here("settings", "agents")}>See Agent readiness</a></p>);
  // One person's own orchestrator picks each issue's folder as the Tasks box does: every issue is started the way that box starts one.
  const startEach = async () => {
    const results: Outcome[] = [];
    for (const item of items) {
      try {
        const task = await tasksApi.start({ title: item.summary, description: "", issueUrl: item.url, agent, template: null, ...(picked(choices) ? { choices: picked(choices) } : {}) });
        results.push({ key: item.key, task });
      } catch (err) {
        results.push({ key: item.key, error: (err as Error).message, ...(err instanceof ApiError ? { code: err.code } : {}) });
      }
    }
    setOutcomes(results);
    onStarted();
  };
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    if (local) {
      void startEach().finally(() => setBusy(false));
      return;
    }
    tasksApi
      .startMany({ agent, items: items.map((item) => ({ issueUrl: item.url, repoId, ...(targets ? { targets } : {}), ...(chosen[item.key]?.length ? { skills: chosen[item.key] } : {}), ...(picked(choices) ? { choices: picked(choices) } : {}) })) })
      .then(({ started, refused }) => {
        // The tasks come back in the order of the issues that were not refused.
        const queue = [...started];
        setOutcomes(items.map((item, index) => {
          const no = refused.find((r) => r.index === index);
          return no ? { key: item.key, error: no.error, code: no.code } : { key: item.key, task: queue.shift()! };
        }));
        onStarted();
      }, (err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return panel(
    <form className="form" aria-label="Start agents" onSubmit={start}>
      <ul className="plain picked">
        {items.map((item) => {
          const read = suggested?.[item.key];
          return (
            <li key={item.key} className="picked-issue" aria-label={`${item.key} ${item.summary}`}>
              <p><span className="mono">{item.key}</span> {item.summary}</p>
              {local || suggestError ? null : !suggested ? <p className="muted small">Asking the agent which skills fit…</p>
                : !read ? null
                  : "error" in read ? <p className="muted small">No suggestion: {read.error} The agent still has {skillsWord}.</p>
                    : <SkillChips label="Skills to use first" read={read} value={chosen[item.key] ?? []} onChange={(next) => setChosen({ ...chosen, [item.key]: next })} local={local} />}
            </li>
          );
        })}
      </ul>
      {!local && suggestError ? <p className="muted small">The agent did not suggest skills: {suggestError} Each agent still has {skillsWord}.</p> : null}
      {!local && options.multiRepo ? (
        <fieldset className="teams">
          <legend>Repositories</legend>
          <label className="check"><input type="radio" name="spread" checked={spread === "orchestrator"} onChange={() => setSpread("orchestrator")} />Let each agent find the repositories its issue changes (recommended)</label>
          <label className="check"><input type="radio" name="spread" checked={spread === "chosen"} onChange={() => setSpread("chosen")} />Work in one repository</label>
        </fieldset>
      ) : null}
      {!local && !letAgentPick ? <Select label="Repository" value={repo} onChange={setRepo} options={repos.map((r) => ({ value: r.id, label: r.name, ...(local ? {} : { hint: r.team }) }))} /> : null}
      {options.agents.length > 1 ? <Select label="Agent" value={agent} onChange={(v) => { setAgent(v); setChoices({}); }} options={options.agents.map((a) => ({ value: a.id, label: a.label }))} /> : null}
      <AgentChoicesPicker options={options.agents.find((a) => a.id === agent)?.options} value={choices} onChange={setChoices} />
      <p className="muted">{local ? "Each agent works in the folder picked from its issue; you review every change before you keep it." : "Each agent opens its own request for review; nothing merges on its own."}</p>
      <div className="actions">
        <button type="submit" disabled={busy || (!local && !repoId) || !agent}>{items.length === 1 ? "Start 1 agent" : `Start ${items.length} agents`}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>,
  );
}
