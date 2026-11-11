import { ForgeHttpError } from "./http.js";
import { forgeCall, LISTED_MAX, nameTaken, NOT_EMPTY, SetupRefused } from "./admin.js";
import type { RepoAdmin } from "./admin.js";
import { FORGES } from "../../shared/forge-def.js";

interface GiteaRepo {
  full_name?: unknown;
  clone_url?: unknown;
  empty?: unknown;
}

/** Gitea's owner/name as a path: each part encoded, the slash between them kept. */
const ownerName = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

/**
 * A repository's administration on Gitea, before Gitea is a forge the orchestrator offers. Gitea has
 * no org connection here: a repository is reached with a person's access token, so the list is what
 * that token's account reaches, and a new repository is made in an organization or that account.
 */
export const GITEA_ADMIN: RepoAdmin = {
  visibilities: FORGES.gitea.visibilities,

  async list(http) {
    const listed = await http.request<GiteaRepo[]>("GET", `/user/repos?limit=${LISTED_MAX}`);
    return listed.map((r) => ({ fullName: r.full_name, url: r.clone_url, empty: r.empty === true }));
  },

  async emptyTarget(http, fullName, url) {
    const apiId = ownerName(fullName);
    // A tag alone holds commits too, with no branch to show them.
    const branches = await forgeCall(() => http.request<unknown[]>("GET", `/repos/${apiId}/branches?limit=1`));
    const tags = await forgeCall(() => http.request<unknown[]>("GET", `/repos/${apiId}/tags?limit=1`));
    if (branches.length || tags.length) throw new SetupRefused(NOT_EMPTY, 409);
    return { fullName, url, apiId, created: false };
  },

  async create(http, repository) {
    const { name, visibility, namespace } = repository;
    const path = namespace ? `/orgs/${encodeURIComponent(namespace)}/repos` : "/user/repos";
    try {
      const repo = await http.request<{ full_name: string; clone_url: string }>("POST", path, { name, private: visibility === "private", auto_init: false });
      return { fullName: repo.full_name, url: repo.clone_url, apiId: ownerName(repo.full_name), created: true };
    } catch (err) {
      // Gitea answers a name already taken with 409.
      if (nameTaken(err) || (err instanceof ForgeHttpError && err.status === 409)) throw new SetupRefused(`a repository named ${name} is already there; pick it if it is empty, or choose another name`, 409);
      return forgeCall(() => Promise.reject(err));
    }
  },

  /**
   * The whole scaffold as the repository's first commit through Gitea's change-files call, which
   * starts the default branch of an empty repository. Gitea never forces it: a commit pushed in
   * between makes its parent, which is reported rather than hidden.
   */
  async writeScaffold(http, target, files, author, title) {
    const repo = `/repos/${target.apiId}`;
    const { default_branch: branch } = await http.request<{ default_branch: string }>("GET", repo);
    const written = await http.request<{ commit?: { parents?: unknown[] } }>("POST", `${repo}/contents`, {
      message: title,
      branch,
      author,
      files: Object.entries(files).map(([path, content]) => ({ operation: "create", path, content: Buffer.from(content, "utf8").toString("base64") })),
    });
    if (written.commit?.parents?.length) throw new SetupRefused(`someone pushed to ${target.fullName} while it was being set up, so its scaffold landed on top of their commits; review it there`, 409);
  },

  // Gitea keeps a pull request's new commits apart from its opening, as pull_request_sync.
  webhook(target, url, secret) {
    return { path: `/repos/${target.apiId}/hooks`, body: { type: "gitea", active: true, events: ["push", "pull_request", "pull_request_sync"], config: { url, content_type: "json", secret } } };
  },
};
