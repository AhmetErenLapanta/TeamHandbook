import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SetupRefused } from "./admin.js";
import { GITEA_ADMIN } from "./gitea-admin.js";
import { giteaAuth } from "./gitea.js";
import { forgeHttp } from "./http.js";

const TOKEN = "gitea-stand-in-token-0123456789abcdef";
const ACCOUNT = { account: "ada", organization: false, webUrl: "http://127.0.0.1", manageUrl: null };

type Answer = { status: number; body: unknown };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

/** A Gitea API that records each call and answers from `route`; anything unrouted is a 404. */
async function fakeGitea(route: (method: string, path: string, body: unknown) => Answer | undefined) {
  const calls: { method: string; path: string; body: unknown; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url!.replace(/^\/api\/v1/, "");
      calls.push({ method: req.method!, path, body, authorization: req.headers.authorization });
      const answer = route(req.method!, path, body) ?? { status: 404, body: { message: "Not Found" } };
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  return { calls, http: forgeHttp("Gitea", apiUrl, TOKEN, giteaAuth(TOKEN), fetch) };
}

describe("a team repository's administration on Gitea", () => {
  it("given the token's account reaches two repositories, when they are listed, then each comes with its clone address and whether it is empty, asked with the token", async () => {
    const { calls, http } = await fakeGitea((method, path) =>
      method === "GET" && path === "/user/repos?limit=100"
        ? { status: 200, body: [{ full_name: "acme/skills", clone_url: "https://gitea.example.invalid/acme/skills.git", empty: true }, { full_name: "acme/app", clone_url: "https://gitea.example.invalid/acme/app.git", empty: false }] }
        : undefined,
    );

    const listed = await GITEA_ADMIN.list(http);

    expect(listed).toEqual([
      { fullName: "acme/skills", url: "https://gitea.example.invalid/acme/skills.git", empty: true },
      { fullName: "acme/app", url: "https://gitea.example.invalid/acme/app.git", empty: false },
    ]);
    expect(calls[0]!.authorization).toBe(`token ${TOKEN}`);
  });

  it("given a repository with only a tag, when it is picked as an empty target, then it is refused as not empty", async () => {
    const { http } = await fakeGitea((method, path) => {
      if (path === "/repos/acme/skills/branches?limit=1") return { status: 200, body: [] };
      if (path === "/repos/acme/skills/tags?limit=1") return { status: 200, body: [{ name: "v1" }] };
      return undefined;
    });

    await expect(GITEA_ADMIN.emptyTarget(http, "acme/skills", "https://gitea.example.invalid/acme/skills.git")).rejects.toMatchObject({ status: 409 });
  });

  it("given an organization named, when a repository is created, then it is made there as private with nothing in it, and without one in the token's own account", async () => {
    const { calls, http } = await fakeGitea((method, path, body) =>
      method === "POST" && (path === "/orgs/acme/repos" || path === "/user/repos")
        ? { status: 201, body: { full_name: `${path === "/user/repos" ? "ada" : "acme"}/${(body as { name: string }).name}`, clone_url: "https://gitea.example.invalid/x.git" } }
        : undefined,
    );

    const inOrg = await GITEA_ADMIN.create(http, { name: "skills", visibility: "private", namespace: "acme" }, ACCOUNT);
    const own = await GITEA_ADMIN.create(http, { name: "notes", visibility: "public" }, ACCOUNT);

    expect(inOrg).toMatchObject({ fullName: "acme/skills", apiId: "acme/skills", created: true });
    expect(own).toMatchObject({ fullName: "ada/notes", created: true });
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      ["/orgs/acme/repos", { name: "skills", private: true, auto_init: false }],
      ["/user/repos", { name: "notes", private: false, auto_init: false }],
    ]);
  });

  it("given the name is taken, when a repository is created, then the person is told to pick it or choose another name", async () => {
    const { http } = await fakeGitea(() => ({ status: 409, body: { message: "The repository with the same name already exists." } }));

    const made = GITEA_ADMIN.create(http, { name: "skills", visibility: "private" }, ACCOUNT);

    await expect(made).rejects.toBeInstanceOf(SetupRefused);
    await expect(made).rejects.toThrow(/already there/);
  });

  it("given an empty repository, when the scaffold is written, then every file goes in one commit on the default branch; a commit pushed in between is reported", async () => {
    let parents: unknown[] = [];
    const { calls, http } = await fakeGitea((method, path) => {
      if (method === "GET" && path === "/repos/acme/skills") return { status: 200, body: { default_branch: "main" } };
      if (method === "POST" && path === "/repos/acme/skills/contents") return { status: 201, body: { commit: { sha: "c".repeat(40), parents } } };
      return undefined;
    });
    const target = { fullName: "acme/skills", url: "https://gitea.example.invalid/acme/skills.git", apiId: "acme/skills", created: true };
    const author = { name: "Ada", email: "ada@example.invalid" };

    await GITEA_ADMIN.writeScaffold(http, target, { "README.md": "# Skills\n", ".claude-plugin/plugin.json": "{}" }, author, "Set up the team handbook");
    parents = [{ sha: "d".repeat(40) }];
    const raced = GITEA_ADMIN.writeScaffold(http, target, { "README.md": "# Skills\n" }, author, "Set up the team handbook");

    expect(calls[1]!.body).toEqual({
      message: "Set up the team handbook",
      branch: "main",
      author,
      files: [
        { operation: "create", path: "README.md", content: Buffer.from("# Skills\n").toString("base64") },
        { operation: "create", path: ".claude-plugin/plugin.json", content: Buffer.from("{}").toString("base64") },
      ],
    });
    await expect(raced).rejects.toThrow(/landed on top of their commits/);
  });

  it("given a target, when its webhook is described, then it is a Gitea hook for pushes, pull requests and their new commits, signed with the secret", () => {
    const hook = GITEA_ADMIN.webhook({ fullName: "acme/skills", url: "", apiId: "acme/skills", created: true }, "https://orchestrator.example.invalid/hooks/x", "s3cret");

    expect(hook).toEqual({ path: "/repos/acme/skills/hooks", body: { type: "gitea", active: true, events: ["push", "pull_request", "pull_request_sync"], config: { url: "https://orchestrator.example.invalid/hooks/x", content_type: "json", secret: "s3cret" } } });
  });
});
