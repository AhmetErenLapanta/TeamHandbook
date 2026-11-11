/** A team's rule that takes something away, as a teammate's session is told it. */
export interface Removal { resource: string; reason: string }

export interface RepoReach {
  repoId: string;
  name: string;
  team: string;
  skills: { slug: string; removedBy: Removal | null }[];
  mcpServers: { name: string; removedBy: Removal | null; tools: (Removal & { tool: string })[] }[];
  commands: string[];
  /** Claude Code tools the team's rules hold back, whole or on some inputs. */
  tools: Removal[];
  /** Why the team's rules at this commit do not read as rules; teammates' sessions keep the last rules that did, and a task here is refused. */
  problem: string | null;
}

/** What reaches one member from the orchestrator's teams, and what the orchestrator lets them start. */
export interface MemberConfig {
  member: { id: string; name: string; email: string };
  teams: string[];
  tags: string[];
  repos: RepoReach[];
  tasks: { repoId: string; name: string; refusal: string | null }[];
}

export interface MemberConfigPreview { before: MemberConfig; after: MemberConfig }
