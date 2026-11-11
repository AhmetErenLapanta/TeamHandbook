import { MODE_LABEL } from "../../../shared/permission-mode";
import type { PermissionMode } from "../../../shared/permission-mode";

export const AUDIENCE_KINDS = ["workspace", "teams", "members", "except-members", "tags", "except-tags", "service-accounts"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];
export type Audience = { kind: "workspace" } | { kind: Exclude<AudienceKind, "workspace">; ids: string[] };

export const DEVELOPER_KINDS = ["skill-access", "mcp-access", "tool-access"] as const;
export type DeveloperKind = (typeof DEVELOPER_KINDS)[number];

/** Rules that reach teammates' sessions through the team file. They only take away; granting goes through review. */
export type DeveloperRule = { kind: DeveloperKind; effect: "deny"; resources: string[]; reason: string };
/** Rules the orchestrator enforces itself, on the tasks it runs. */
export type OrchestratorRule =
  | { kind: "task-budget"; monthlyUsd: number | null; per: "audience" | "member" }
  | { kind: "repo-access"; effect: "allow" | "deny"; repos: string[] }
  | { kind: "task-mode"; ceiling: PermissionMode; repos: string[] }
  | { kind: "own-setup"; allowed: boolean; repos: string[] };
export type Rule = DeveloperRule | OrchestratorRule;
export type RuleKind = Rule["kind"];

export interface PolicyDraft { name: string; audience: Audience; rules: Rule[] }
export interface Policy extends PolicyDraft { id: string; updatedAt: string | null; updatedBy: string | null; repos?: string[] }

