import { call } from "./api";

/** As PROJE-sozlesme.md Ek 15 has them: what a project gives its tasks on top of the person's own Claude Code. */
export interface SourceSkill { name: string; description: string }
export type SkillSource =
  | { id: string; kind: "folder"; path: string; name: string; skills: SourceSkill[]; readAt: string }
  | { id: string; kind: "git"; url: string; name: string; head: string; skills: SourceSkill[]; readAt: string };
/** `env` and `headers` are names only; their values stay in the orchestrator's vault and never come back. */
export type TaskMcpServer =
  | { id: string; name: string; transport: "stdio"; command: string; args: string[]; env: string[] }
  | { id: string; name: string; transport: "http"; url: string; headers: string[] };
export type NewMcpServer =
  | { name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { name: string; url: string; headers?: Record<string, string> };
export interface TaskSkills { team: SourceSkill[]; project: (SourceSkill & { source: string })[] }

const at = (project: string, rest = "") => `/api/projects/${encodeURIComponent(project)}${rest}`;

/** The one place the project's task tools are named; the server reads every folder and address. */
export const taskTools = {
  read: (project: string) => call<{ skillSources: SkillSource[]; mcpServers: TaskMcpServer[] }>("GET", at(project, "/task-tools")),
  addSource: (project: string, where: { folder: string } | { url: string }) => call<{ source: SkillSource }>("POST", at(project, "/skill-sources"), where).then((b) => b.source),
  refresh: (project: string, source: string) => call<{ source: SkillSource }>("POST", at(project, `/skill-sources/${encodeURIComponent(source)}/refresh`)).then((b) => b.source),
  removeSource: (project: string, source: string) => call<unknown>("DELETE", at(project, `/skill-sources/${encodeURIComponent(source)}`)),
  addServer: (project: string, server: NewMcpServer) => call<{ server: TaskMcpServer }>("POST", at(project, "/mcp-servers"), server).then((b) => b.server),
  removeServer: (project: string, server: string) => call<unknown>("DELETE", at(project, `/mcp-servers/${encodeURIComponent(server)}`)),
  skills: (project: string) => call<TaskSkills>("GET", at(project, "/task-skills")),
};

/** Where a skill source is, as the person reads it: its folder from home, or its address. */
export function sourcePlace(source: SkillSource): string {
  return source.kind === "folder" ? source.path : source.url;
}

/** A pasted source: a path from home or from the root is a folder, anything else an address the server reads. */
export function sourceInput(text: string): { folder: string } | { url: string } {
  const where = text.trim();
  return /^(~|\/)/.test(where) ? { folder: where } : { url: where };
}

/** `NAME=value` lines as the names and values a server is started with; a line with no name is left out. */
export function namedValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    const name = (at < 0 ? line : line.slice(0, at)).trim();
    if (name) values[name] = at < 0 ? "" : line.slice(at + 1).trim();
  }
  return values;
}
