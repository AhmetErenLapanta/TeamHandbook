import { forgeCall, LISTED_MAX, MakeItOnGitHub, nameTaken, NOT_EMPTY, SetupRefused } from "./admin.js";
import type { RepoAdmin } from "./admin.js";
import { FORGES } from "../../shared/forge-def.js";

interface GitHubRepo {
  full_name?: unknown;
  clone_url?: unknown;
  size?: unknown;
}

/** GitHub's owner/name as a path: each part encoded, the slash between them kept. */
const ownerName = (fullName: string) => fullName.split("/").map(encodeURIComponent).join("/");

export const GITHUB_ADMIN: RepoAdmin = {
  visibilities: FORGES.github.visibilities,

  // The repositories the app was installed on.
  async list(http) {
    const listed = await http.request<{ repositories?: GitHubRepo[] }>("GET", `/installation/repositories?per_page=${LISTED_MAX}`);
    return (listed.repositories ?? []).map((r) => ({ fullName: r.full_name, url: r.clone_url, empty: r.size === 0 }));
  },

  async emptyTarget(http, fullName, url) {
    const apiId = ownerName(fullName);
    // A tag alone holds commits too, with no branch to show them.
    const branches = await forgeCall(() => http.request<unknown[]>("GET", `/repos/${apiId}/branches?per_page=1`));
    const tags = await forgeCall(() => http.request<unknown[]>("GET", `/repos/${apiId}/tags?per_page=1`));
    if (branches.length || tags.length) throw new SetupRefused(NOT_EMPTY, 409);
    return { fullName, url, apiId, created: false };
  },

  async create(http, repository, connected) {
    const { name, visibility } = repository;
    // An app's token creates a repository only in an organization; a personal account makes it itself.
    if (!connected.organization) {
      const create = new URL(`${connected.webUrl}/new`);
      for (const [k, v] of Object.entries({ owner: connected.account, name, visibility })) create.searchParams.set(k, v);
      throw new MakeItOnGitHub(`the app is installed on ${connected.account}, a personal account, where GitHub lets only its owner create repositories: create an empty repository named ${name} on GitHub without a README, add it to the app's installation, then pick it here as an existing empty repository`, [
        { text: `Create the repository ${name} on GitHub, with no README, .gitignore or license, so it stays empty.`, url: create.toString() },
        { text: `Add ${name} to the app's installation on ${connected.account}.`, url: connected.manageUrl },
        { text: `Back here, ${name} is listed; press "Use ${connected.account}/${name} as the team repository".`, url: null },
      ]);
    }
    try {
      const repo = await http.request<{ full_name: string; clone_url: string }>("POST", `/orgs/${encodeURIComponent(connected.account)}/repos`, { name, private: visibility === "private", visibility, auto_init: false });
      return { fullName: repo.full_name, url: repo.clone_url, apiId: ownerName(repo.full_name), created: true };
    } catch (err) {
      if (nameTaken(err)) throw new SetupRefused(`a repository named ${name} is already in ${connected.account}; pick it if it is empty, or choose another name`, 409);
      return forgeCall(() => Promise.reject(err));
    }
  },

  /**
   * GitHub's Git Data API refuses an empty repository, so its first commit is the README through
   * the contents API, which starts the default branch, and the rest of the scaffold follows on top
   * of it as a second commit. The branch moves only forward: a push in between makes GitHub refuse
   * the second step rather than lose anyone's commit.
   */
  async writeScaffold(http, target, files, author, title) {
    const repo = `/repos/${target.apiId}`;
    const { default_branch: branch } = await http.request<{ default_branch: string }>("GET", repo);
    const { "README.md": readme = "", ...rest } = files;
    const first = await http.request<{ commit: { sha: string; tree: { sha: string }; parents?: unknown[] } }>("PUT", `${repo}/contents/README.md`, { message: title, content: Buffer.from(readme).toString("base64"), branch, author });
    if (first.commit.parents?.length) throw new SetupRefused(`someone pushed to ${target.fullName} while it was being set up, so its README landed on top of their commits; review it there`, 409);
    const tree = await http.request<{ sha: string }>("POST", `${repo}/git/trees`, { base_tree: first.commit.tree.sha, tree: Object.entries(rest).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) });
    const second = await http.request<{ sha: string }>("POST", `${repo}/git/commits`, { message: title, tree: tree.sha, parents: [first.commit.sha], author });
    await http.request("PATCH", `${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, { sha: second.sha, force: false });
  },

  webhook(target, url, secret) {
    return { path: `/repos/${target.apiId}/hooks`, body: { name: "web", active: true, events: ["push", "pull_request"], config: { url, content_type: "json", secret, insecure_ssl: "0" } } };
  },
};
