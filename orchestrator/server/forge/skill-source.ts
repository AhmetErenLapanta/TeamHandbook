import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { OrchestratorContext } from "../app.js";
import { forgeDestination, gitConfigEnv, pinnedGitSettings } from "../connect.js";
import type { OrchestratorError } from "../errors.js";
import { gitAsync, gitAsyncMaybe } from "../git.js";
import { readInventory } from "../inventory.js";
import type { Inventory } from "../inventory.js";
import { redactLine } from "../log.js";
import { LOOPBACK_HOSTS, recognizeForge } from "../../shared/forge-def.js";
import type { HostedForge } from "../../shared/forge-def.js";
import { hasOwnCli, ownCredentialConfig } from "./own-cli.js";
import { ownCliHere } from "./own-cli-here.js";

/*
 * A skills repository a person names by its git address, for a task or a project: cloned into the
 * orchestrator's data directory as a bare mirror, kept current, and read for its skills and plugin
 * as a connected team repository is. Its address is judged as a forge's is, and git reaches it with
 * no credential of the orchestrator's: in local mode the person's own gh or glab answers git for a
 * GitHub or GitLab repository; anywhere else a repository is read as anyone can read it.
 */

type Context = Pick<OrchestratorContext, "resolveHost" | "internalForgeHosts" | "privateNetworkForges" | "ownForgeCli" | "forgeApps" | "store" | "tenant">;

export interface SkillSourceAddress {
  url: string;
  host: string;
  forge: HostedForge | "other";
  protocol: "https" | "ssh" | "http";
}

/** Why a skills repository is not read, named as connect's address refusals are, with the status a route answers it with. */
export interface SkillSourceRefusal {
  error: string;
  code: string;
  status: 400 | 403 | 502;
}

const refusal = (code: string, error: string, status: SkillSourceRefusal["status"] = 400): SkillSourceRefusal => ({ error, code, status });

const SCP = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):[^\s/][^\s]*$/;

/**
 * The address a skills repository is read from: https with no user or token in it, ssh on one
 * person's own machine alone, plain http to this machine alone. Anything else, file://, ext::,
 * git://, or an address git would read as an option, is refused.
 */
export function skillSourceAddress(ctx: Pick<Context, "ownForgeCli" | "forgeApps">, url: string): SkillSourceAddress | SkillSourceRefusal {
  const address = url.trim();
  const own = ctx.forgeApps?.gitlab ? { gitlab: [new URL(ctx.forgeApps.gitlab.webUrl).hostname] } : {};
  const forgeOf = (origin: string) => recognizeForge(origin, own) ?? "other";
  if (/^https?:\/\//i.test(address) && URL.canParse(address)) {
    const parsed = new URL(address);
    const protocol = parsed.protocol === "https:" ? "https" : "http";
    if (parsed.username || parsed.password) return refusal("address-has-credentials", "leave the user and token out of the address; your own sign-in reads it");
    if (protocol === "http" && !LOOPBACK_HOSTS.has(parsed.hostname)) return refusal("address-not-https", "a skills repository address is https (plain http only on this machine)");
    return { url: address, host: parsed.hostname, forge: forgeOf(`${parsed.origin}/`), protocol };
  }
  const ssh = address.startsWith("-") ? null : (/^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/\S+$/i.exec(address) ?? SCP.exec(address));
  if (!ssh) return refusal("address-not-a-repository", "a skills repository is named by its https address, or on your own machine by ssh");
  // An ssh connection is not held to an address judged here, so it is read on the person's own machine alone.
  if (!ctx.ownForgeCli) return refusal("address-ssh-on-own-machine-only", "an ssh address is read only on your own machine; enter the repository's https address");
  return { url: address, host: ssh[1]!, forge: forgeOf(`https://${ssh[1]}/`), protocol: "ssh" };
}

/** git's settings for reaching the address: held to the address judged for its host, redirects off, its one protocol alone. */
async function reachSettings(ctx: Context, at: SkillSourceAddress): Promise<{ env: Record<string, string> } | SkillSourceRefusal> {
  const judged = (err: OrchestratorError) => refusal(err.code, err.message, err.status === 403 ? 403 : 400);
  if (at.protocol === "ssh") {
    const reached = await forgeDestination(ctx, new URL(`https://${at.host}/`)).catch(judged);
    return typeof reached === "string" ? { env: { GIT_ALLOW_PROTOCOL: "ssh" } } : reached;
  }
  const url = new URL(at.url);
  const pinned = await pinnedGitSettings(ctx, url).catch(judged);
  if (!Array.isArray(pinned)) return pinned;
  // On the person's own machine their gh or glab answers git for a GitHub or GitLab repository; nowhere is a credential written.
  const helper = ctx.ownForgeCli && hasOwnCli(at.forge) ? ownCredentialConfig(at.forge) : [];
  return { env: gitConfigEnv(url, [...pinned, ...helper]) };
}

/**
 * The mirror of a skills repository at `dir`, cloned the first time and fetched every time after,
 * its head returned. A clone that fails, or brings no commit, leaves no mirror behind; a fetch that
 * fails leaves the mirror as it was. The mirror's own config holds the address as given, no credential.
 */
export async function fetchSkillSource(given: Context, url: string, dir: string): Promise<{ head: string } | SkillSourceRefusal> {
  // The person's own ssh, gh or glab reach the address only while one person holds this orchestrator, asked now.
  const ctx = { ...given, ownForgeCli: await ownCliHere(given) };
  const at = skillSourceAddress(ctx, url);
  if ("error" in at) return at;
  const reach = await reachSettings(ctx, at);
  if ("error" in reach) return reach;
  const { env } = reach;
  const said = (err: Error & { stderr?: string }) => redactLine(String(err.stderr || err.message).replace(/\p{C}+/gu, " ").trim().slice(0, 300));
  const first = !existsSync(dir);
  if (first) {
    await mkdir(dirname(dir), { recursive: true });
    const cloned = await gitAsync(["clone", "--quiet", "--mirror", "--", at.url, dir], dirname(dir), undefined, undefined, { env }).then(
      () => null,
      (err: Error) => refusal("clone-failed", `git did not read ${at.host}: ${said(err)}; check the address and that it is readable to you, then add it again`, 502),
    );
    if (cloned) {
      await rm(dir, { recursive: true, force: true });
      return cloned;
    }
  } else {
    if ((await gitAsyncMaybe(["config", "--get", "remote.origin.url"], dir))?.trim() !== at.url) await gitAsync(["remote", "set-url", "origin", at.url], dir);
    const fetched = await gitAsync(["fetch", "--quiet", "--prune", "origin"], dir, undefined, undefined, { env }).then(
      () => null,
      (err: Error) => refusal("fetch-failed", `git did not read ${at.host}: ${said(err)}; the skills read last stay in use, so check the address, then press Refresh`, 502),
    );
    if (fetched) return fetched;
  }
  const head = (await gitAsyncMaybe(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], dir))?.trim();
  if (head) return { head };
  if (first) await rm(dir, { recursive: true, force: true });
  return refusal("source-has-no-commit", `${at.host} holds no commit to read skills from; push one to it, then try again`);
}

/** What the mirror holds at `head`, the one its record last read: its skills, plugin and marketplace, MCP servers and commands, as a team repository is read. */
export function readSkillSource(dir: string, head = "HEAD"): Promise<Inventory> {
  return readInventory(dir, head);
}
