import { readFileSync } from "node:fs";

export interface ConfiguredRepo {
  id: string;
  team: string;
  name: string;
  url: string;
  /** What a task runs, in its checkout, before it opens a request. */
  testCommand?: string;
  mcpTools?: unknown;
  tracker?: unknown;
  memberUrl?: unknown;
  /** `code` for a repository tasks change that is not a skills repository; the task settings read it. */
  kind?: unknown;
  skillsFrom?: unknown;
  naming?: unknown;
  jobs?: unknown;
  triggerSecretEnv?: unknown;
}

export interface OrchestratorConfig {
  tenant?: string;
  repos?: ConfiguredRepo[];
  /** The organizations one orchestrator serves, each a tenant with repositories of its own. */
  orgs?: OrgConfig[];
}

export interface OrgConfig {
  tenant: string;
  repos?: ConfiguredRepo[];
  /**
   * Whether the orchestrator's single sign-on lets people into this org. The provider is the
   * orchestrator's, not an org's, and whoever it lets through becomes a member, so with several orgs
   * each one that takes it says so.
   */
  sso?: boolean;
}

export const DEFAULT_TENANT = "default";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOP_KEYS = new Set(["tenant", "repos", "orgs"]);
const ORG_KEYS = new Set(["tenant", "repos", "sso"]);
/** First path segments the orchestrator itself answers, which the web app's `/<tenant>/` pages would shadow. */
export const RESERVED_TENANTS = new Set(["api", "ingest", "mcp", "integrations", "assets"]);
const REPO_KEYS = new Set(["id", "team", "name", "url", "testCommand", "mcpTools", "tracker", "memberUrl", "kind", "skillsFrom", "naming", "jobs", "triggerSecretEnv"]);

export class ConfigRefused extends Error {}

function text(value: unknown, where: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new ConfigRefused(`${where} must be a non-empty string`);
  return value;
}

/**
 * The configuration as the orchestrator will use it, or a refusal naming the first thing wrong. A
 * key nobody reads is refused rather than skipped: a misspelled `repos` would otherwise read as
 * every repository taken out of the configuration, and a start then stops syncing all of them.
 */
export function parseConfig(raw: string, file: string): OrchestratorConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    throw new ConfigRefused(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigRefused(`${file} must hold a JSON object`);
  const top = value as Record<string, unknown>;
  for (const key of Object.keys(top)) if (!TOP_KEYS.has(key)) throw new ConfigRefused(`${file} has "${key}", which the orchestrator does not read; the keys are ${[...TOP_KEYS].join(", ")}`);
  if (top.orgs !== undefined) return { orgs: parseOrgs(top) };
  const tenant = tenantOf(top.tenant, "tenant", false);
  const repos = parseRepos(top.repos, "repos");
  return { ...(tenant === undefined ? {} : { tenant }), ...(repos === undefined ? {} : { repos }) };
}

function tenantOf(value: unknown, where: string, required: boolean): string | undefined {
  const tenant = text(value, where, required);
  if (tenant !== undefined && !ID.test(tenant)) throw new ConfigRefused(`${where} "${tenant}" must be lowercase letters, digits and dashes`);
  return tenant;
}

/**
 * A file that lists organizations names nothing at the top beside them: a `tenant` or `repos`
 * left there would belong to no organization, and reading it as one would serve repositories
 * under a tenant the operator did not name.
 */
function parseOrgs(top: Record<string, unknown>): OrgConfig[] {
  for (const key of ["tenant", "repos"]) if (top[key] !== undefined) throw new ConfigRefused(`"${key}" goes inside an entry of orgs when the file lists orgs`);
  if (!Array.isArray(top.orgs) || top.orgs.length === 0) throw new ConfigRefused("orgs must be a list of at least one organization");
  const seen = new Set<string>();
  return top.orgs.map((entry, index): OrgConfig => {
    const where = `orgs[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ConfigRefused(`${where} must be an object`);
    const org = entry as Record<string, unknown>;
    for (const key of Object.keys(org)) if (!ORG_KEYS.has(key)) throw new ConfigRefused(`${where} has "${key}", which the orchestrator does not read`);
    const tenant = tenantOf(org.tenant, `${where}.tenant`, true)!;
    if (RESERVED_TENANTS.has(tenant)) throw new ConfigRefused(`${where}.tenant "${tenant}" is a path the orchestrator answers itself; pick another name`);
    if (seen.has(tenant)) throw new ConfigRefused(`${where}.tenant "${tenant}" appears twice`);
    seen.add(tenant);
    const repos = parseRepos(org.repos, `${where}.repos`);
    if (org.sso !== undefined && typeof org.sso !== "boolean") throw new ConfigRefused(`${where}.sso must be true or false`);
    return { tenant, ...(repos === undefined ? {} : { repos }), ...(org.sso === true ? { sso: true } : {}) };
  });
}

function parseRepos(value: unknown, at: string): ConfiguredRepo[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ConfigRefused(`${at} must be a list`);
  const seen = new Set<string>();
  return value.map((entry, index): ConfiguredRepo => {
    const where = `${at}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new ConfigRefused(`${where} must be an object`);
    const repo = entry as Record<string, unknown>;
    for (const key of Object.keys(repo)) if (!REPO_KEYS.has(key)) throw new ConfigRefused(`${where} has "${key}", which the orchestrator does not read`);
    const id = text(repo.id, `${where}.id`, true)!;
    if (!ID.test(id)) throw new ConfigRefused(`${where}.id "${id}" must be lowercase letters, digits and dashes`);
    if (seen.has(id)) throw new ConfigRefused(`${where}.id "${id}" appears twice`);
    seen.add(id);
    const testCommand = text(repo.testCommand, `${where}.testCommand`, false);
    return {
      id,
      team: text(repo.team, `${where}.team`, true)!,
      name: text(repo.name, `${where}.name`, true)!,
      url: text(repo.url, `${where}.url`, true)!,
      ...(testCommand === undefined ? {} : { testCommand }),
      ...(repo.mcpTools === undefined ? {} : { mcpTools: repo.mcpTools }),
      ...(repo.tracker === undefined ? {} : { tracker: repo.tracker }),
      ...(repo.memberUrl === undefined ? {} : { memberUrl: repo.memberUrl }),
      ...(repo.kind === undefined ? {} : { kind: repo.kind }),
      ...(repo.skillsFrom === undefined ? {} : { skillsFrom: repo.skillsFrom }),
      ...(repo.naming === undefined ? {} : { naming: repo.naming }),
      ...(repo.jobs === undefined ? {} : { jobs: repo.jobs }),
      ...(repo.triggerSecretEnv === undefined ? {} : { triggerSecretEnv: repo.triggerSecretEnv }),
    };
  });
}

/**
 * The organizations this orchestrator serves, the first being the one the unprefixed `/api` paths
 * reach. A file of one tenant, or none, is one organization, so an install from before
 * organizations opens as it did, single sign-on included.
 */
export function servedOrgs(config: OrchestratorConfig): OrgConfig[] {
  if (config.orgs) return config.orgs;
  return [{ tenant: config.tenant ?? DEFAULT_TENANT, ...(config.repos ? { repos: config.repos } : {}), sso: true }];
}

export function readConfig(file: string): OrchestratorConfig {
  return parseConfig(readFileSync(file, "utf8"), file);
}