export const MAX_RULES = 20;
export const MAX_RESOURCES = 20;
export const NAME_MAX = 100;
export const REASON_MAX = 200;
export const MAX_MONTHLY_USD = 1_000_000;
/** The tools a tool rule names, as the team file's grammar takes them; Edit covers every tool that changes a file. */
export const TOOLS = ["Bash", "Read", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

export const isDeveloperKind = (kind: RuleKind): kind is DeveloperKind => (DEVELOPER_KINDS as readonly string[]).includes(kind);

/** "a", "a and b", "a, b and c". */
export function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const PREFIX: Record<DeveloperKind, string> = { "skill-access": "skill:", "mcp-access": "mcp:", "tool-access": "tool:" };

/** The team file's resource for what a person typed: `mcp:<server>`, `skill:<skill>`, `tool:<Tool>:<pattern>`. */
export function resourceOf(kind: DeveloperKind, value: string): string {
  return `${PREFIX[kind]}${value.trim()}`;
}

/** What a person reads for a resource: the name without its prefix, and a tool with what it is held to. */
export function resourceLabel(resource: string): string {
  const [kind, ...rest] = resource.split(":");
  if (kind === "tool") {
    const [tool, ...pattern] = rest;
    const held = pattern.join(":");
    return held === "*" || !held ? `${tool}` : `${tool} (${held})`;
  }
  if (kind === "mcp") {
    const [server, tool] = rest.join(":").split("/");
    return tool ? `${tool} on ${server}` : `${server}`;
  }
  return rest.join(":") || resource;
}

/** Who a policy applies to, as the start of a sentence. `names` turns an id into what people read. */
export function audienceText(audience: Audience, names: (id: string) => string = (id) => id): string {
  if (audience.kind === "workspace") return "Everyone in the organization";
  const shown = list(audience.ids.map(names));
  switch (audience.kind) {
    case "teams": return shown ? `Members of ${shown}` : "Members of the chosen teams";
    case "members": return shown || "The chosen members";
    case "except-members": return shown ? `Everyone except ${shown}` : "Everyone except the chosen members";
    case "tags": return shown ? `Members tagged ${shown}` : "Members with the chosen tags";
    case "except-tags": return shown ? `Everyone except members tagged ${shown}` : "Everyone except members with the chosen tags";
    case "service-accounts": return shown ? `The service ${plural(audience.ids.length, "account", "accounts")} ${shown}` : "The chosen service accounts";
  }
}

/** What one rule does, as the rest of the sentence. */
export function ruleText(rule: Rule): string {
  switch (rule.kind) {
    case "skill-access":
    case "mcp-access":
    case "tool-access": {
      const named = list(rule.resources.map(resourceLabel));
      if (rule.kind === "skill-access") return named ? `cannot use the ${plural(rule.resources.length, "skill", "skills")} ${named}` : "cannot use the chosen skills";
      if (rule.kind === "mcp-access") return named ? `cannot use the MCP ${plural(rule.resources.length, "server", "servers")} ${named}` : "cannot use the chosen MCP servers";
      return named ? `cannot use ${named} in Claude Code` : "cannot use the chosen tools in Claude Code";
    }
    case "task-budget": {
      const limit = rule.monthlyUsd === null ? "a monthly limit" : usd(rule.monthlyUsd);
      return rule.per === "member" ? `can each spend up to ${limit} a month on tasks` : `can spend up to ${limit} a month on tasks, together`;
    }
    case "repo-access": {
      const repos = list(rule.repos) || "the chosen repositories";
      return rule.effect === "allow" ? `can start tasks on ${repos}` : `cannot start tasks on ${repos}`;
    }
    case "task-mode": {
      const repos = rule.repos.includes("*") ? "every repository" : list(rule.repos) || "the chosen repositories";
      return `can run tasks on ${repos} in ${MODE_LABEL[rule.ceiling]} mode at most`;
    }
    case "own-setup": {
      const repos = rule.repos.includes("*") ? "every repository" : list(rule.repos) || "the chosen repositories";
      return rule.allowed ? `can run tasks on ${repos} with their own Claude Code setup` : `can run tasks on ${repos} only with their sign-in and the team's skills`;
    }
  }
}

/** The whole policy as one plain sentence, kept current while it is edited. */
export function policySummary(draft: PolicyDraft, names?: (id: string) => string): string {
  if (!draft.rules.length) return `${audienceText(draft.audience, names)}: add a rule to say what this policy does.`;
  return `${audienceText(draft.audience, names)} ${list(draft.rules.map(ruleText))}.`;
}

const AUDIENCE_NEEDS: Record<Exclude<AudienceKind, "workspace">, string> = {
  teams: "Choose teams",
  members: "Choose members",
  "except-members": "Choose the members to leave out",
  tags: "Choose tags",
  "except-tags": "Choose the tags to leave out",
  "service-accounts": "Choose service accounts",
};

const RESOURCE_NEEDS: Record<DeveloperKind, string> = {
  "skill-access": "Name the skills this rule blocks",
  "mcp-access": "Name the MCP servers this rule blocks",
  "tool-access": "Name the tools this rule blocks",
};

export const MIXED = "Rules that reach teammates' sessions are saved as a request and the orchestrator's own rules apply at once; put them in two policies.";
export const WHOLE_TEAMS = "Rules that reach teammates' sessions apply to whole teams: a teammate's machine does not say who is at it.";

/**
 * Why the rules and audience do not make a policy yet, or null once they do: the same checks
 * the server makes, said before it has to refuse. The preview needs this much; saving also needs a name.
 */
export function rulesProblem(draft: Pick<PolicyDraft, "audience" | "rules">): string | null {
  if (draft.audience.kind !== "workspace" && !draft.audience.ids.length) return `${AUDIENCE_NEEDS[draft.audience.kind]} to continue.`;
  if (!draft.rules.length) return "Add a rule to continue.";
  if (draft.rules.length > MAX_RULES) return `A policy holds at most ${MAX_RULES} rules; split it in two.`;
  for (const rule of draft.rules) {
    if (rule.kind === "task-budget") {
      if (rule.monthlyUsd === null || !Number.isFinite(rule.monthlyUsd)) return "Enter a monthly limit to continue.";
      if (rule.monthlyUsd <= 0 || rule.monthlyUsd > MAX_MONTHLY_USD) return `Enter a monthly limit above $0 and at most ${usd(MAX_MONTHLY_USD)}.`;
    } else if (rule.kind === "repo-access" || rule.kind === "task-mode" || rule.kind === "own-setup") {
      if (!rule.repos.length) return "Choose repositories to continue.";
    } else {
      if (!rule.resources.length) return `${RESOURCE_NEEDS[rule.kind]} to continue.`;
      if (rule.resources.length > MAX_RESOURCES) return `A rule names at most ${MAX_RESOURCES} entries; add another rule for the rest.`;
      if (!rule.reason.trim()) return "Say why this is blocked; teammates read it when a call is stopped.";
      if (rule.reason.length > REASON_MAX) return `Keep the reason to ${REASON_MAX} characters.`;
    }
  }
  const developer = draft.rules.filter((r) => isDeveloperKind(r.kind)).length;
  if (developer && developer < draft.rules.length) return MIXED;
  if (developer && draft.audience.kind !== "workspace" && draft.audience.kind !== "teams") return WHOLE_TEAMS;
  return null;
}

/** Why the policy cannot be saved yet, or null once it can. Saving stays locked until then. */
export function lockedReason(draft: PolicyDraft): string | null {
  const name = draft.name.trim();
  if (!name) return "Name the policy to continue.";
  if (name.length > NAME_MAX) return `Keep the name to ${NAME_MAX} characters.`;
  return rulesProblem(draft);
}

/** True when saving opens a request: its rules reach teammates' machines, which only a merge may change. */
export function savesAsRequest(draft: Pick<PolicyDraft, "rules">): boolean {
  return draft.rules.some((r) => isDeveloperKind(r.kind));
}

export function saveNote(draft: Pick<PolicyDraft, "rules">): string {
  return savesAsRequest(draft)
    ? "Saved as a request; teammates get it once it is merged."
    : "Applies now to the tasks this orchestrator runs, and is recorded in the audit log.";
}

/** What deleting an orchestrator policy does at once, said before it is deleted: the limits it held stop holding. */
export function deleteConsequence(policy: Pick<PolicyDraft, "rules">): string {
  const lifted = policy.rules.flatMap((r) => {
    if (r.kind === "task-budget") return [`tasks stop counting against its ${r.monthlyUsd === null ? "monthly" : `${usd(r.monthlyUsd)} monthly`} budget`];
    if (r.kind === "repo-access") return [`its rules on where tasks start stop holding`];
    if (r.kind === "task-mode") return [`its ceiling on how much agents do without asking stops holding`];
    if (r.kind === "own-setup" && !r.allowed) return [`tasks use their starter's own Claude Code setup again`];
    return [];
  });
  return `Deleting it applies at once: ${list([...new Set(lifted)]) || "its rules stop holding"}. The deletion is recorded in the audit log.`;
}

export interface BlockContext { rules: Rule[]; isAdmin: boolean; orchestratorRulesStored: boolean }

/** Why a rule block cannot be added to this policy, or null when it can. */
export function blockRefusal(kind: RuleKind, ctx: BlockContext): string | null {
  if (ctx.rules.length >= MAX_RULES) return `A policy holds at most ${MAX_RULES} rules.`;
  const developer = isDeveloperKind(kind);
  if (ctx.rules.some((r) => isDeveloperKind(r.kind) !== developer)) {
    return developer ? "This policy holds the orchestrator's own rules; block things on teammates' machines in a policy of its own." : "This policy reaches teammates' machines; orchestrator rules go in a policy of their own.";
  }
  if (!developer && !ctx.isAdmin) return "Only an admin sets the orchestrator's own rules.";
  if (!developer && !ctx.orchestratorRulesStored) return "This orchestrator's database does not keep its own rules yet. Ask whoever runs the orchestrator to update it to the latest release.";
  return null;
}

/** Why an audience does not fit the rules already in the policy, or null when it does. */
export function audienceRefusal(kind: AudienceKind, rules: Rule[]): string | null {
  return savesAsRequest({ rules }) && kind !== "workspace" && kind !== "teams" ? WHOLE_TEAMS : null;
}

export function emptyRule(kind: RuleKind): Rule {
  if (kind === "task-budget") return { kind, monthlyUsd: null, per: "audience" };
  if (kind === "repo-access") return { kind, effect: "allow", repos: [] };
  if (kind === "task-mode") return { kind, ceiling: "auto", repos: ["*"] };
  if (kind === "own-setup") return { kind, allowed: false, repos: ["*"] };
  return { kind, effect: "deny", resources: [], reason: "" };
}

export const RULE_BLOCKS: { kind: RuleKind; label: string; hint: string }[] = [
  { kind: "skill-access", label: "Skills", hint: "Block skills in teammates' sessions" },
  { kind: "mcp-access", label: "MCP servers", hint: "Retire or block MCP servers" },
  { kind: "tool-access", label: "Tools", hint: "Block Claude Code tools and commands" },
  { kind: "task-budget", label: "Task budget", hint: "Cap what agent tasks spend each month" },
  { kind: "repo-access", label: "Repository access", hint: "Choose where tasks may run" },
  { kind: "task-mode", label: "Permission ceiling", hint: "Cap how much agents do without asking" },
  { kind: "own-setup", label: "Starter's own setup", hint: "Choose whether tasks bring the starter's Claude Code setup" },
];

/**
 * Whom a template opens for: the teams it starts with, and whether the whole organization is
 * the person's to hold. A team's owner holds only the teams they own, so a template that would
 * reach everyone starts with those teams instead.
 */
export interface TemplateReach { teams: string[]; everyone: boolean }

export interface Template { id: string; name: string; description: string; draft: (reach: TemplateReach) => PolicyDraft }

export const TEMPLATES: Template[] = [
  {
    id: "retire-mcp",
    name: "Retire an MCP server",
    description: "Stop everyone using a server the team replaced.",
    draft: (reach) => ({ name: "Retire an MCP server", audience: reach.everyone ? { kind: "workspace" } : { kind: "teams", ids: [...reach.teams] }, rules: [{ kind: "mcp-access", effect: "deny", resources: [], reason: "This server is retired; the team uses its replacement." }] }),
  },
  {
    id: "read-only-bash",
    name: "Read-only Bash for a team",
    description: "A team keeps Bash for reading; commands that change files or history are blocked.",
    draft: (reach) => ({
      name: "Read-only Bash",
      audience: { kind: "teams", ids: reach.everyone ? [] : [...reach.teams] },
      rules: [{ kind: "tool-access", effect: "deny", resources: ["rm *", "mv *", "git commit *", "git reset *"].map((p) => resourceOf("tool-access", `Bash:${p}`)), reason: "This team uses Bash to read; changes go through a teammate." }],
    }),
  },
  {
    id: "team-task-budget",
    name: "Monthly task budget per team",
    description: "Cap what agent tasks for a team spend in a month.",
    draft: () => ({ name: "Monthly task budget", audience: { kind: "teams", ids: [] }, rules: [{ kind: "task-budget", monthlyUsd: null, per: "audience" }] }),
  },
  {
    id: "skill-one-team",
    name: "Keep a skill to one team",
    description: "Block a skill for every team listed; take the team that keeps it off the list.",
    draft: (reach) => ({ name: "Keep a skill to one team", audience: { kind: "teams", ids: [...reach.teams] }, rules: [{ kind: "skill-access", effect: "deny", resources: [], reason: "This skill belongs to another team's work." }] }),
  },
];

/**
 * The templates a person can finish and save: every one for an owner or an admin, the ones that
 * reach teammates for a team's owner, and none for someone who owns no team, since every policy
 * would be refused them.
 */
export function offeredTemplates(managing: boolean, ownsTeams: boolean, personal = false): Template[] {
  // One person's own orchestrator has no teammates whose Claude Code a rule reaches.
  if (personal) {
    if (!managing) return [];
    return TEMPLATES.filter((t) => !savesAsRequest(t.draft({ teams: [], everyone: true }))).map((t) => ({
      ...t,
      name: t.name.replace(/ per team$/, ""),
      description: "Cap what your agent tasks spend in a month.",
      draft: (reach) => ({ ...t.draft(reach), audience: { kind: "workspace" } }),
    }));
  }
  if (managing) return TEMPLATES;
  return ownsTeams ? TEMPLATES.filter((t) => savesAsRequest(t.draft({ teams: [], everyone: false }))) : [];
}

/**
 * The commit message to propose once for every repository a save touches. Each repository's
 * proposal carries its own commit prefix and the server puts that prefix back per repository,
 * so the shared message is what the proposals have in common: one repository's prefix in it
 * would ride into every other repository's commit.
 */
export function sharedMessage(proposals: string[]): string {
  if (proposals.length <= 1) return proposals[0] ?? "";
  let shared = proposals[0]!;
  for (const p of proposals.slice(1)) {
    let n = 0;
    while (n < shared.length && n < p.length && shared[shared.length - 1 - n] === p[p.length - 1 - n]) n++;
    shared = shared.slice(shared.length - n);
  }
  return shared.trimStart();
}

/** Where Controls stands, said once at the top: how many policies hold, before they are read. */
export function policiesSentence(count: number | null): string {
  if (count === null) return "A policy holds a group to rules.";
  return count ? `${count.toLocaleString("en-US")} ${count === 1 ? "policy holds" : "policies hold"} groups to rules.` : "No policy holds anyone to a rule yet.";
}
