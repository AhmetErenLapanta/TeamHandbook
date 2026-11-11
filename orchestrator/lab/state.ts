import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a running lab is made of, written by `up` into the lab directory and read by the test
 * suite and by `down.sh`. Every name in it is a stand-in, except for an extra organization's,
 * which comes from a file outside the repository and stays in the lab directory.
 */

/** A file `down.sh` looks for before it deletes anything: a directory without it was not made by the lab. */
export const MARKER = ".teamhandbook-orchestrator-lab";

export function labDir(): string {
  return process.env.LAB_DIR ?? join(tmpdir(), "teamhandbook-orchestrator-lab");
}

export type ForgeKind = "local" | "gitlab" | "github";
export type Store = "sqlite" | "postgres";
export type Consent = "agree" | "decline" | "undecided";

export interface LabUser {
  key: string;
  email: string;
  name: string;
  role: "admin" | "owner" | "member";
  teams: string[];
}

export interface LabRepo {
  id: string;
  team: string;
  forge: ForgeKind;
  /** The address the orchestrator and every developer clones from. */
  url: string;
  /** The bare repository behind it, on this machine. */
  bare: string;
  /** group/name on a hosted forge. */
  project?: string;
  /** The address teammates add it by, as the orchestrator's configuration gives it; null when it gives none. */
  memberUrl: string | null;
  /** Whether it runs the plugin's version-bump CI job. */
  ci: boolean;
  /** Whether the scaffold carries a plugin version or is versioned by commit. */
  versioning: "number" | "commit";
  commitPrefix?: string;
  branchExample?: string;
  reviewers: string[];
  labels: string[];
  /** A code repository a task changes, and the skills repository it takes its team's setup from. */
  code?: { skillsFrom: string };
}

export interface LabDeveloper {
  name: string;
  repo: string;
  consent: Consent;
  home: string;
  handbook: string;
  /** The team copy Claude Code would keep, under the developer's home. */
  copy: string | null;
  /** What join printed or refused with, for a repository that is not a team repository. */
  joined: string;
}

export interface LabOrg {
  name: string;
  /** The secret a forge signs a delivery to this orchestrator's hook with, for its repositories on a hosted forge. */
  hookSecret?: string;
  /** Set up for one scenario alone; the checks every organization gets leave it out. */
  fixture?: string;
  /** Set for an organization added through LAB_EXTRA_ORGS; its name is never written into a test title. */
  extra: boolean;
  url: string;
  port: number;
  store: Store;
  dir: string;
  repos: LabRepo[];
  users: LabUser[];
  developers: LabDeveloper[];
  /** The people the lab's identity provider signs in for this organization; empty when its orchestrator offers no single sign-on. */
  sso: LabSsoPerson[];
}

export interface LabSsoPerson {
  key: string;
  sub: string;
  email: string;
  name: string;
  groups: string[];
  verified: boolean;
}

export interface LabForge {
  kind: "gitlab" | "github";
  url: string;
  api: string;
  token: string;
}

export interface LabProcess {
  name: string;
  pid: number;
}

export interface LabState {
  dir: string;
  orchestratorDir: string;
  pluginDist: string;
  /** The only PATH anything the lab starts sees: a stand-in claude, git and node, and the system's own directories. */
  path: string;
  password: string;
  forges: LabForge[];
  postgres: { url: string; container: string } | null;
  /** The lab's identity provider, when an organization signs in through one. */
  idp: { url: string } | null;
  /** The stand-in Jira, with the email and API token it takes. */
  /** `token` reads; `writeToken` also moves an issue through its workflow, the permission a person grants the orchestrator explicitly. */
  jira: { url: string; email: string; token: string; writeToken?: string } | null;
  /** The stand-in remote MCP server that signs people in with OAuth. */
  mcpOauth: { url: string } | null;
  /** The stand-in DNS server an orchestrator with single sign-on verifies email domains against; a test publishes a TXT record by writing `records`. */
  dns?: { port: number; records: string } | null;
  /** The stand-in MCP Registry every orchestrator reads its servers from. */
  registry?: { url: string } | null;
  /** The stand-in Google, GitHub and Microsoft a person signs up with, and the orchestrator's client at each. */
  signIn?: { url: string; clients: Record<"google" | "github" | "microsoft", { id: string; secret: string; redirects: string[] }[]> } | null;
  orgs: LabOrg[];
  processes: LabProcess[];
}

export function stateFile(dir: string = labDir()): string {
  return join(dir, "lab.json");
}

export function readLab(dir: string = labDir()): LabState {
  if (!existsSync(stateFile(dir))) throw new Error(`no lab is running at ${dir}; start one with npm run lab`);
  return JSON.parse(readFileSync(stateFile(dir), "utf8")) as LabState;
}

export function userOf(org: LabOrg, key: string): LabUser {
  const user = org.users.find((u) => u.key === key);
  if (!user) throw new Error(`${org.name} has no user ${key}`);
  return user;
}

export function ownerKey(team: string): string {
  return `owner:${team}`;
}
