/**
 * The orchestrator's own nouns, each said one way and explained in one sentence, so a screen that
 * introduces one reads the same as every other screen that does.
 */
export const WORDS = {
  project: { term: "Project", means: "A folder or repository agents work in, with nothing to set up in it first; you review what they change before you keep it." },
  orchestrator: { term: "TeamHandbook Orchestrator", means: "Where a team keeps the Claude Code skills, MCP servers and commands it shares, works its sprint's issues and starts agents on them; every change reaches teammates through a request someone reviews." },
  teamRepository: { term: "Team repository", means: "A Git repository a team shares its Claude Code skills, MCP servers and slash commands from; teammates install it once and get every merged change." },
  request: { term: "Request", means: "A proposed change to a team repository: a merge request on GitLab, a pull request on GitHub, or a branch on the orchestrator's own copy for a repository read by path. Nothing in it reaches teammates until a reviewer merges it." },
  skill: { term: "Skill", means: "Written know-how Claude Code loads when a task matches what the skill says it is for." },
  mcpServer: { term: "MCP server", means: "A tool server Claude Code calls, started on the machine it runs on or reached over the network, such as a tracker or a database reader." },
  task: { term: "Task", means: "Work an agent does from an issue or a description in one or more projects; a person reviews what it changed before it is kept, as a request where the project has one." },
  policy: { term: "Policy", means: "A rule the orchestrator or a team sets, such as a skill or MCP server blocked in teammates' sessions or a monthly cap on what tasks spend." },
} as const;

/**
 * What the orchestrator is for, said once at the top of the first screen: what a person does and
 * what they get, before any word for how it works underneath.
 */
export const PROMISE = "Give a team of agents any folder on this machine: say what needs doing, and review every change before you keep it.";

/** The same promise where a person connects their own computer to a team's orchestrator. */
export const PROMISE_CONNECTED = "Give a team of agents any folder on your computer: say what needs doing, and review every change before you keep it.";
