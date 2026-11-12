import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { gitConfigEnv, pinnedGitSettings } from "../connect.js";
import { gitAsync, gitAsyncMaybe } from "../git.js";
import { redactLine } from "../log.js";
import { machineFolderOf } from "../projects.js";
import { teamAssignment } from "../propose.js";
import type { RepoRecord } from "../store.js";
import { branchRefusal, branchRules } from "../tasks/pushed-check.js";
import type { TaskRecord, TaskTarget } from "../tasks/types.js";
import { FORGES } from "../../shared/forge-def.js";
import { DEVICE_ENDPOINTS, deviceSignInState, personForgeToken } from "./device-sign-in.js";
import type { DeviceEndpoints } from "./device-sign-in.js";
import { APP_FORGES } from "./oauth.js";
import type { AppForge } from "./oauth.js";
import { ForgeHttpError } from "./http.js";
import { scratch } from "./local.js";
import { originOf } from "./pushed.js";
import { DRIVERS } from "./registry.js";

export type UnconnectedOpened = { opened: { forge: string; account: string; number: number; url: string } } | { refused: string };

/** A path of the forge's own shape, each part a plain name: GitHub owner/name, GitLab a group path ending in the project. */
const PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const validProject = (kind: "github" | "gitlab", project: string) => {
  const parts = project.split("/");
  return parts.every((part) => PART.test(part) && !part.endsWith(".git")) && (kind === "github" ? parts.length === 2 : parts.length >= 2);
};

/** The forge's REST calls this path makes itself: the default branch it names, and closing a request whose head moved. */
function restOf(kind: "github" | "gitlab", api: string, project: string, token: string, send: typeof fetch) {
  const headers = { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` };
  const call = async (method: string, path: string, body?: unknown) => {
    const answer = await send(`${api}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!answer.ok) throw new ForgeHttpError(`${FORGES[kind].label} answered ${answer.status}`, answer.status);
    return (await answer.json().catch(() => ({}))) as Record<string, unknown>;
  };
  const repoPath = kind === "github" ? `/repos/${project.split("/").map(encodeURIComponent).join("/")}` : `/projects/${encodeURIComponent(project)}`;
  return {
    defaultBranch: async () => {
      const branch = (await call("GET", repoPath)).default_branch;
      if (typeof branch !== "string" || !branch) throw new ForgeHttpError(`${FORGES[kind].label} names no default branch for ${project}`, 502);
      return branch;
    },
    close: async (number: number, note: string) => {
      if (kind === "github") {
        await call("POST", `${repoPath}/issues/${number}/comments`, { body: note });
        await call("PATCH", `${repoPath}/pulls/${number}`, { state: "closed" });
      } else {
        await call("POST", `${repoPath}/merge_requests/${number}/notes`, { body: note });
        await call("PUT", `${repoPath}/merge_requests/${number}`, { state_event: "close" });
      }
    },
  };
}

/**
 * The request for a change a person's machine pushed to a remote the organization never
 * connected, opened because the task's starter pressed for it, with the sign-in they made with a
 * one-time code on that github.com or gitlab.com, and only for a task their own machine ran. The
 * orchestrator reads the branch itself before anything opens: it fetches the branch and the
 * default branch the forge names into a repository of its own under the data directory, deleted
 * afterwards, holds the head to the one the machine reported and its base to the forge's default
 * history, and runs the team's rules on it as on any pushed branch (branchRules and branchRefusal
 * over that repository). Nothing is pushed: the machine already did. The token goes to that origin alone, in
 * git's environment as a header and as the REST calls' own. A request whose head on the forge is not
 * the one checked is closed again with a note.
 */
