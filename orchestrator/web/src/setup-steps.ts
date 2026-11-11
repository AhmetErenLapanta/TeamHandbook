import { useEffect, useState } from "react";
import { tasksApi } from "./api";
import type { ActivitySummary, ForgeCard, IntegrationCard, RepoRecord, TaskOptions } from "./api";
import { pathIn } from "./router";

export interface Step { id: string; title: string; detail: string; required: boolean; done: boolean; to: string; action: string }

/**
 * A team's steps, on our cloud and on a server of the team's own alike: the welcome's four first
 * and then the request that proves the loop. The forge counts as connected through the
 * organization's one-click connection or, where the operator set no app up, through a repository
 * connected with a token.
 */
export function cloudSteps(org: string, summary: ActivitySummary, firstRepo: string | undefined, forgeConnected = false): Step[] {
  const here = (...parts: string[]) => pathIn(org, ...parts);
  const repoPage = firstRepo ? here("repositories", firstRepo) : here("repositories");
  const welcome = here("welcome");
  const { open, merged, closed } = summary.requests;
  return [
    {
      id: "forge", required: true, done: forgeConnected || summary.forges.connected > 0, to: `${welcome}?step=forge`, action: "Connect",
      title: "Connect GitLab or GitHub",
      detail: "So each change opens as a merge request or pull request where its reviewers see it, and the orchestrator can set up your team's repository there.",
    },
    {
      id: "repo", required: true, done: summary.repos > 0, to: `${welcome}?step=repo`, action: "Set up the repository",
      title: "Pick your team's skills repository",
      detail: "The repository your team's skills, MCP servers and commands live in, which teammates install in Claude Code.",
    },
    {
      id: "members", required: true, done: summary.members > 1, to: here("settings", "members"), action: "Invite your team",
      title: "Invite your team",
      detail: "Invite teammates by email and make each team's lead its owner.",
    },
    {
      id: "start", required: false, done: summary.tasks.total > 0 || summary.tracker, to: here("work"), action: "Open Work",
      title: "Start a task or connect Jira",
      detail: "Start from your sprint's issues on Work.",
    },
    {
      id: "propose", required: true, done: open + merged + closed > 0, to: repoPage, action: "Open a repository",
      title: "Propose your first change",
      detail: "Edit a skill, an MCP server or a command on a repository's page, and it opens as a request.",
    },
    {
      id: "merge", required: true, done: merged > 0, to: here("repositories", "requests"), action: "Open requests",
      title: "Merge your first request",
      detail: "A request reaches teammates once a reviewer merges it.",
    },
  ];
}

/**
 * One person's orchestrator on their own machine: no organization to set up and nobody to
 * invite, only a folder to open and a first task.
 */
/** Where one person's own gh or glab stands, from the Integrations page's GitHub and GitLab cards: the one signed in, else the one installed, else the first. */
export function ownForge(cards: IntegrationCard[]): { done: boolean; detail: string } {
  const forges = cards.filter((c): c is ForgeCard => c.id === "github" || c.id === "gitlab");
  const own = forges.flatMap((c) => (c.ownCli ? [c.ownCli] : []));
  const cli = own.find((o) => o.signedIn) ?? own.find((o) => o.installed) ?? own[0];
  const done = forges.some((c) => c.state === "connected" || c.ownCli?.signedIn === true);
  const detail = !cli
    ? "Sign in once with gh or glab on this machine; from a task's review you then open its change on GitHub or GitLab under your own name."
    : cli.signedIn ? (cli.account ? `Signed in as ${cli.account} with ${cli.tool}.` : `Signed in with ${cli.tool}.`) : cli.installed ? `Run ${cli.login} in a terminal on this machine.` : `Install ${cli.tool}, then run ${cli.login}.`;
  return { done, detail };
}

export function soloSteps(org: string, summary: ActivitySummary, repos: RepoRecord[], forge: { done: boolean; detail: string }, jiraSignedIn: boolean): Step[] {
  const welcome = pathIn(org, "welcome");
  return [
    {
      id: "repo", required: true, done: summary.repos > 0, to: welcome, action: "Pick the folder",
      title: "Where your code lives",
      detail: "Pick the folder your code lives in; it needs nothing set up first.",
    },
    {
      id: "task", required: true, done: summary.tasks.total > 0, to: welcome, action: "Start a task",
      title: "First task",
      detail: "Say what the agent should do there, then review every change it made before you keep it.",
    },
    {
      id: "team-skills", required: false, done: repos.some((r) => r.kind === "skills" && r.configured !== false), to: `${pathIn(org, "repositories")}?connect=path`, action: "Open their folder",
      title: "Add your team skills",
      detail: "Open the folder of the skills, MCP servers and commands your team shares; it is recognised as team skills on its own.",
    },
    {
      id: "forge", required: false, done: forge.done, to: `${pathIn(org, "integrations")}?open=github`, action: "Connect",
      title: "Connect GitHub or GitLab",
      detail: forge.detail,
    },
    {
      id: "tracker", required: false, done: summary.tracker || jiraSignedIn, to: `${pathIn(org, "integrations")}?open=jira`, action: "Connect Jira",
      title: "Connect Jira",
      detail: "Bring your Jira sprint onto Work; an agent takes an issue from there, and you review what it changed.",
    },
  ];
}

const CHECK_EVERY_MS = 3000;
const CHECKS = 10;

/**
 * The agents on this machine as the readiness check last found them, read only on one person's
 * orchestrator. The check runs in the background, so a first read can find it not done yet: then
 * it is read again every few seconds until it is, instead of calling a ready agent not ready.
 */
export function useAgents(enabled: boolean): [TaskOptions["agents"] | null, () => void] {
  const [agents, setAgents] = useState<TaskOptions["agents"] | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = (left: number) =>
      tasksApi.options().then(
        (o) => {
          if (!live) return;
          setAgents(o.agents);
          if (left > 0 && o.agents.length && o.agents.every((a) => !a.readiness)) timer = setTimeout(() => read(left - 1), CHECK_EVERY_MS);
        },
        () => live && setAgents([]),
      );
    void read(CHECKS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, round]);
  return [agents, () => { setAgents(null); setRound((n) => n + 1); }];
}
