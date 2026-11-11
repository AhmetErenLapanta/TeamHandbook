import { FORGES, HOSTED_FORGES } from "../../shared/forge-def.js";
import type { ForgeDefinition, HostedForge } from "../../shared/forge-def.js";
import { createGiteaForge, giteaAuth } from "./gitea.js";
import { GITEA_ADMIN } from "./gitea-admin.js";
import { createGitHubForge, githubAuth } from "./github.js";
import { createGitLabForge, gitlabAuth } from "./gitlab.js";
import type { RepoAdmin } from "./admin.js";
import { giteaMedia, githubMedia, gitlabMedia } from "./media.js";
import { GITHUB_ADMIN } from "./github-admin.js";
import { GITLAB_ADMIN } from "./gitlab-admin.js";
import type { ForgeConfig, ForgeProvider } from "./types.js";

/**
 * The server half of each hosted forge, beside its definition in shared/: how a token is sent and
 * the provider a repository's changes go through. Everything that picks a forge's code picks it
 * here, so a new forge is its definition, its driver file and one entry below.
 */
export interface ForgeDriver {
  definition: ForgeDefinition;
  /**
   * The headers a token travels in. `oauth` is the org's connection: GitLab takes an OAuth token
   * only as a bearer and refuses it in PRIVATE-TOKEN, where a pasted access token goes.
   */
  authHeaders(token: string, oauth: boolean): Record<string, string>;
  provider(config: ForgeConfig, token: string, send: typeof fetch, oauth: boolean): ForgeProvider;
  /** What it does to repositories themselves: list, create, tell empty, write a scaffold, describe a webhook. */
  admin: RepoAdmin;
  /** Where an image a request's description names is read with the repository's credential; null for anything but this forge's own attachments. */
  media(config: ForgeConfig, web: string, src: string): URL | null;
}

const LIST: ForgeDriver[] = [
  { definition: FORGES.gitlab, authHeaders: gitlabAuth, provider: (config, token, send, oauth) => createGitLabForge(config, token, send, oauth), admin: GITLAB_ADMIN, media: gitlabMedia },
  { definition: FORGES.github, authHeaders: (token) => githubAuth(token), provider: (config, token, send) => createGitHubForge(config, token, send), admin: GITHUB_ADMIN, media: githubMedia },
  { definition: FORGES.gitea, authHeaders: (token) => giteaAuth(token), provider: (config, token, send) => createGiteaForge(config, token, send), admin: GITEA_ADMIN, media: giteaMedia },
];

/** The drivers by kind: a kind given twice, or a hosted forge given none, stops the orchestrator at start. */
export function driverTable(list: readonly ForgeDriver[]): Record<HostedForge, ForgeDriver> {
  const table = new Map<HostedForge, ForgeDriver>();
  for (const driver of list) {
    if (table.has(driver.definition.kind)) throw new Error(`two forge drivers for ${driver.definition.kind}`);
    table.set(driver.definition.kind, driver);
  }
  const missing = HOSTED_FORGES.filter((kind) => !table.has(kind));
  if (missing.length) throw new Error(`no forge driver for ${missing.join(", ")}`);
  return Object.fromEntries(table) as Record<HostedForge, ForgeDriver>;
}

export const DRIVERS = driverTable(LIST);