export async function openOnUnconnectedRemote(ctx: OrchestratorContext, user: Pick<Principal, "id" | "email" | "name" | "role">, task: TaskRecord, project: RepoRecord, kept: TaskTarget, send: typeof fetch = fetch, endpoints: Record<AppForge, DeviceEndpoints> = DEVICE_ENDPOINTS): Promise<UnconnectedOpened> {
  const at = kept.origin ? originOf(kept.origin) : null;
  // The forge is the one whose public host the remote names exactly; an ssh remote is read over that forge's own https, and any other host is never sent the token.
  const kind = at ? APP_FORGES.find((k) => endpoints[k].host === at.host) : undefined;
  if (!at || !kind) return { refused: "its remote is not on github.com or gitlab.com, where a sign-in with a code opens a request" };
  if (!validProject(kind, at.project)) return { refused: `its remote names ${at.project}, which is not a ${FORGES[kind].label} project path` };
  if (!kept.branch || !kept.head || !kept.baseSha) return { refused: "the task kept no branch, head and base for this change" };
  const folder = machineFolderOf(project.url);
  const machine = folder ? (await ctx.store.listMachines(ctx.tenant, null)).find((m) => m.id === folder.machineId) : undefined;
  if (!machine || machine.userId !== user.id) return { refused: "the task ran on a machine that is not yours" };
  const token = await personForgeToken(ctx, user.id, kind);
  const signedIn = await deviceSignInState(ctx, user, kind);
  if (!token || signedIn.state !== "done") return { refused: `sign in to ${FORGES[kind].label} on its card first, with the code it gives` };
  const web = new URL(endpoints[kind].code).origin;
  const url = new URL(`${web}/${at.project}.git`);
  const api = FORGES[kind].apiUrlFor(new URL(web));
  const rest = restOf(kind, api, at.project, token, send);
  const dir = await scratch(join(ctx.dataDir, "work"), "read-");
  try {
    const target = await rest.defaultBranch();
    const pinned = await pinnedGitSettings(ctx, url).catch((err: Error) => {
      throw new ForgeHttpError(err.message, 400);
    });
    const header = `Authorization: Basic ${Buffer.from(`${FORGES[kind].gitUser}:${token}`).toString("base64")}`;
    const env = { ...gitConfigEnv(url, [...pinned, ["credential.helper", ""], [`http.${url.origin}/.extraHeader`, header]]), GIT_ALLOW_PROTOCOL: new URL(web).protocol.replace(":", ""), GIT_TERMINAL_PROMPT: "0" };
    await gitAsync(["init", "--quiet", "--bare", dir], dir);
    // The whole history of both branches: no depth, so the base check sees every ancestor; no tags, no submodules.
    await gitAsync(["--git-dir", dir, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", url.href, `refs/heads/${kept.branch}:refs/heads/${kept.branch}`, `refs/heads/${target}:refs/heads/${target}`], dir, undefined, undefined, { env }).catch((err: Error & { stderr?: string }) => {
      throw new ForgeHttpError(`git did not read ${kept.branch} from ${FORGES[kind].label}: ${redactLine((err.stderr || err.message).replace(/\p{C}+/gu, " ").trim().slice(0, 300))}`, 502);
    });
    await gitAsync(["--git-dir", dir, "symbolic-ref", "HEAD", `refs/heads/${target}`], dir);
    const head = (await gitAsyncMaybe(["--git-dir", dir, "rev-parse", "--verify", "--quiet", `refs/heads/${kept.branch}^{commit}`], dir))?.trim();
    if (head !== kept.head) return { refused: `${kept.branch} on ${FORGES[kind].label} is not the head the task left (${kept.head.slice(0, 7)}); read the task again` };
    // The base the machine started from has to be in the forge's own default history: a merge base alone would take any shared ancestor.
    if ((await gitAsyncMaybe(["--git-dir", dir, "merge-base", "--is-ancestor", kept.baseSha, `refs/heads/${target}`], dir)) === null) {
      return { refused: `the task started from ${kept.baseSha.slice(0, 7)}, which is not in ${target} on ${FORGES[kind].label}` };
    }
    // The team's rules as for any pushed branch (one core with headRefusal): the task's own secrets and the policy, never read from the branch.
    const held = await branchRules(ctx, { ...task, baseSha: kept.baseSha }, project, kept.baseSha, dir);
    if ("refused" in held) return { refused: held.refused };
    const defaultHead = (await gitAsync(["--git-dir", dir, "rev-parse", `refs/heads/${target}^{commit}`], dir)).trim();
    const checked = await branchRefusal(dir, kept.branch, head, kept.baseSha, { name: target, head: defaultHead }, held);
    if ("refused" in checked) return { refused: checked.refused };
    const words = kept.description ?? { title: task.title, body: "" };
    const forge = DRIVERS[kind].provider({ repoId: task.repoId, kind, apiUrl: api, project: at.project }, token, send, true);
    const opened = await forge.openForBranch!({ ...project, url: url.href }, { title: words.title, body: words.body, branch: kept.branch, baseSha: kept.baseSha, target, assignment: await teamAssignment(ctx, project, user as Principal) });
    if (opened.headSha !== head) {
      await rest.close(opened.number, `Closed by the TeamHandbook orchestrator: ${kept.branch} moved to ${opened.headSha.slice(0, 7)} after it checked ${head.slice(0, 7)}, so this request is not the change it checked.`);
      return { refused: `${kept.branch} moved on ${FORGES[kind].label} while the request opened, so it was closed again; read the task again` };
    }
    return { opened: { forge: FORGES[kind].label, account: signedIn.account, number: opened.number, url: opened.url } };
  } catch (err) {
    if (err instanceof ForgeHttpError) return { refused: err.message };
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
