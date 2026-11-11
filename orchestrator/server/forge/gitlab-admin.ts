import { forgeCall, LISTED_MAX, nameTaken, NOT_EMPTY, SetupRefused } from "./admin.js";
import type { RepoAdmin } from "./admin.js";
import { FORGES } from "../../shared/forge-def.js";

interface GitLabProject {
  path_with_namespace?: unknown;
  http_url_to_repo?: unknown;
  empty_repo?: unknown;
}

export const GITLAB_ADMIN: RepoAdmin = {
  visibilities: FORGES.gitlab.visibilities,

  // The projects the person who connected is at least a developer of: those a request can be opened on.
  async list(http) {
    const projects = await http.request<GitLabProject[]>("GET", `/projects?membership=true&min_access_level=30&order_by=last_activity_at&sort=desc&simple=true&per_page=${LISTED_MAX}`);
    return projects.map((p) => ({ fullName: p.path_with_namespace, url: p.http_url_to_repo, empty: p.empty_repo === true }));
  },

  async emptyTarget(http, fullName, url) {
    const project = await forgeCall(() => http.request<{ id: number; empty_repo?: boolean }>("GET", `/projects/${encodeURIComponent(fullName)}`));
    const branches = await forgeCall(() => http.request<unknown[]>("GET", `/projects/${project.id}/repository/branches?per_page=1`));
    // A tag alone holds commits too, with no branch to show them.
    const tags = await forgeCall(() => http.request<unknown[]>("GET", `/projects/${project.id}/repository/tags?per_page=1`));
    if (project.empty_repo !== true || branches.length || tags.length) throw new SetupRefused(NOT_EMPTY, 409);
    return { fullName, url, apiId: String(project.id), created: false };
  },

  async create(http, repository) {
    const namespaceId = repository.namespace ? (await forgeCall(() => http.request<{ id: number }>("GET", `/namespaces/${encodeURIComponent(repository.namespace!)}`))).id : undefined;
    try {
      const project = await http.request<{ id: number; path_with_namespace: string; http_url_to_repo: string }>("POST", "/projects", { name: repository.name, path: repository.name, visibility: repository.visibility, initialize_with_readme: false, ...(namespaceId ? { namespace_id: namespaceId } : {}) });
      return { fullName: project.path_with_namespace, url: project.http_url_to_repo, apiId: String(project.id), created: true };
    } catch (err) {
      if (nameTaken(err)) throw new SetupRefused(`a repository named ${repository.name} is already there; pick it if it is empty, or choose another name`, 409);
      return forgeCall(() => Promise.reject(err));
    }
  },

  /**
   * GitLab's commits API writes every file in one commit and creates the branch on an empty
   * project. Its parents say whether the project was still empty when it landed: one written on
   * top of commits someone pushed in between is reported, since nothing undoes it without force.
   */
  async writeScaffold(http, target, files, author, title) {
    const commit = await http.request<{ id: string; parent_ids?: string[] }>("POST", `/projects/${target.apiId}/repository/commits`, {
      branch: "main",
      commit_message: title,
      author_name: author.name,
      author_email: author.email,
      actions: Object.entries(files).map(([path, content]) => ({ action: "create", file_path: path, content })),
    });
    if (commit.parent_ids?.length) throw new SetupRefused(`someone pushed to ${target.fullName} while it was being set up, so the scaffold landed on top of their commits; review it there`, 409);
  },

  webhook(target, url, secret) {
    return { path: `/projects/${target.apiId}/hooks`, body: { url, token: secret, push_events: true, merge_requests_events: true, enable_ssl_verification: true } };
  },
};
